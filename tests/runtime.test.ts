/** Small integration groups: real DSH services, synthetic business/model, no paid inference. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import { createServer } from 'node:http';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { LlmAdapter, ToolCallId, ReasoningEffortId, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import Registry from '@deepseek-ai/dsh-typert-registry';
import ApiGateway from '@deepseek-ai/dsh-api-gateway';
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local';
import { Agent as HttpAgent, MockAgent } from 'undici';
import { userContent } from '../src/images.ts';
import type { ModelRequest } from '../../runtime-sdk/lib/index.js';
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit';
import Runtime from '../lib/index.js';
import { TYPERT } from '../lib/typert.host.js';
import remote from '../lib/typert.remote-client.js';
import { registerRunTool, type ExecutionContext } from '../../runtime-sdk/lib/index.js';
import * as Example from '../../runtime-sdk/examples/echo-plugin.ts';
import { taskDirectory } from '../src/files.ts';
import { resolveConnection, routeForProtocol, prepareBody, connectionKey } from '../src/model-connection.ts';
import { setTimeout as delay } from 'node:timers/promises';
// Unmodified published 0.1.0 registration binary, retained as a compatibility fixture.
import { registerRunTool as registerLegacyTool } from './fixtures/sdk-0.1.0.mjs';

async function fixture(config: Record<string, unknown> = {}) {
  const ctx = new Context();
  const base = resolve('test-results'); await mkdir(base, { recursive: true });
  const workspace = await mkdtemp(join(base, 'runtime-'));
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true });
  const harness = await mountAgentLoopTestHarness(ctx);
  const agent = await harness.create(SessionId('sf-runtime-test-' + randomUUID()), {}, { cwd: workspace });
  await ctx.plugin(Registry); await ctx.plugin(ApiGateway, {});
  const removeDescriptors = ctx.typert.register(TYPERT as never);
  const runtime = await ctx.plugin(Runtime, { defaultTimeoutMs: 10000, ...config });
  async function call(action: string, args: object) {
    const result = await ctx.tools.execute({ callId: ToolCallId(randomUUID()), name: 'sf_runtime_' + action, arguments: args, agent, signal: new AbortController().signal });
    assert.equal(result.isError, false, JSON.stringify(result));
    const value = (result as any).value; assert.equal(value.ok, true, JSON.stringify(value)); return value.data;
  }
  async function rpc(method: string, request: object) {
    const result: any = await ctx.typertGateway.invoke({ namespace: 'sfRuntime', method, args: { runtimeSessionId: agent.id, request } });
    assert.equal(result.ok, true, JSON.stringify(result)); return result.data;
  }
  async function finish(runId: string) {
    let seq = 0;
    for (let round = 0; round < 100; round++) {
      const update = await call('wait_run', { runId, afterSeq: seq, waitMs: 200 }); seq = update.lastSeq;
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(update.run.status)) return call('get_run', { runId });
    }
    throw new Error('Task did not settle');
  }
  async function register(toolId: string, execute: (input: any, execution: ExecutionContext) => Promise<any>, modelProtocols?: any) {
    return ctx.plugin({ name: toolId, inject: ['tools', 'sfRuntime'], apply(scope: Context) { registerRunTool(scope, { toolId, description: 'synthetic_test', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, execute, ...(modelProtocols ? { modelProtocols } : {}) }); } });
  }
  return { ctx, agent, workspace, runtime, call, rpc, finish, register, async close() { removeDescriptors(); await ctx.fiber.dispose(); } };
}

test('complete run: real Tool chain, Remote, progress, artifacts and reloadable history', async () => {
  const f = await fixture();
  try {
    const example = await f.ctx.plugin(Example);
    assert.equal(remote.descriptors.length, 12);
    const contract = await f.call('get_tool_contract', { toolId: 'sf_example_echo' });
    assert.equal(contract.inputSchema.required[0], 'text');
    const direct = await f.ctx.tools.execute({ callId: ToolCallId(randomUUID()), name: 'sf_example_echo', arguments: { text: 'direct' }, agent: f.agent, signal: new AbortController().signal });
    assert.equal(direct.isError, true, 'SDK Tool must require an authentic Run context');
    const accepted = await f.rpc('runTool', { toolId: 'sf_example_echo', input: { text: 'hello SDK' } });
    assert.equal(accepted.status, 'queued');
    const run = await f.finish(accepted.runId);
    assert.equal(run.status, 'completed'); assert.equal(run.result.text, 'hello SDK');
    assert.equal(run.progress, 100); assert.equal(run.artifacts.length, 2); assert.ok(run.logs.length);
    assert.deepEqual(run.intermediateDirectories, [{ path: join(f.workspace, 'outputs/runs', run.runId, 'intermediate'), fileCount: 1 }]);
    await assert.rejects(taskDirectory(f.workspace, '../outside'), /相对目录/);
    assert.match(run.result.files[0].downloadUrl, /^\/api\/sf-runtime\/download\?/);
    assert.equal(await readFile(join(f.workspace, 'outputs/runs', run.runId, 'final/result.txt'), 'utf8'), 'hello SDK');
    const material = await f.rpc('getArtifact', { runId: run.runId, artifactId: run.result.files[0].artifactId });
    assert.equal(material.name, 'result.txt');
    const update = await f.call('wait_run', { runId: run.runId, afterSeq: 0 });
    assert.deepEqual(update.events.map((e: any) => e.seq), Array.from({ length: run.lastSeq }, (_, i) => i + 1));
    const stream = await f.ctx.typertGateway.stream({ namespace: 'sfRuntime', method: 'watchRun', args: { runtimeSessionId: f.agent.id, request: { runId: run.runId, afterSeq: 0 } } });
    const received: any[] = []; for await (const event of stream) received.push(event);
    assert.equal(received.length, run.lastSeq); assert.ok(received.every(e => e.ok));
    await example.dispose(); await f.runtime.dispose();
    await f.ctx.plugin(Runtime, {});
    const loaded = await f.rpc('getRun', { runId: run.runId });
    assert.equal(loaded.result.text, 'hello SDK');
    assert.deepEqual(loaded.intermediateDirectories, run.intermediateDirectories);
    assert.equal((await f.call('list_runs', {})).total, 1);
  } finally { await f.close(); }
});

async function interactionUI(f: Awaited<ReturnType<typeof fixture>>) {
  const routes = new Map<string, (request: Request) => Promise<Response>>();
  const peer = { id: 'synthetic-human', ctx: f.ctx, dispose: async () => {} } as any;
  f.ctx.provide('connection', { rpc: { intercept: () => () => {} }, fetch: { register: ({ path, fetch }: any) => { routes.set(path, fetch); return () => routes.delete(path); } }, admit: () => ({ peer }) } as never);
  for (let i = 0; i < 100 && !routes.has('/api/sf-runtime/ui-session'); i++) await delay(5);
  const response = await routes.get('/api/sf-runtime/ui-session')!(new Request('http://localhost/api/sf-runtime/ui-session', {
    method: 'POST', headers: { host: 'localhost', origin: 'http://localhost', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: '{}',
  }));
  const grant: any = await response.json(); assert.equal(grant.ok, true);
  async function answer(runId: string, interactionId: string, value: any, session = f.agent.id, token = grant.data.token, caller = peer) {
    const outer: any = await f.ctx.typertGateway.invoke({ namespace: 'sfRuntime', method: 'answerInteraction', peer: caller,
      args: { runtimeSessionId: session, request: { runId, interactionId, answer: value }, uiToken: token } });
    return outer;
  }
  async function pending(runId: string) {
    for (let i = 0; i < 100; i++) { const run = await f.rpc('getRun', { runId }); if (run.pendingInteraction) return run; await delay(5); }
    throw new Error('No pending question');
  }
  return { answer, pending };
}

test('human interaction: three modes, browser-only answers, source binding and persisted history', async () => {
  const f = await fixture();
  try {
    const ui = await interactionUI(f), answers: any[] = [];
    await f.register('sf_questions', async (_input, execution) => {
      await execution.reportProgress({ stage: 'review', stageName: '需求审核', progress: 45 });
      answers.push(await execution.interaction.ask({ type: 'select', question: '选择方案', options: [{ value: 'a', label: '方案一' }] }));
      answers.push(await execution.interaction.ask({ type: 'text', question: '补充角色' }));
      answers.push(await execution.interaction.ask({ type: 'mixed', question: '语言及要求', options: [{ value: 'zh', label: '中文' }] }));
      return { text: '用户已确认' };
    });
    assert.ok(!f.ctx.tools.schemas(f.agent).some(tool => /answer.*interaction/.test(tool.name)));
    const worker = await f.ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd: f.workspace }, agentOptions: {} });
    const runtime = f.ctx.get('sfRuntime') as unknown as { bindRunSource(execution: any, source: any): Promise<() => void> };
    const unbind = await runtime.bindRunSource(worker.agent, f.agent);
    const start: any = await f.ctx.typertGateway.invoke({ namespace: 'sfRuntime', method: 'runTool', args: { runtimeSessionId: worker.agent.id, request: { toolId: 'sf_questions', input: {} } } });
    assert.equal(start.ok, true); const runId = start.data.runId; unbind();
    let run = await ui.pending(runId), question = run.pendingInteraction.interactionId;
    assert.equal(run.sourceSessionId, f.agent.id); assert.equal(run.executionSessionId, worker.agent.id); assert.equal(run.progress, 45);
    assert.equal((await ui.answer(runId, question, { type: 'select', value: 'a' }, f.agent.id, 'invented')).error.code, 'UNAUTHORIZED');
    assert.equal((await ui.answer(runId, question, { type: 'select', value: 'a' }, worker.agent.id)).error.code, 'UNAUTHORIZED');
    assert.equal((await ui.answer(runId, question, { type: 'select', value: 'missing' })).error.code, 'INTERACTION_INVALID_ANSWER');
    // Original wire values still undergo strict validation after the Remote decoder.
    const invalid: any = await ui.answer(runId, question, { type: 'select', value: 'a', text: 'forbidden' });
    assert.equal(invalid.ok, false);
    assert.equal((await ui.answer(runId, question, { type: 'select', value: 'a' })).ok, true);
    assert.equal((await ui.answer(runId, question, { type: 'select', value: 'a' })).error.code, 'INTERACTION_CLOSED');
    run = await ui.pending(runId); question = run.pendingInteraction.interactionId;
    assert.equal(run.pendingInteraction.request.type, 'text');
    assert.equal((await ui.answer(runId, question, { type: 'text', text: '管理员' })).ok, true);
    run = await ui.pending(runId); question = run.pendingInteraction.interactionId;
    assert.equal((await ui.answer(runId, question, { type: 'mixed', value: 'zh', text: '保留术语' })).ok, true);
    run = await f.finish(runId); assert.equal(run.status, 'completed'); assert.equal(run.pendingInteraction, undefined);
    assert.deepEqual(answers.map(answer => answer.type), ['select', 'text', 'mixed']);
    const history = await f.rpc('listInteractions', { runId }); assert.equal(history.length, 3); assert.ok(history.every((item: any) => item.status === 'answered'));
    assert.equal(JSON.parse(await readFile(join(f.workspace, 'outputs/runs', runId, 'run.json'), 'utf8')).record.interactions[1].answer.text, '管理员');
    await f.runtime.dispose(); await f.ctx.plugin(Runtime, {});
    assert.equal((await f.rpc('listInteractions', { runId }))[2].answer.text, '保留术语');
    await worker.dispose();
  } finally { await f.close(); }
});

test('human waiting preserves execution budget; cancellation and expiration close the question', async () => {
  const f = await fixture({ defaultTimeoutMs: 1000 });
  try {
    const ui = await interactionUI(f);
    await f.register('sf_wait_user', async (_input, execution) => {
      await execution.interaction.ask({ type: 'text', question: '请确认' }); return { text: '继续成功' };
    });
    let started = await f.call('run_tool', { toolId: 'sf_wait_user', input: {} });
    let run = await ui.pending(started.runId);
    assert.equal(Date.parse(run.pendingInteraction.expiresAt) - Date.parse(run.pendingInteraction.createdAt), 86400000);
    await delay(1100);
    assert.equal((await f.rpc('getRun', { runId: started.runId })).status, 'running');
    await ui.answer(started.runId, run.pendingInteraction.interactionId, { type: 'text', text: '继续' });
    assert.equal((await f.finish(started.runId)).status, 'completed');
    started = await f.call('run_tool', { toolId: 'sf_wait_user', input: {} }); run = await ui.pending(started.runId);
    await f.call('cancel_run', { runId: started.runId });
    const cancelled = await f.finish(started.runId); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.interactions[0].status, 'cancelled');
    assert.equal((await ui.answer(started.runId, run.pendingInteraction.interactionId, { type: 'text', text: '迟到回答' })).error.code, 'INTERACTION_CLOSED');
    await f.register('sf_expire_user', async (_input, execution) => {
      await execution.interaction.ask({ type: 'text', question: '会超时', timeoutMs: 20 }); return { text: '不应执行' };
    });
    started = await f.call('run_tool', { toolId: 'sf_expire_user', input: {} }); run = await f.finish(started.runId);
    assert.equal(run.status, 'failed'); assert.equal(run.interactions[0].status, 'expired'); assert.ok(run.issues.some((issue: any) => issue.code === 'INTERACTION_TIMEOUT'));
  } finally { await f.close(); }
});

test('HTTP gateway: three exact protocols, fixed route/effort, streaming, auth, records and lease revocation', async () => {
  const f = await fixture();
  const received: Array<{ path?: string; headers: any; body: any }> = [];
  const waiting = Promise.withResolvers<void>(), upstreamClosed = Promise.withResolvers<void>();
  const key = 'synthetic-provider-secret';
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    received.push({ path: req.url, headers: req.headers, body });
    if (body.synthetic_wait) { res.once('close', () => upstreamClosed.resolve()); waiting.resolve(); return; }
    if (body.synthetic_error) { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'synthetic limit' } })); return; }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"type":"delta","text":"first"}\n\n');
      res.end('data: {"usage":{"output_tokens":2}}\n\ndata: [DONE]\n\n');
    } else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'synthetic-response', usage: { input_tokens: 3, output_tokens: 2 } })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const protocols = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const;
  const profiles = Object.fromEntries(protocols.map(protocol => [protocol, { api: protocol, baseURL: origin + '/v1', compat: { forceAdaptiveThinking: true }, models: [{ id: 'selected', reasoningEfforts: { high: 'high' } }] }]));
  class GatewayModel extends LlmAdapter {
    async listModels(provider: string) { return [{ provider, id: 'selected', name: 'Synthetic gateway model' }]; }
    async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] } }; }
    async *stream(_options: GenerateOptions): AsyncGenerator<any> { assert.fail('HTTP routes must not use the DSH adapter stream'); }
  }
  try {
    f.ctx.provide('settings', { configure: () => () => {}, describe: () => [{ ns: 'test-connections', value: { providers: profiles } }] } as never);
    f.ctx.provide('credentials', { resolve: async () => ({ value: key }), readRecord: async () => ({ kind: 'api-key', key }) } as never);
    await f.ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, compression: 'none' });
    f.ctx.llm.registerAdapter([...protocols], new GatewayModel());
    f.ctx.llm.registerConfigurableProviders(protocols.map(provider => ({ provider, displayName: provider, settingsNs: 'test-connections', settingsPath: ['providers', provider] })));
    for (const protocol of protocols) {
      let connection: any;
      const endpoint = (c: any) => c.baseUrl + (protocol === 'anthropic-messages' ? '/v1/messages' : protocol === 'openai-responses' ? '/responses' : '/chat/completions');
      const headers = (c: any) => ({ 'content-type': 'application/json', ...(protocol === 'anthropic-messages' ? { 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${c.apiKey}` }) });
      await f.register('sf_gateway_' + protocol.replaceAll('-', '_'), async (_input, execution) => {
        connection = await execution.model.getConnection({ protocol });
        assert.equal(connection.model, 'selected'); assert.notEqual(connection.apiKey, key);
        await execution.reportProgress({ stage: 'generate', stageName: '生成', progress: 30 });
        const post = async (body: object, c = connection) => { try { return await fetch(endpoint(c), { method: 'POST', headers: headers(c), body: JSON.stringify({ model: c.model, ...body }) }); } catch (error: any) { throw new Error(`${endpoint(c)}: ${error.message}: ${String(error.cause)}`); } };
        assert.equal((await post({}, { ...connection, apiKey: 'invalid' })).status, 401);
        assert.equal((await post({ model: 'lower-must-not-change-model' })).status, 400);
        assert.equal((await post({ reasoning_effort: 'low' })).status, 400);
        const extra = { messages: [{ role: 'user', content: 'synthetic' }], input: 'synthetic', max_tokens: 20, response_format: { type: 'json_object' }, top_k: 12 };
        const response = await post(extra); assert.equal(response.status, 200); assert.equal((await response.json() as any).id, 'synthetic-response');
        const streamed = await post({ ...extra, stream: true });
        assert.match(streamed.headers.get('content-type')!, /event-stream/);
        const reader = streamed.body!.getReader(); const first = await reader.read(); assert.match(new TextDecoder().decode(first.value), /first/);
        while (!(await reader.read()).done) { /* Drain the forwarded stream. */ }
        const failed = await post({ synthetic_error: true }); assert.equal(failed.status, 429); assert.match(await failed.text(), /synthetic limit/);
        return { text: 'gateway finished' };
      }, [protocol]);
      const toolId = 'sf_gateway_' + protocol.replaceAll('-', '_');
      const model = { provider: protocol, model: 'selected', reasoningEffort: 'high' };
      const contract = await f.call('get_tool_contract', { toolId, model }); assert.deepEqual(contract.modelProtocols, [protocol]);
      const wrong = await f.ctx.tools.execute({ callId: ToolCallId(randomUUID()), name: 'sf_runtime_get_tool_contract', arguments: { toolId, model: { ...model, provider: protocols.find(p => p !== protocol) } }, agent: f.agent, signal: new AbortController().signal });
      assert.equal((wrong as any).value.error.code, 'MODEL_PROTOCOL_UNSUPPORTED');
      const accepted = await f.call('run_tool', { toolId, input: {}, model });
      const run = await f.finish(accepted.runId); assert.equal(run.status, 'completed', JSON.stringify(run.issues));
      assert.equal(run.modelCalls.length, 3); assert.equal(run.modelCalls[2].status, 'failed');
      const summaries = await f.rpc('listModelCalls', { runId: run.runId }); assert.equal(summaries.length, 3);
      const detail = await f.rpc('getModelCall', { runId: run.runId, requestId: summaries[0].requestId });
      assert.equal(detail.stage, 'generate'); assert.equal(detail.request.top_k, 12); assert.deepEqual(detail.request.response_format, { type: 'json_object' });
      const raw = await readFile(join(f.workspace, 'outputs/runs', run.runId, 'logs/model-calls', detail.requestId + '.json'), 'utf8');
      assert.ok(!raw.includes(key)); assert.ok(!raw.includes(connection.apiKey));
      const after = await fetch(endpoint(connection), { method: 'POST', headers: headers(connection), body: JSON.stringify({ model: 'selected' }) }); assert.equal(after.status, 401);
      const records = received.slice(-3); assert.equal(records[0].body.model, 'selected'); assert.equal(records[0].body.top_k, 12);
      if (protocol === 'anthropic-messages') { assert.equal(records[0].headers['x-api-key'], key); assert.equal(records[0].body.thinking.type, 'adaptive'); assert.equal(records[0].body.output_config.effort, 'high'); }
      else { assert.equal(records[0].headers.authorization, `Bearer ${key}`); assert.equal(protocol === 'openai-responses' ? records[0].body.reasoning.effort : records[0].body.reasoning_effort, 'high'); }
      assert.equal(records[0].path, protocol === 'anthropic-messages' ? '/v1/messages' : protocol === 'openai-responses' ? '/v1/responses' : '/v1/chat/completions');
    }
    assert.equal(received.length, 9, 'Rejected requests never reach the upstream');
    let held: any;
    await f.register('sf_gateway_cancel', async (_input, execution) => {
      held = await execution.model.getConnection({ protocol: 'openai-completions' });
      // A DSH edit after selection must not retarget this task's requests.
      profiles['openai-completions'].baseURL = 'http://127.0.0.1:1/v1';
      const response = await fetch(held.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${held.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: held.model, synthetic_wait: true }) });
      await response.text(); return { text: 'must not finish' };
    });
    const heldRun = await f.call('run_tool', { toolId: 'sf_gateway_cancel', input: {}, model: { provider: 'openai-completions', model: 'selected', reasoningEffort: 'high' } });
    await waiting.promise;
    await f.rpc('cancelRun', { runId: heldRun.runId });
    const cancelled = await f.finish(heldRun.runId); assert.equal(cancelled.status, 'cancelled');
    await upstreamClosed.promise;
    const expired = await fetch(held.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${held.apiKey}` }, body: '{}' }); assert.equal(expired.status, 401);
    assert.equal(cancelled.modelCalls[0].status, 'cancelled');
  } finally { await f.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('tool protocols route the selected official DeepSeek connection without using the host default protocol', async () => {
  const f = await fixture();
  const model = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' };
  class Model extends LlmAdapter {
    async listModels(provider: string) { return [{ provider, id: model.model, name: 'Synthetic DeepSeek' }]; }
    async resolveModel(provider: string, id: string) { return { provider, id, name: id, reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }] } }; }
    async *stream(_options: GenerateOptions): AsyncGenerator<any> { assert.fail('No real model call is needed'); }
  }
  try {
    let baseURL = 'https://api.deepseek.com/anthropic';
    f.ctx.provide('settings', { configure: () => () => {}, describe: () => [{ ns: 'native-test', value: { baseURL, apiKeyEnv: 'DEEPSEEK_API_KEY' } }] } as never);
    f.ctx.provide('credentials', { resolve: async () => ({ value: 'synthetic-key' }) } as never);
    f.ctx.llm.registerAdapter([model.provider], new Model());
    f.ctx.llm.registerConfigurableProviders([{ provider: model.provider, displayName: 'DeepSeek', settingsNs: 'native-test', settingsPath: [] }]);
    await f.ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, compression: 'none' });
    const snapshot = await resolveConnection(f.ctx, model);
    assert.equal(snapshot.protocol, 'anthropic-messages', 'DSH can keep its own Messages default');
    const expected = { 'openai-completions': 'https://api.deepseek.com/chat/completions', 'openai-responses': 'https://api.deepseek.com/responses', 'anthropic-messages': 'https://api.deepseek.com/anthropic/v1/messages' } as const;
    for (const protocol of Object.keys(expected) as Array<keyof typeof expected>) {
      const route = routeForProtocol(snapshot, protocol);
      assert.equal(route.url, expected[protocol]); assert.equal(await connectionKey(f.ctx, route), 'synthetic-key');
      const body = prepareBody(route, { model: model.model, response_format: { type: 'json_object' }, temperature: 0.2 });
      assert.deepEqual(body.response_format, { type: 'json_object' }); assert.equal(body.temperature, 0.2);
      if (protocol === 'openai-completions') { assert.equal(body.reasoning_effort, 'low'); assert.deepEqual(body.thinking, { type: 'enabled' }); }
    }
    await f.register('sf_native_deepseek_openai', async (_input, execution) => {
      const connection = await execution.model.getConnection({ protocol: 'openai-completions' });
      assert.equal(connection.protocol, 'openai-completions'); assert.equal(connection.model, model.model);
      assert.notEqual(connection.apiKey, 'synthetic-key'); return { text: 'connection accepted' };
    }, ['openai-completions']);
    await f.call('get_tool_contract', { toolId: 'sf_native_deepseek_openai', model });
    const accepted = await f.call('run_tool', { toolId: 'sf_native_deepseek_openai', input: {}, model });
    assert.equal((await f.finish(accepted.runId)).result.text, 'connection accepted');
    baseURL = 'http://127.0.0.1:1/custom/anthropic';
    const custom = await resolveConnection(f.ctx, model);
    assert.throws(() => routeForProtocol(custom, 'openai-completions'), /尚未登记/);
    assert.equal(routeForProtocol(snapshot, 'openai-completions').url, expected['openai-completions'], 'A saved route cannot change with settings');
  } finally { await f.close(); }
});

test('SDK registrations become available automatically and unloading revokes access', async () => {
  // Host schema admission must also accept old profiles carrying the removed field.
  const f = await fixture({ allowedToolIds: [] });
  try {
    const toolId = 'sf_new_registered_entry', plugin = await f.register(toolId, async () => ({ text: 'auto registered' }));
    assert.equal((await f.call('get_tool_contract', { toolId })).toolId, toolId);
    assert.equal((await f.finish((await f.call('run_tool', { toolId, input: {} })).runId)).result.text, 'auto registered');
    await plugin.dispose();
    const response = await f.ctx.tools.execute({ callId: ToolCallId(randomUUID()), name: 'sf_runtime_get_tool_contract', arguments: { toolId }, agent: f.agent, signal: new AbortController().signal });
    assert.equal((response as any).value.error.code, 'PROTOCOL_UNSUPPORTED');
    f.ctx.tools.register({ name: 'ordinary_non_sdk_tool', description: 'Not registered with Runtime', parameters: { type: 'object', properties: {} }, output: { schema: {}, render: () => [] }, execute: async () => ({}) });
    const unregistered = await f.ctx.tools.execute({ callId: ToolCallId(randomUUID()), name: 'sf_runtime_get_tool_contract', arguments: { toolId: 'ordinary_non_sdk_tool' }, agent: f.agent, signal: new AbortController().signal });
    assert.equal((unregistered as any).value.error.code, 'PROTOCOL_UNSUPPORTED');
  } finally { await f.close(); }
});

test('issues: warning delivery, fatal cannot be masked, and DSH guard remains authoritative', async () => {
  const f = await fixture();
  try {
    await f.register('sf_test_issue', async (_input, execution) => {
      await execution.reportProgress({ stage: 'check', stageName: '检查', progress: 25 });
      await execution.reportIssue({ level: 'warning', stage: 'check', message: '合成告警' });
      await execution.reportIssue({ level: 'error', stage: 'check', message: '合成致命错误', fatal: true });
      return { text: 'must not mask fatal' };
    });
    const accepted = await f.call('run_tool', { toolId: 'sf_test_issue', input: {} });
    const run = await f.finish(accepted.runId);
    assert.equal(run.status, 'failed'); assert.equal(run.result, undefined);
    assert.ok(run.issues.some((i: any) => i.level === 'warning' && i.stage === 'check'));
    await f.register('sf_test_text', async () => ({ text: 'should be denied' }));
    const remove = f.ctx.tools.guard(exec => exec.name === 'sf_test_text' ? 'synthetic guard denial' : undefined);
    const denied = await f.call('run_tool', { toolId: 'sf_test_text', input: {} });
    assert.equal((await f.finish(denied.runId)).status, 'failed'); remove();
  } finally { await f.close(); }
});

test('optional model: pure algorithm, explicit fixed route and isolated recorded model request', async () => {
  const f = await fixture();
  const seen: GenerateOptions[] = [];
  class MockModel extends LlmAdapter {
    async listModels(provider: string) { return [{ provider, id: 'example-model', name: 'Synthetic model' }]; }
    async resolveModel(provider: string, model: string) { return { provider, id: model, name: 'Synthetic model', reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] } }; }
    async *stream(options: GenerateOptions) {
      seen.push(options);
      yield { type: 'text-delta' as const, index: 0, text: 'synthetic model response' };
      yield { type: 'usage' as const, usage: { inputTokens: 3, outputTokens: 4 } };
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } };
    }
  }
  try {
    f.ctx.llm.registerAdapter(['test-provider'], new MockModel());
    await f.ctx.plugin({ name: 'synthetic-legacy-sdk', inject: ['tools', 'sfRuntime'], apply(scope: Context) {
      registerLegacyTool(scope, { toolId: 'sf_legacy_sdk_010', description: 'synthetic_test: published SDK 0.1.0', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        execute: async (_input: any, execution: ExecutionContext) => { await execution.reportProgress({ stage: 'legacy', stageName: '旧SDK', progress: 50 }); return { text: (await execution.model.call({ messages: [{ role: 'user', content: 'legacy request' }] })).text }; } });
    } });
    const legacy = await f.finish((await f.call('run_tool', { toolId: 'sf_legacy_sdk_010', input: {}, model: { provider: 'test-provider', model: 'example-model' } })).runId);
    assert.equal(legacy.status, 'completed'); assert.equal(legacy.result.text, 'synthetic model response');
    assert.equal(legacy.modelCalls[0].protocol, 'sdk');
    seen.length = 0;
    await f.ctx.plugin(Example);
    const pure = await f.call('run_tool', { toolId: 'sf_example_echo', input: { text: 'pure' } });
    assert.equal((await f.finish(pure.runId)).result.text, 'pure'); assert.equal(seen.length, 0);
    const missing = await f.call('run_tool', { toolId: 'sf_example_echo', input: { text: 'missing', useModel: true } });
    assert.equal((await f.finish(missing.runId)).status, 'failed'); assert.equal(seen.length, 0);
    const accepted = await f.call('run_tool', { toolId: 'sf_example_echo', input: { text: 'only task input', useModel: true }, model: { provider: 'test-provider', model: 'example-model', reasoningEffort: 'high' } });
    const run = await f.finish(accepted.runId);
    assert.equal(run.status, 'completed', JSON.stringify(run.issues));
    assert.equal(run.result.text, 'synthetic model response'); assert.equal(seen.length, 1);
    assert.equal(seen[0].provider, 'test-provider'); assert.equal(seen[0].model, 'example-model');
    assert.equal(seen[0].reasoningEffort, 'high'); assert.equal(run.model.reasoningEffort, 'high');
    for (const key of ['temperature', 'maxTokens', 'stop']) assert.equal(Object.hasOwn(seen[0], key), false, `Legacy call must not inject ${key}`);
    assert.ok(seen[0].sessionId !== f.agent.id);
    assert.equal(run.modelCalls.length, 1);
    const detail = await f.rpc('getModelCall', { runId: run.runId, requestId: run.modelCalls[0].requestId });
    const saved = detail.transcript;
    const replayed = Session.create(SessionId(saved.header.id), saved.events, saved.header);
    assert.equal(replayed.requestHeader()?.config.model, 'example-model');
    assert.equal(replayed.requestHeader()?.config.reasoningEffort, 'high');
  } finally { await f.close(); }
});

test('model controls: per-call values, omitted route defaults, validation and recorded dispatch agree', async () => {
  const f = await fixture(), seen: GenerateOptions[] = [];
  let truncated = false;
  class ControlledModel extends LlmAdapter {
    async listModels(provider: string) { return [{ provider, id: 'controlled', name: 'Synthetic controls model' }]; }
    async resolveModel(provider: string, model: string) { return { provider, id: model, name: 'Synthetic controls model', defaultMaxTokens: 4096 }; }
    async *stream(options: GenerateOptions) {
      seen.push(options);
      yield { type: 'text-delta' as const, index: 0, text: 'synthetic answer' };
      yield { type: 'finish' as const, reason: truncated ? { kind: 'max-tokens' as const } : { kind: 'stop' as const } };
    }
  }
  const messages: ModelRequest['messages'] = [{ role: 'user', content: 'Synthetic requirement' }];
  const calls: ModelRequest[] = [
    { messages, temperature: 0.3, maxTokens: 8192, stop: ['<END>', '\n\n'] },
    { messages, temperature: 0, maxTokens: 1 },
    { messages, temperature: 0.2 },
    { messages },
  ];
  let requests = calls;
  try {
    f.ctx.llm.registerAdapter(['controls-test'], new ControlledModel());
    await f.register('sf_test_model_controls', async (_input, execution) => {
      for (const request of requests) await execution.model.call(request);
      return { text: 'all calls finished' };
    });
    const start = async () => f.finish((await f.call('run_tool', { toolId: 'sf_test_model_controls', input: {}, model: { provider: 'controls-test', model: 'controlled' } })).runId);
    const run = await start();
    assert.equal(run.status, 'completed', JSON.stringify(run.issues));
    assert.deepEqual(seen.map(o => ({ temperature: o.temperature, maxTokens: o.maxTokens, stop: o.stop })), [
      { temperature: 0.3, maxTokens: 8192, stop: ['<END>', '\n\n'] },
      { temperature: 0, maxTokens: 1, stop: undefined },
      { temperature: 0.2, maxTokens: 4096, stop: undefined },
      { temperature: undefined, maxTokens: 4096, stop: undefined },
    ]);
    assert.equal(Object.hasOwn(seen[3], 'temperature'), false);
    assert.equal(Object.hasOwn(seen[3], 'stop'), false);
    for (const [i, options] of seen.entries()) {
      const detail = await f.rpc('getModelCall', { runId: run.runId, requestId: run.modelCalls[i].requestId });
      const saved = detail.transcript;
      const replayed = Session.create(SessionId(saved.header.id), saved.events, saved.header);
      const { messages: _messages, ...requested } = calls[i];
      assert.deepEqual(saved.requestedControls, Object.keys(requested).length ? requested : undefined);
      const config = replayed.requestHeader()!.config;
      assert.deepEqual({ temperature: config.temperature, maxTokens: config.maxTokens, stop: config.stop },
        { temperature: options.temperature, maxTokens: options.maxTokens, stop: options.stop });
    }
    const invalid = [{ temperature: -0.1 }, { temperature: 2.1 }, { maxTokens: 0 }, { maxTokens: 1.5 }, { stop: [] }, { stop: [''] }, { top_p: 0.9 }];
    for (const controls of invalid) {
      requests = [{ messages, ...controls } as ModelRequest];
      const failed = await start();
      assert.equal(failed.status, 'failed');
      assert.ok(failed.issues.some((issue: any) => issue.code === 'INVALID_INPUT'), JSON.stringify(failed.issues));
    }
    assert.equal(seen.length, 4, 'Invalid parameters must fail before provider dispatch');
    truncated = true; requests = [{ messages, maxTokens: 1 }];
    const limited = await start();
    assert.equal(limited.status, 'failed');
    assert.ok(limited.issues.some((issue: any) => issue.code === 'MODEL_OUTPUT_TRUNCATED'));
    assert.equal(limited.result, undefined);
  } finally { await f.close(); }
});

test('cancel: signal and cleanup stop the producer while retaining task materials', async () => {
  const f = await fixture(); let cleaned = 0;
  const began = Promise.withResolvers<void>();
  try {
    await f.register('sf_test_cancel', async (_input, execution) => {
      const released = Promise.withResolvers<void>();
      execution.registerCleanup(() => { cleaned++; released.resolve(); });
      await writeFile(join(execution.outputDirectory, 'snapshots/state.json'), '{}');
      await execution.addArtifact({ kind: 'intermediate', name: 'state.json', relativePath: 'snapshots/state.json', mime: 'application/json' });
      await execution.log('waiting for cancellation'); began.resolve();
      await released.promise; execution.signal.throwIfAborted(); return { text: 'not delivered' };
    });
    const accepted = await f.call('run_tool', { toolId: 'sf_test_cancel', input: {} }); await began.promise;
    await f.rpc('cancelRun', { runId: accepted.runId });
    const run = await f.finish(accepted.runId);
    assert.equal(run.status, 'cancelled'); assert.equal(cleaned, 1); assert.equal(run.result, undefined);
    assert.ok(run.logs.some((log: any) => log.message === 'waiting for cancellation'));
    assert.deepEqual(run.intermediateDirectories, [{ path: join(f.workspace, 'outputs/runs', run.runId, 'snapshots'), fileCount: 1 }]);
    assert.ok(await readFile(join(f.workspace, 'outputs/runs', run.runId, 'run.json'), 'utf8'));
  } finally { await f.close(); }
});

test('images: API-style multi-image history becomes real DSH attachments; text-only routes reject it', async () => {
  const f = await fixture();
  const seen: GenerateOptions[] = [];
  class VisionModel extends LlmAdapter {
    async listModels(provider: string) { return [
      { provider, id: 'vision', name: 'Synthetic vision', inputModalities: ['text', 'image'] as const },
      { provider, id: 'text-only', name: 'Synthetic text', inputModalities: ['text'] as const },
    ]; }
    async resolveModel(provider: string, model: string) {
      return { provider, id: model, name: model, inputModalities: model === 'vision' ? ['text', 'image'] as const : ['text'] as const };
    }
    async *stream(options: GenerateOptions) {
      seen.push(options);
      yield { type: 'text-delta' as const, index: 0, text: 'synthetic image description' };
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } };
    }
  }
  try {
    await f.ctx.plugin(AttachmentLocal, { dshHome: join(f.workspace, '.test-dsh') });
    const sharp = createRequire(import.meta.resolve('@deepseek-ai/dsh-attachment-local'))('sharp');
    // A valid >1MiB image verifies image bytes no longer hit the old text request cap.
    const png: Buffer = await sharp(randomBytes(700 * 600 * 3), { raw: { width: 700, height: 600, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    const url = 'data:image/png;base64,' + png.toString('base64');
    assert.ok(png.byteLength > 1024 * 1024);
    let request: ModelRequest = { messages: [
      { role: 'system', content: 'Describe the supplied images.' },
      { role: 'user', content: [{ type: 'text', text: 'Compare these images' },
        { type: 'image_url', image_url: { url } }, { type: 'image_url', image_url: { url } }] },
      { role: 'assistant', content: 'A previous answer supplied by the developer.' },
      { role: 'user', content: 'Continue from that answer.' },
    ] };
    f.ctx.llm.registerAdapter(['image-test'], new VisionModel());
    await f.register('sf_test_image', async (_input, execution) => ({ text: (await execution.model.call(request)).text }));
    const accepted = await f.call('run_tool', { toolId: 'sf_test_image', input: {}, model: { provider: 'image-test', model: 'vision' } });
    const run = await f.finish(accepted.runId);
    assert.equal(run.status, 'completed', JSON.stringify(run.issues));
    assert.equal(run.result.text, 'synthetic image description');
    const images = seen[0].messages[1].content.filter(part => part.type === 'image');
    assert.equal(images.length, 2);
    for (const image of images) {
      if (image.type !== 'image') throw new Error('Missing image');
      const stored = await f.ctx.attachments.readImage(image.attachment);
      assert.equal(stored.ref.width, 700); assert.equal(stored.ref.height, 600);
    }
    assert.equal(seen[0].messages[2].role, 'assistant');
    const detail = await f.rpc('getModelCall', { runId: run.runId, requestId: run.modelCalls[0].requestId });
    const log = JSON.stringify(detail.transcript);
    assert.ok(log.includes('attachmentId')); assert.ok(!log.includes('data:image/'));
    const saved = JSON.parse(log);
    Session.create(SessionId(saved.header.id), saved.events, saved.header);

    const rejected = await f.call('run_tool', { toolId: 'sf_test_image', input: {}, model: { provider: 'image-test', model: 'text-only' } });
    const failed = await f.finish(rejected.runId);
    assert.equal(failed.status, 'failed');
    assert.ok(failed.issues.some((issue: any) => issue.code === 'MODEL_IMAGE_UNSUPPORTED'));
    assert.equal(seen.length, 1, 'must reject before provider dispatch');

    request = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://127.0.0.1/private.png' } }] }] };
    const blocked = await f.call('run_tool', { toolId: 'sf_test_image', input: {}, model: { provider: 'image-test', model: 'vision' } });
    assert.ok((await f.finish(blocked.runId)).issues.some((issue: any) => issue.code === 'IMAGE_URL_BLOCKED'));
    assert.equal(seen.length, 1);
  } finally { await f.close(); }
});

test('image URL: download converts to an attachment with a mocked public HTTP endpoint', async t => {
  const f = await fixture();
  const network = new MockAgent(); network.disableNetConnect();
  try {
    await f.ctx.plugin(AttachmentLocal, { dshHome: join(f.workspace, '.test-dsh') });
    const sharp = createRequire(import.meta.resolve('@deepseek-ai/dsh-attachment-local'))('sharp');
    const png: Buffer = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#4488cc' } }).png().toBuffer();
    const endpoint = network.get('https://93.184.216.34');
    endpoint.intercept({ method: 'GET', path: '/image.png' })
      .reply(200, png, { headers: { 'content-type': 'application/octet-stream' } });
    t.mock.method(HttpAgent.prototype, 'dispatch', (options, handler) => endpoint.dispatch(options, handler));
    const content = await userContent(f.ctx, [{ type: 'text', text: 'describe' },
      { type: 'image_url', image_url: { url: 'https://93.184.216.34/image.png' } }], new AbortController().signal);
    assert.equal(content[0].type, 'text');
    assert.equal(content[1].type, 'image');
    if (content[1].type === 'image') assert.equal((await f.ctx.attachments.readImage(content[1].attachment)).ref.width, 2);
    network.assertNoPendingInterceptors();
  } finally { await network.close(); await f.close(); }
});
