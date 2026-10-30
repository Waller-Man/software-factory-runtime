import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-client-connection';
import type { ZodType } from 'zod';
import type { Artifact, ArtifactRequest, CancelResult, ListRunsRequest, RunAccepted, RunEvent, RunIdRequest, RunList, RunRecord, RunRequest, RunUpdate, RuntimeResult, ToolContract, ToolContractRequest, WaitRunRequest, WatchRunRequest } from '@software-factory/contracts/runtime';
import type { ExecutionContext } from '@software-factory/runtime-sdk';
import { RunBackend, type RuntimeConfig } from './backend.ts';
import { ensure, failure, requests } from './validation.ts';
import type { RuntimeSession } from './scope.ts';
export type { RuntimeSession, RuntimeSessionId } from './scope.ts';
export type * from '@software-factory/contracts/runtime';
export type { RuntimeConfig } from './backend.ts';

const owners = new WeakMap<object, RunBackend>();
const schemas = {
  id: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'], additionalProperties: false },
  artifact: { type: 'object', properties: { runId: { type: 'string' }, artifactId: { type: 'string' } }, required: ['runId', 'artifactId'], additionalProperties: false },
  contract: { type: 'object', properties: { toolId: { type: 'string' } }, required: ['toolId'], additionalProperties: false },
  run: { type: 'object', properties: { toolId: { type: 'string' }, input: { type: 'object', additionalProperties: true }, model: { type: 'object', properties: { provider: { type: 'string' }, model: { type: 'string' }, reasoningEffort: { type: 'string' } }, required: ['provider', 'model'], additionalProperties: false }, timeoutMs: { type: 'integer' } }, required: ['toolId', 'input'], additionalProperties: false },
  list: { type: 'object', properties: { toolId: { type: 'string' }, status: { type: 'string' }, limit: { type: 'integer' }, offset: { type: 'integer' } }, additionalProperties: false },
  wait: { type: 'object', properties: { runId: { type: 'string' }, afterSeq: { type: 'integer' }, waitMs: { type: 'integer' } }, required: ['runId'], additionalProperties: false },
} as const;

/** Backend only: service, seven model Tools, eight Remote methods and authenticated download. */
export class RuntimeApi extends TypertRemoteService {
  static inject = ['tools', 'agents', 'typert'];
  static Config: z<RuntimeConfig> = z.object({
    defaultTimeoutMs: z.number().step(1).min(1000).max(7200000).default(1800000),
    modelTimeoutMs: z.number().step(1).min(1000).max(7200000).default(120000),
  });
  private owner = {};
  constructor(ctx: Context, private config: RuntimeConfig) { super(ctx, 'sfRuntime'); }
  private backend(): RunBackend { const backend = owners.get(this.owner); ensure(backend, 'SERVICE_UNAVAILABLE', 'Runtime未就绪'); return backend; }
  protected async *[Service.init](): AsyncGenerator<() => Promise<void>> {
    const backend = new RunBackend(this.ctx, this.config); owners.set(this.owner, backend);
    const removeScope = this.ctx.typert.lookups.register('runtimeSession', {
      parameter: 'runtimeSession', wire: 'runtimeSessionId',
      hostTypeSymbol: '@software-factory/runtime/types#RuntimeSession',
      wireTypeSymbol: '@software-factory/runtime/types#RuntimeSessionId',
      resolve: (id) => { const agent = this.ctx.agents.get(SessionId(id)); return agent ? { agent } : undefined; },
    });
    const definitions: Array<[string, string, object, ZodType, (agent: Agent, request: any, exec: ToolRunContext) => Promise<unknown>]> = [
      ['get_tool_contract', 'Get the real input contract for an SDK business Tool.', schemas.contract, requests.contract, (a, r) => backend.contract(a, r.toolId)],
      ['run_tool', 'Start a registered software factory business Tool. model is optional. Returns runId promptly.', schemas.run, requests.run, (a, r, exec) => backend.start(a, r, exec.token)],
      ['get_run', 'Read task progress, issues, artifacts and final result.', schemas.id, requests.id, (a, r) => backend.get(a, r.runId)],
      ['list_runs', 'List tasks in the caller workspace.', schemas.list, requests.list, (a, r) => backend.list(a, r)],
      ['wait_run', 'Wait up to 30 seconds for new task reports or completion. This does not pause the task.', schemas.wait, requests.wait, (a, r, exec) => backend.wait(a, r, exec.signal)],
      ['cancel_run', 'Cancel a task and propagate cancellation to its SDK. No pause or resume.', schemas.id, requests.id, (a, r) => backend.cancel(a, r.runId)],
      ['get_artifact', 'Get registered artifact metadata and an authenticated download reference.', schemas.artifact, requests.artifact, (a, r) => backend.getArtifact(a, r.runId, r.artifactId)],
    ];
    const removeTools = definitions.map(([name, description, parameters, schema, fn]) => this.ctx.tools.register({
      name: 'sf_runtime_' + name, description, parameters: parameters as Record<string, unknown>,
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (input, exec) => {
        try {
          ensure(exec.agent, 'UNAUTHORIZED', '需要真实DSH会话，不接受调用者身份参数');
          return JSON.parse(JSON.stringify({ ok: true, data: await fn(exec.agent, schema.parse(input), exec) }));
        } catch (error) { return { ok: false, error: failure(error) }; }
      },
    }));
    const download = this.ctx.inject(['connection'], scope => {
      scope.effect(() => scope.connection.fetch.register({ path: '/api/sf-runtime/download', methods: ['GET'], requestBody: 'buffered', fetch: async request => {
        try {
          ensure('peer' in scope.connection.admit(request), 'UNAUTHORIZED', '需要DSH认证');
          const query = new URL(request.url).searchParams;
          const agent = this.ctx.agents.get(SessionId(query.get('sessionId') ?? ''));
          ensure(agent, 'UNAUTHORIZED', '发起会话不存在');
          const parsed = requests.artifact.parse({ runId: query.get('runId'), artifactId: query.get('artifactId') });
          const { file, bytes } = await backend.download(agent, parsed.runId, parsed.artifactId);
          return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': file.mime, 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.name), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } });
        } catch (error) { return Response.json({ ok: false, error: failure(error) }, { status: 403 }); }
      } }), 'sf-runtime: authenticated download');
    });
    yield async () => { for (const remove of removeTools) remove(); await backend.dispose(); await download.dispose(); removeScope(); owners.delete(this.owner); };
  }
  registerEntry(tool: ToolDefinition) { return this.backend().registerEntry(tool); }
  executionFor(exec: ToolRunContext, tool: ToolDefinition): ExecutionContext { return this.backend().executionFor(exec, tool); }
  private async invoke<I, O>(agent: Agent, request: I, schema: ZodType<I>, fn: (request: I) => Promise<O>): Promise<RuntimeResult<O>> {
    try {
      ensure(this.ctx.invocation, 'UNAUTHORIZED', 'Remote需要DSH认证调用上下文');
      const original = this.ctx.invocation.request.args.request ?? request;
      return { ok: true, data: await fn(schema.parse(original)) };
    } catch (error) { return { ok: false, error: failure(error) }; }
  }
  @Remote
  async getToolContract(runtimeSession: RuntimeSession, request: ToolContractRequest, signal?: AbortSignal): Promise<RuntimeResult<ToolContract>> { const agent = runtimeSession.agent; return this.invoke(agent, request, requests.contract, r => this.backend().contract(agent, r.toolId)); }
  @Remote
  async runTool(runtimeSession: RuntimeSession, request: RunRequest, signal?: AbortSignal): Promise<RuntimeResult<RunAccepted>> { const agent = runtimeSession.agent; return this.invoke(agent, request, requests.run, r => this.backend().start(agent, r)); }
  @Remote
  async getRun(runtimeSession: RuntimeSession, request: RunIdRequest, signal?: AbortSignal): Promise<RuntimeResult<RunRecord>> { const agent = runtimeSession.agent; return this.invoke(agent, request, requests.id, r => this.backend().get(agent, r.runId)); }
  @Remote
  async listRuns(runtimeSession: RuntimeSession, request: ListRunsRequest, signal?: AbortSignal): Promise<RuntimeResult<RunList>> { const agent = runtimeSession.agent; return this.invoke(agent, request, requests.list, r => this.backend().list(agent, r)); }
  @Remote
  async waitRun(runtimeSession: RuntimeSession, request: WaitRunRequest, signal?: AbortSignal): Promise<RuntimeResult<RunUpdate>> { const agent = runtimeSession.agent; return this.invoke(agent, request, requests.wait, r => this.backend().wait(agent, r, signal)); }
  @Remote
  async cancelRun(runtimeSession: RuntimeSession, request: RunIdRequest, signal?: AbortSignal): Promise<RuntimeResult<CancelResult>> { const agent = runtimeSession.agent; return this.invoke(agent, request, requests.id, r => this.backend().cancel(agent, r.runId)); }
  @Remote
  async getArtifact(runtimeSession: RuntimeSession, request: ArtifactRequest, signal?: AbortSignal): Promise<RuntimeResult<Artifact>> { const agent = runtimeSession.agent; return this.invoke(agent, request, requests.artifact, r => this.backend().getArtifact(agent, r.runId, r.artifactId)); }
  @Remote({ mode: 'stream' })
  async *watchRun(runtimeSession: RuntimeSession, request: WatchRunRequest, signal?: AbortSignal): AsyncIterable<RuntimeResult<RunEvent>> {
    try {
      ensure(this.ctx.invocation, 'UNAUTHORIZED', '需要DSH认证调用');
      const input = requests.watch.parse(this.ctx.invocation.request.args.request ?? request);
      for await (const event of this.backend().watch(runtimeSession.agent, input.runId, input.afterSeq, signal)) yield { ok: true, data: event };
    } catch (error) { yield { ok: false, error: failure(error) }; }
  }
}
export default RuntimeApi;
