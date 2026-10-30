import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { Session, SessionId, SESSION_FORMAT_VERSION, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
import { BlockAssembler, AssistantStreamAccumulator, createSystemMessage, createUserMessage, createAssistantMessage, ReasoningEffortId, type Message } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type { ModelRef, ModelRequest, ModelResponse } from '@software-factory/contracts/runtime';
import { ensure, failure, modelRequest } from './validation.ts';
import { saveJson } from './files.ts';
import { userContent } from './images.ts';

/** One isolated, tool-free DSH Session per model call. No Agent is created. */
export async function callModel(ctx: Context, selection: ModelRef | undefined, request: ModelRequest, directory: string, workspace: string, signal: AbortSignal): Promise<ModelResponse> {
  ensure(selection, 'MODEL_REQUIRED', '未选择模型，请启动任务时指定模型或使用已有会话模型');
  const llm = ctx.get('llm'); ensure(llm, 'MODEL_UNAVAILABLE', 'DSH模型服务未启用');
  const input = modelRequest.parse(request);
  const textBytes = input.messages.reduce((size, m) => size + (typeof m.content === 'string'
    ? Buffer.byteLength(m.content)
    : m.content.reduce((n, part) => n + (part.type === 'text' ? Buffer.byteLength(part.text) : 0), 0)), 0);
  ensure(textBytes <= 1024 * 1024, 'INVALID_INPUT', '模型请求文本超过1MiB');
  ensure(!input.messages.slice(1).some(m => m.role === 'system'), 'INVALID_INPUT', 'system只能位于第一条消息');
  signal.throwIfAborted();
  const id = SessionId('sf-run-model-' + randomUUID());
  const header: SessionHeader = { id, version: SESSION_FORMAT_VERSION, createdAt: Date.now(), cwd: workspace, isSeeded: false };
  const session = Session.create(id, undefined, header), events: SessionEvent[] = [];
  const append: typeof session.append = ((...args: Parameters<typeof session.append>) => {
    const event = (session.append as (...v: unknown[]) => SessionEvent)(...args); events.push(event); return event;
  }) as typeof session.append;
  const logPath = join(directory, 'logs', id + '.json');
  const persistence = ctx.get('sessionPersistence');
  const handle = persistence ? await persistence.create(header) : undefined;
  let persisted = 0;
  async function flush() {
    await saveJson(logPath, { header, events });
    if (handle) { await handle.append(events.slice(persisted)); await handle.flush(); persisted = events.length; }
  }
  const assembler = new BlockAssembler(), stream = new AssistantStreamAccumulator();
  let responseWritten = false;
  try {
    const catalog = await llm.listModels(selection.provider);
    ensure(catalog.some(m => m.id === selection.model), 'MODEL_UNAVAILABLE', '指定模型不在DSH模型目录中');
    const prepared = await llm.prepareCall({ provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) } : {}) }, signal);
    const hasImages = input.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'));
    ensure(!hasImages || prepared.inputModalities?.includes('image'), 'MODEL_IMAGE_UNSUPPORTED', '本次模型未声明支持图片，请选择DSH目录中的视觉模型');
    append('turn/start', { turn: 1 }); append('step/start', { turn: 1, step: 1 });
    const messages: Message[] = [];
    const first = input.messages[0];
    const system = first?.role === 'system' ? first.content : '';
    const systemMessage = createSystemMessage(system); messages.push(systemMessage);
    append('system/message', { turn: 1, step: 1, message: systemMessage }, { surfaceOp: 'append' });
    for (const m of input.messages) {
      if (m.role === 'system') continue;
      if (m.role === 'user') {
        const message = createUserMessage({ content: await userContent(ctx, m.content, signal), source: { kind: 'user' } });
        messages.push(message); append('user/message', message, { surfaceOp: 'append' });
      } else {
        const message = createAssistantMessage({ content: [{ type: 'text', text: m.content }], source: selection });
        messages.push(message); append('assistant/message', { turn: 1, step: 1, message, stream: [] }, { surfaceOp: 'append' });
      }
    }
    append('request/header', { header: { config: prepared.config }, reason: 'initial', startsSeries: true });
    await flush(); // The exact model-visible request is stored before dispatch.
    for await (const chunk of prepared.stream({ ...prepared.config, messages, signal, sessionId: id })) {
      stream.push({ time: Date.now(), chunk }); assembler.push(chunk);
    }
    const finish = assembler.finish;
    ensure(finish, 'MODEL_REQUEST_FAILED', '模型流缺少结束标志');
    if (finish.kind === 'error' || finish.kind === 'aborted') throw Object.assign(new Error(finish.failure.message), { code: finish.failure.code });
    ensure(finish.kind === 'stop' || finish.kind === 'max-tokens', 'MODEL_REQUEST_FAILED', '本接口只支持文本模型响应');
    ensure(finish.kind !== 'max-tokens', 'MODEL_OUTPUT_TRUNCATED', '模型输出达到长度上限，请调整输入后重试');
    const text = assembler.blocks().filter(b => b.type === 'text').map(b => b.text).join('');
    append('assistant/message', { turn: 1, step: 1, message: assembler.message(selection), stream: [...stream.snapshot()], ...(assembler.usage ? { usage: assembler.usage } : {}) }, { surfaceOp: 'append' });
    responseWritten = true;
    append('step/end', { turn: 1, step: 1 }); append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    await flush();
    return { text, ...(assembler.usage ? { usage: assembler.usage } : {}) };
  } catch (error) {
    if (events.some(e => e.type === 'turn/start') && !events.some(e => e.type === 'turn/end')) {
      if (!responseWritten) append('assistant/attempt', { turn: 1, step: 1, stream: [...stream.snapshot()] });
      append('step/end', { turn: 1, step: 1 });
      append('turn/end', { turn: 1, reason: { kind: 'error', error: failure(error) } });
    }
    await flush(); throw error;
  } finally { await handle?.close(); }
}
