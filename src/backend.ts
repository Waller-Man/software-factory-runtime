import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolDefinition, ToolRunContext, ToolDispatchExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools';
import { validateJsonSchemaValue, type JsonSchemaNode } from '@deepseek-ai/dsh-tools';
import { ToolCallId, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { ExecutionContext } from '@software-factory/runtime-sdk';
import type { RunRecord, RunSummary, RunEvent, RunRequest, RunJson, RunObject, RunResult, BusinessResult, ToolContract, ListRunsRequest, ModelRef, ModelRequest, Artifact, ArtifactInput, WaitRunRequest, RunUpdate } from '@software-factory/contracts/runtime';
import { RunError, ensure, failure, requests, progress, issue, artifact, businessResult } from './validation.ts';
import { createRunDirectory, loadHistory, saveJson, taskFile, taskDirectory } from './files.ts';
import { callModel } from './models.ts';

export interface RuntimeConfig { defaultTimeoutMs?: number; modelTimeoutMs?: number }
interface LiveRun {
  record: RunRecord; events: RunEvent[]; directory: string; workspace: string;
  controller: AbortController; write: Promise<void>; notify: Set<() => void>;
  cleanups: Array<() => void | Promise<void>>; operations: Set<Promise<unknown>>;
  agent?: Agent; tool?: ToolDefinition; callId?: string; token?: ToolExecutionToken;
  stop?: 'cancelled' | 'failed' | 'interrupted'; closing?: boolean; fault?: unknown; cleanup?: Promise<void>;
}
const terminal = (status: string) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();

/** Private implementation; only the facade and validated SDK execution can reach it. */
export class RunBackend {
  private entries = new Map<string, ToolDefinition>();
  private runs = new Map<string, LiveRun>();
  private loaded = new Map<string, Promise<void>>();
  private jobs = new Set<Promise<void>>();
  private active = true;
  constructor(private ctx: Context, private config: RuntimeConfig) {
    ctx.on('tools/execute', async (exec, next) => {
      const run = [...this.runs.values()].find(r => r.callId === exec.callId);
      if (!run) return next();
      ensure(run.agent === exec.agent && run.tool === ctx.tools.get(exec.name, exec.agent), 'RUN_CONTEXT_INVALID', '任务执行入口或作用域不匹配');
      run.token = exec.token;
      try { return await next(); } finally { run.token = undefined; }
    });
    ctx.on('agent/disposed', ({ agent }) => { for (const run of this.runs.values()) if (run.agent === agent && !terminal(run.record.status)) this.stop(run, 'interrupted', '发起会话已释放'); });
  }
  registerEntry(tool: ToolDefinition): () => void {
    ensure(this.active && !this.entries.has(tool.name), 'TOOL_CONFLICT', '入口已登记或Runtime不可用');
    this.entries.set(tool.name, tool);
    return () => {
      if (this.entries.get(tool.name) !== tool) return;
      this.entries.delete(tool.name);
      for (const run of this.runs.values()) if (run.tool === tool && !terminal(run.record.status)) this.stop(run, 'interrupted', '业务插件已停用');
    };
  }
  private async caller(agent: Agent): Promise<string> {
    ensure(this.active && agent && this.ctx.agents.get(agent.id) === agent, 'UNAUTHORIZED', '需要真实有效的DSH会话');
    agent.ctx.fiber.assertActive();
    ensure(agent.session.header.cwd, 'WORKSPACE_REQUIRED', '发起会话没有真实工作区');
    const workspace = await realpath(agent.session.header.cwd);
    ensure((await lstat(workspace)).isDirectory(), 'WORKSPACE_REQUIRED', '工作区不可用');
    let loading = this.loaded.get(workspace);
    if (!loading) {
      loading = (async () => {
        for (const stored of await loadHistory(workspace)) {
          if (this.runs.has(stored.record.runId)) continue;
          const run: LiveRun = { ...stored, workspace, controller: new AbortController(), write: Promise.resolve(), notify: new Set(), cleanups: [], operations: new Set() };
          this.runs.set(stored.record.runId, run);
          if (!terminal(run.record.status)) await this.emit(run, 'status', { status: 'interrupted', message: '服务重启，任务未自动重跑' }, r => { r.status = 'interrupted'; r.message = '服务重启，任务未自动重跑'; r.finishedAt = now(); });
        }
      })();
      this.loaded.set(workspace, loading);
    }
    await loading;
    return workspace;
  }
  private entry(agent: Agent, toolId: string): ToolDefinition {
    const tool = this.entries.get(toolId);
    ensure(tool && this.ctx.tools.get(toolId, agent) === tool, 'PROTOCOL_UNSUPPORTED', 'Tool未接入Run协议、不可见或已卸载');
    return tool;
  }
  async contract(agent: Agent, toolId: string): Promise<ToolContract> {
    await this.caller(agent); const tool = this.entry(agent, toolId);
    return plain({ toolId, description: tool.description, inputSchema: tool.parameters as RunObject, supportsRun: true });
  }
  async start(agent: Agent, input: RunRequest, parent?: ToolExecutionToken): Promise<{ runId: string; status: 'queued' }> {
    const request = requests.run.parse(input) as RunRequest;
    ensure(Buffer.byteLength(JSON.stringify(request)) <= 256 * 1024, 'INVALID_INPUT', '任务输入超过256KiB');
    const workspace = await this.caller(agent), tool = this.entry(agent, request.toolId);
    const errors = validateJsonSchemaValue(tool.parameters as JsonSchemaNode, request.input, 'input');
    ensure(!errors.length, 'INPUT_VALIDATION_FAILED', errors.join('; '));
    const selected = request.model ?? this.inheritModel(agent);
    if (request.model) await this.verifyModel(request.model);
    const runId = randomUUID(), directory = await createRunDirectory(workspace, runId, request);
    const run: LiveRun = {
      record: { apiVersion: '1.0', runId, toolId: request.toolId, status: 'queued', createdAt: now(), ...(selected ? { model: { ...selected } } : {}), logs: [], issues: [], artifacts: [], lastSeq: 0 },
      events: [], directory, workspace, controller: new AbortController(), write: Promise.resolve(), notify: new Set(), cleanups: [], operations: new Set(), agent, tool, callId: 'sf-run-' + randomUUID(),
    };
    await this.emit(run, 'status', { status: 'queued' });
    this.runs.set(runId, run);
    const job = this.perform(run, request, parent).catch(async error => {
      // This is the supervisor of last resort: every background rejection is observed.
      this.ctx.logger.warn('Run任务异常: ' + failure(error).code);
      if (!terminal(run.record.status)) await this.emit(run, 'status', { status: 'failed', message: '任务记录或执行失败' }, r => { r.status = 'failed'; r.message = '任务记录或执行失败'; r.finishedAt = now(); }).catch(() => {});
    });
    this.jobs.add(job); void job.then(() => this.jobs.delete(job));
    return { runId, status: 'queued' };
  }
  private inheritModel(agent: Agent): ModelRef | undefined {
    const config = agent.session.requestHeader()?.config ?? agent.options;
    return config.provider && config.model ? { provider: config.provider, model: config.model, ...(config.reasoningEffort ? { reasoningEffort: String(config.reasoningEffort) } : {}) } : undefined;
  }
  private async verifyModel(model: ModelRef) {
    const llm = this.ctx.get('llm'); ensure(llm, 'MODEL_UNAVAILABLE', 'DSH模型服务未启用');
    ensure((await llm.listModels(model.provider)).some(m => m.id === model.model), 'MODEL_UNAVAILABLE', '指定模型不在DSH目录中');
    await llm.prepareCall({ provider: model.provider, model: model.model, ...(model.reasoningEffort ? { reasoningEffort: ReasoningEffortId(model.reasoningEffort) } : {}) }); // Metadata only.
  }
  private async perform(run: LiveRun, request: RunRequest, parent?: ToolExecutionToken) {
    const timer = setTimeout(() => this.stop(run, 'failed', '任务超时', 'RUN_TIMEOUT'), request.timeoutMs ?? this.config.defaultTimeoutMs ?? 1800000);
    try {
      await this.emit(run, 'status', { status: 'running' }, r => { r.status = 'running'; r.startedAt = now(); });
      run.controller.signal.throwIfAborted();
      ensure(this.entry(run.agent!, request.toolId) === run.tool, 'TOOL_UNAVAILABLE', '业务入口已改变');
      const result = await this.ctx.tools.execute({ callId: ToolCallId(run.callId!), name: request.toolId, arguments: request.input, agent: run.agent, ...(parent ? { parent } : {}), signal: run.controller.signal });
      if (result.isError) throw new RunError(result.error.info?.code ?? 'HOST_TOOL_FAILED', result.error.message);
      const output = businessResult.parse(result.value) as BusinessResult;
      run.closing = true;
      await Promise.allSettled([...run.operations]);
      if (run.fault) throw run.fault;
      run.controller.signal.throwIfAborted();
      const files: Artifact[] = [];
      for (const id of output.files ?? []) {
        const file = run.record.artifacts.find(f => f.artifactId === id && f.kind === 'final');
        ensure(file && !files.some(f => f.artifactId === id), 'RESULT_INVALID', '最终结果包含未登记、重复或不属于本任务的文件');
        await taskFile(run.directory, file.relativePath); files.push(file);
      }
      const final: RunResult = { ...(output.text !== undefined ? { text: output.text } : {}), files };
      await this.cleanup(run);
      run.controller.signal.throwIfAborted();
      await this.emit(run, 'result', final as unknown as RunJson, r => { r.result = final; r.status = 'completed'; r.finishedAt = now(); });
    } catch (error) {
      run.closing = true;
      if (!run.controller.signal.aborted) run.controller.abort(error);
      await Promise.allSettled([...run.operations]);
      let cleanupError: unknown;
      try { await this.cleanup(run); } catch (e) { cleanupError = e; }
      const status = cleanupError ? 'failed' : run.stop ?? 'failed';
      const reason = failure(cleanupError ?? error);
      await this.emit(run, 'issue', { level: 'error', code: cleanupError ? 'CLEANUP_FAILED' : reason.code, message: reason.message, stage: run.record.stage ?? '', fatal: true }, r => {
        r.issues.push({ level: 'error', ...(run.record.stage ? { stage: run.record.stage } : {}), code: cleanupError ? 'CLEANUP_FAILED' : reason.code, message: reason.message, fatal: true, time: now() });
      });
      await this.emit(run, 'status', { status, message: reason.message }, r => { r.status = status; r.message = reason.message; r.finishedAt = now(); });
    } finally { clearTimeout(timer); run.closing = true; }
  }
  private cleanup(run: LiveRun): Promise<void> {
    if (run.cleanup) return run.cleanup;
    const callbacks = run.cleanups.splice(0).reverse();
    run.cleanup = (async () => {
      const outcomes = await Promise.allSettled(callbacks.map(fn => Promise.resolve().then(fn)));
      if (outcomes.some(o => o.status === 'rejected')) throw new RunError('CLEANUP_FAILED', '业务资源清理失败，请检查任务日志');
    })();
    return run.cleanup;
  }
  private stop(run: LiveRun, status: 'failed' | 'cancelled' | 'interrupted', message: string, code?: string) {
    if (terminal(run.record.status) || run.stop) return;
    run.stop = status; run.controller.abort(new RunError(code ?? (status === 'failed' ? 'BUSINESS_FAILED' : status.toUpperCase()), message));
    void this.emit(run, 'status', { status: 'cancelling', message }, r => { r.status = 'cancelling'; r.message = message; }).catch(error => { run.fault = error; });
    // Cleanup may be what releases a waiting external process. Start it now, not after Tool returns.
    const cleaning = this.cleanup(run); this.track(run, cleaning, true);
  }
  executionFor(exec: ToolRunContext, tool: ToolDefinition): ExecutionContext {
    const run = [...this.runs.values()].find(r => r.token === exec.token && r.callId === exec.callId);
    ensure(run && run.tool === tool && run.agent === exec.agent && !run.closing, 'RUNTIME_CONTEXT_REQUIRED', '请通过Run启动该业务Tool');
    const signal = AbortSignal.any([exec.signal, run.controller.signal]);
    const use = <T>(fn: () => Promise<T>, fatal = true): Promise<T> => {
      ensure(!run.closing && !terminal(run.record.status), 'RUN_CLOSED', '任务已结束'); signal.throwIfAborted();
      return this.track(run, Promise.resolve().then(fn), fatal);
    };
    return Object.freeze({
      runId: run.record.runId, outputDirectory: run.directory, signal,
      reportStatus: (status: 'running' | 'completed' | 'failed' | 'cancelled', message?: string) => use(async () => {
        ensure(['running', 'completed', 'failed', 'cancelled'].includes(status), 'INVALID_INPUT', '不支持的任务状态');
        if (status === 'failed' || status === 'cancelled') { this.stop(run, status, message ?? status); await run.write; }
        else await this.emit(run, 'status', { status: 'running', ...(message ? { message } : {}) }, r => { if (message) r.message = message; });
      }),
      reportProgress: (input: Parameters<ExecutionContext['reportProgress']>[0]) => use(async () => {
        const data = progress.parse(input);
        await this.emit(run, 'progress', data as unknown as RunJson, r => {
          r.stage = data.stage; r.stageName = data.stageName;
          if (data.progress === undefined) delete r.progress; else r.progress = data.progress;
          if (data.message !== undefined) r.message = data.message;
        });
      }),
      log: (message: string, stage?: string) => use(async () => {
        ensure(typeof message === 'string' && message.length <= 16384, 'INVALID_INPUT', '日志消息过长');
        const data = { message, ...(stage ? { stage } : {}), time: now() };
        await this.emit(run, 'log', data, r => { r.logs.push(data); });
      }),
      reportIssue: (input: Parameters<ExecutionContext['reportIssue']>[0]) => use(async () => {
        const data = { ...issue.parse(input), time: now() };
        await this.emit(run, 'issue', data, r => { r.issues.push(data); });
        if (data.fatal) this.stop(run, 'failed', data.message);
      }),
      addArtifact: (input: ArtifactInput) => use(() => this.addArtifact(run, input)),
      registerCleanup: (callback: () => void | Promise<void>) => { ensure(!run.closing && !signal.aborted && typeof callback === 'function', 'RUN_CLOSED', '任务已停止，不能再登记资源'); run.cleanups.push(callback); },
      model: Object.freeze({ ...(run.record.model ? { selection: Object.freeze({ ...run.record.model }) } : {}), call: (input: ModelRequest) => use(async () => {
        const modelSignal = AbortSignal.any([signal, AbortSignal.timeout(this.config.modelTimeoutMs ?? 120000)]);
        try { return await callModel(this.ctx, run.record.model, input, run.directory, run.workspace, modelSignal); }
        catch (error) {
          const problem = failure(error);
          await this.emit(run, 'issue', { level: 'error', ...problem }, r => { r.issues.push({ level: 'error', ...problem, ...(r.stage ? { stage: r.stage } : {}), time: now() }); });
          throw error;
        }
      }, false) }),
    });
  }
  private track<T>(run: LiveRun, promise: Promise<T>, fatal: boolean): Promise<T> {
    run.operations.add(promise);
    void promise.then(() => run.operations.delete(promise), error => { run.operations.delete(promise); if (fatal) { run.fault = error; run.controller.abort(error); } });
    return promise;
  }
  private async addArtifact(run: LiveRun, input: ArtifactInput) {
    const data = artifact.parse(input);
    ensure(data.kind === 'final' ? data.relativePath.startsWith('final/') : /^(intermediate|snapshots)\//.test(data.relativePath), 'INVALID_PATH', '产物必须位于对应的任务目录');
    const path = await taskFile(run.directory, data.relativePath), info = await lstat(path);
    ensure(info.size <= 256 * 1024 * 1024, 'ARTIFACT_TOO_LARGE', '文件超过256MiB');
    const previous = run.record.artifacts.find(f => f.relativePath === data.relativePath);
    if (previous) return plain(previous);
    const record: Artifact = { ...data, artifactId: randomUUID(), size: info.size };
    await this.emit(run, 'artifact', record as unknown as RunJson, r => { r.artifacts.push(record); }); return plain(record);
  }
  private emit(run: LiveRun, type: RunEvent['type'], data: RunJson, change?: (record: RunRecord) => void): Promise<void> {
    const operation = run.write.then(async () => {
      const record = plain(run.record); change?.(record);
      const event: RunEvent = { runId: record.runId, seq: record.lastSeq + 1, type, data: plain(data), time: now() };
      record.lastSeq = event.seq;
      const events = [...run.events, event];
      await saveJson(join(run.directory, 'run.json'), { record, events });
      if (type === 'result') run.controller.signal.throwIfAborted();
      run.record = record; run.events = events;
      for (const listener of [...run.notify]) listener();
    });
    run.write = operation.catch(error => { run.fault = error; run.controller.abort(error); });
    return operation;
  }
  private async find(agent: Agent, runId: string) {
    requests.id.parse({ runId }); const workspace = await this.caller(agent), run = this.runs.get(runId);
    ensure(run && run.workspace === workspace, 'RUN_NOT_FOUND', '任务不存在或不属于当前工作区'); return run;
  }
  private artifactView(agent: Agent, runId: string, file: Artifact): Artifact {
    return { ...file, downloadUrl: '/api/sf-runtime/download?' + new URLSearchParams({ runId, artifactId: file.artifactId, sessionId: agent.id }).toString() };
  }
  private async recordView(agent: Agent, run: LiveRun): Promise<RunRecord> {
    const record = plain(run.record);
    record.artifacts = record.artifacts.map(f => this.artifactView(agent, record.runId, f));
    if (record.result) record.result.files = record.result.files.map(f => this.artifactView(agent, record.runId, f));
    record.intermediateDirectories = [];
    for (const folder of ['intermediate', 'snapshots']) {
      const fileCount = record.artifacts.filter(f => f.kind === 'intermediate' && f.relativePath.startsWith(folder + '/')).length;
      if (fileCount) record.intermediateDirectories.push({ path: await taskDirectory(run.workspace, `outputs/runs/${record.runId}/${folder}`), fileCount });
    }
    return record;
  }
  async get(agent: Agent, runId: string) { return this.recordView(agent, await this.find(agent, runId)); }
  async list(agent: Agent, input: ListRunsRequest) {
    const filters = requests.list.parse(input), workspace = await this.caller(agent);
    const rows = [...this.runs.values()].filter(r => r.workspace === workspace && (!filters.toolId || r.record.toolId === filters.toolId) && (!filters.status || r.record.status === filters.status)).sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt));
    return { items: rows.slice(filters.offset ?? 0, (filters.offset ?? 0) + (filters.limit ?? 20)).map(r => this.summary(r)), total: rows.length };
  }
  private summary(run: LiveRun): RunSummary {
    const { runId, toolId, status, stage, stageName, progress, message, createdAt, startedAt, finishedAt } = run.record;
    return plain({ runId, toolId, status, stage, stageName, progress, message, createdAt, startedAt, finishedAt });
  }
  async cancel(agent: Agent, runId: string) { const run = await this.find(agent, runId); this.stop(run, 'cancelled', '用户取消任务'); await run.write; return { runId, status: run.record.status }; }
  async wait(agent: Agent, input: WaitRunRequest, signal?: AbortSignal): Promise<RunUpdate> {
    const request = requests.wait.parse(input), run = await this.find(agent, request.runId), after = request.afterSeq ?? run.record.lastSeq;
    ensure(after <= run.record.lastSeq, 'INVALID_CURSOR', '事件序号超出当前任务'); signal?.throwIfAborted();
    if (after === run.record.lastSeq && !terminal(run.record.status)) await new Promise<void>((resolve, reject) => {
      const done = () => { clearTimeout(timer); run.notify.delete(done); signal?.removeEventListener('abort', abort); resolve(); };
      const abort = () => { done(); reject(signal?.reason); };
      const timer = setTimeout(done, request.waitMs ?? 15000);
      run.notify.add(done); signal?.addEventListener('abort', abort, { once: true });
    });
    const events = plain(run.events.filter(e => e.seq > after));
    for (const event of events) {
      if (event.type === 'artifact') event.data = this.artifactView(agent, run.record.runId, event.data as unknown as Artifact) as unknown as RunJson;
      if (event.type === 'result' && run.record.result) event.data = { ...run.record.result, files: run.record.result.files.map(f => this.artifactView(agent, run.record.runId, f)) } as unknown as RunJson;
    }
    return { run: this.summary(run), events, lastSeq: run.record.lastSeq };
  }
  async *watch(agent: Agent, runId: string, afterSeq = 0, signal?: AbortSignal): AsyncGenerator<RunEvent> {
    let after = afterSeq;
    while (true) {
      const update = await this.wait(agent, { runId, afterSeq: after, waitMs: 30000 }, signal);
      for (const event of update.events) yield event;
      after = update.lastSeq;
      if (terminal(update.run.status)) return;
    }
  }
  async getArtifact(agent: Agent, runId: string, artifactId: string) {
    requests.artifact.parse({ runId, artifactId }); const run = await this.find(agent, runId);
    const file = run.record.artifacts.find(f => f.artifactId === artifactId); ensure(file, 'ARTIFACT_NOT_FOUND', '文件未登记');
    await taskFile(run.directory, file.relativePath); return this.artifactView(agent, runId, file);
  }
  async download(agent: Agent, runId: string, artifactId: string) {
    const run = await this.find(agent, runId), file = await this.getArtifact(agent, runId, artifactId);
    return { file, bytes: await readFile(await taskFile(run.directory, file.relativePath)) };
  }
  async dispose() {
    for (const run of this.runs.values()) if (!terminal(run.record.status)) this.stop(run, 'interrupted', 'Runtime已停用');
    await Promise.allSettled([...this.jobs]); await Promise.allSettled([...this.runs.values()].map(r => r.write));
    this.active = false; this.entries.clear();
  }
}
