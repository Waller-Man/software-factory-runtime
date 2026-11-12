/** Three machine-only model endpoints hosted by DSH, authorized solely by a live Run lease. */
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type { WebServer } from '@deepseek-ai/dsh-host-webserver';
import { fetch } from 'undici';
import { proxyRouteFor } from '@deepseek-ai/dsh-http-proxy';
import type { ModelConnection, ModelProtocol, ModelCallRecord, RunObject } from '@software-factory/contracts/runtime';
import { connectionKey, prepareBody, type UpstreamConnection } from './model-connection.ts';
import { ensure, failure } from './validation.ts';
import { modelLogValue } from './model-records.ts';

const prefix = '/sf-runtime/model';
const paths: Record<string, ModelProtocol> = {
  '/v1/chat/completions': 'openai-completions', '/v1/responses': 'openai-responses', '/v1/messages': 'anthropic-messages',
};
const hash = (key: string) => createHash('sha256').update(key).digest('hex');
export interface ModelLease {
  runId: string; signal: AbortSignal; route: UpstreamConnection; timeoutMs: number; active(): boolean;
  execute<T>(protocol: ModelProtocol, input: RunObject, work: (record: ModelCallRecord) => Promise<T>): Promise<T>;
}
export class ModelGateway {
  private leases = new Map<string, ModelLease>();
  private web?: WebServer;
  private scope?: Context;
  private binding;
  constructor(ctx: Context) {
    this.binding = ctx.inject(['webServer', 'credentials', 'settings'], scope => {
      this.web = scope.webServer; this.scope = scope;
      scope.effect(() => scope.webServer.register({ kind: 'prefix', path: prefix, handler: (req, res) => this.handle(req, res) }), 'sf-runtime: task model gateway');
      scope.effect(() => () => { this.web = undefined; this.scope = undefined; this.leases.clear(); }, 'sf-runtime: revoke gateway leases');
    });
  }
  async dispose() { this.leases.clear(); await this.binding.dispose(); }
  grant(lease: ModelLease, protocol: ModelProtocol): ModelConnection {
    ensure(this.web && this.scope, 'MODEL_GATEWAY_UNAVAILABLE', '请启用DSH网页、配置与凭据服务以使用模型网关');
    ensure(lease.route.protocol === protocol, 'MODEL_PROTOCOL_UNSUPPORTED', '所选DSH连接与请求协议不匹配；网关不转换协议');
    prepareBody(lease.route, { model: lease.route.selection.model }); // Check the selected effort before exposing a connection.
    const key = 'sf-run-' + randomBytes(32).toString('base64url'), digest = hash(key);
    this.leases.set(digest, lease);
    lease.signal.addEventListener('abort', () => this.leases.delete(digest), { once: true });
    const host = this.web.host.includes(':') ? `[${this.web.host}]` : this.web.host;
    return { baseUrl: `${this.web.protocol}//${host}:${this.web.port}${prefix}${protocol === 'anthropic-messages' ? '' : '/v1'}`,
      apiKey: key, model: lease.route.selection.model, protocol };
  }
  revoke(runId: string) { for (const [key, lease] of this.leases) if (lease.runId === runId) this.leases.delete(key); }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    let protocol: ModelProtocol | undefined;
    try {
      protocol = paths[new URL(req.url ?? '', 'http://runtime.local').pathname.slice(prefix.length)];
      ensure(req.method === 'POST' && protocol, 'MODEL_PROTOCOL_UNSUPPORTED', '只允许三个模型POST接口');
      ensure(!req.headers.origin, 'UNAUTHORIZED', '模型网关只接受后端SDK请求');
      const auth = req.headers.authorization, apiKey = req.headers['x-api-key'];
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : typeof apiKey === 'string' ? apiKey : '';
      const lease = this.leases.get(hash(token));
      ensure(lease && lease.active() && !lease.signal.aborted, 'UNAUTHORIZED', '任务凭证无效或任务已结束');
      ensure(lease.route.protocol === protocol, 'MODEL_PROTOCOL_UNSUPPORTED', '所选连接不支持该协议');
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; ensure(size <= 64 * 1024 * 1024, 'INVALID_INPUT', '模型请求超过64MiB'); chunks.push(Buffer.from(chunk)); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RunObject;
      ensure(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_INPUT', '模型请求需要JSON对象');
      const body = prepareBody(lease.route, input);
      const disconnected = new AbortController();
      const close = () => { if (!res.writableEnded) disconnected.abort(new Error('Model client disconnected')); };
      res.on('close', close);
      const signal = AbortSignal.any([lease.signal, disconnected.signal, AbortSignal.timeout(lease.timeoutMs)]);
      try {
        const ctx = this.scope; ensure(ctx, 'MODEL_GATEWAY_UNAVAILABLE', '模型网关已停用');
        const key = await connectionKey(ctx, lease.route);
        const scrub = (value: string) => value.replaceAll(key, '[redacted]').replaceAll(token, '[redacted]');
        const logged = JSON.parse(scrub(JSON.stringify(modelLogValue(body))));
        await lease.execute(protocol, logged, async record => {
          // Requests may themselves contain user-provided secrets; at minimum never persist our two credentials.
          record.request = logged;
          const headers: Record<string, string> = { ...lease.route.headers, 'content-type': 'application/json' };
          if (protocol === 'anthropic-messages') {
            headers['x-api-key'] = key;
            headers['anthropic-version'] = typeof req.headers['anthropic-version'] === 'string' ? req.headers['anthropic-version'] : '2023-06-01';
            if (typeof req.headers['anthropic-beta'] === 'string') headers['anthropic-beta'] = req.headers['anthropic-beta'];
          } else headers.authorization = 'Bearer ' + key;
          const proxy = proxyRouteFor(new URL(lease.route.url));
          const upstream = await fetch(lease.route.url, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error',
            ...(proxy.proxied ? { dispatcher: proxy.dispatcher } : {}) });
          res.statusCode = upstream.status;
          res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('X-Accel-Buffering', 'no');
          let recorded = '', recordedBytes = 0;
          const decoder = new TextDecoder();
          try {
            if (upstream.body) for await (const chunk of upstream.body) {
              signal.throwIfAborted();
              recordedBytes += chunk.length;
              ensure(recordedBytes <= 64 * 1024 * 1024, 'MODEL_RESPONSE_TOO_LARGE', '模型响应超过64MiB');
              recorded += decoder.decode(chunk, { stream: true });
              if (!res.write(chunk)) await once(res, 'drain', { signal });
            }
          } finally {
            recorded += decoder.decode();
            const text = scrub(recorded);
            try { record.response = modelLogValue(JSON.parse(text)); } catch { record.response = text; }
            const value = typeof record.response === 'object' && record.response !== null && !Array.isArray(record.response) ? record.response : undefined;
            if (value?.usage) record.usage = value.usage;
            if (body.stream) {
              const events = recorded.split(/\r?\n/).filter(line => line.startsWith('data: '));
              for (const line of events) try { const event = JSON.parse(line.slice(6)); const usage = event.usage ?? event.response?.usage ?? event.message?.usage; if (usage) record.usage = { ...(typeof record.usage === 'object' ? record.usage : {}), ...usage }; } catch { /* SSE terminator or incomplete tail. */ }
            }
          }
          if (!upstream.ok) { res.end(); ensure(false, 'MODEL_UPSTREAM_ERROR', `模型服务返回HTTP ${upstream.status}`); }
        });
        res.end();
      } finally { res.off('close', close); }
    } catch (error) {
      const problem = failure(error);
      if (res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      res.statusCode = problem.code === 'UNAUTHORIZED' ? 401 : 400;
      res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(protocol === 'anthropic-messages'
        ? { type: 'error', error: { type: 'invalid_request_error', message: problem.message } }
        : { error: { message: problem.message, type: 'invalid_request_error', code: problem.code } }));
    }
  }
}
