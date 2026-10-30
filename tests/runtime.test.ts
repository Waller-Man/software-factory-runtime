/** Small integration groups: real DSH services, synthetic business/model, no paid inference. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
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
  async function register(toolId: string, execute: (input: any, execution: ExecutionContext) => Promise<any>) {
    return ctx.plugin({ name: toolId, inject: ['tools', 'sfRuntime'], apply(scope: Context) { registerRunTool(scope, { toolId, description: 'synthetic_test', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, execute }); } });
  }
  return { ctx, agent, workspace, runtime, call, rpc, finish, register, async close() { removeDescriptors(); await ctx.fiber.dispose(); } };
}

test('complete run: real Tool chain, Remote, progress, artifacts and reloadable history', async () => {
  const f = await fixture();
  try {
    const example = await f.ctx.plugin(Example);
    assert.equal(remote.descriptors.length, 8);
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
    assert.ok(seen[0].sessionId !== f.agent.id);
    const { readdir } = await import('node:fs/promises');
    const logs = await readdir(join(f.workspace, 'outputs/runs', run.runId, 'logs'));
    assert.ok(logs.some(name => name.startsWith('sf-run-model-')));
    const saved = JSON.parse(await readFile(join(f.workspace, 'outputs/runs', run.runId, 'logs', logs.find(n => n.startsWith('sf-run-model-'))!), 'utf8'));
    const replayed = Session.create(SessionId(saved.header.id), saved.events, saved.header);
    assert.equal(replayed.requestHeader()?.config.model, 'example-model');
    assert.equal(replayed.requestHeader()?.config.reasoningEffort, 'high');
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
    const { readdir } = await import('node:fs/promises');
    const logDir = join(f.workspace, 'outputs/runs', run.runId, 'logs');
    const log = await readFile(join(logDir, (await readdir(logDir))[0]), 'utf8');
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
