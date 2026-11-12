import { randomBytes, createHash } from 'node:crypto';
import type { RemoteInvocation, PeerScope } from '@deepseek-ai/dsh-typert-protocol';
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection';
import { ensure, failure } from './validation.ts';
export const INTERACTION_UI_PATH = '/api/sf-runtime/ui-session';
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
/** Same authenticated-browser capability pattern as orchestration confirmation. */
export class InteractionAuthorization {
  private tokens = new Map<string, { peer: PeerScope; expires: number }>();
  async bootstrap(request: Request, connection: HostConnectionHandle): Promise<Response> {
    try {
      const admitted = connection.admit(request);
      ensure('peer' in admitted, 'UNAUTHORIZED', '请登录DSH');
      const origin = new URL(request.headers.get('origin') ?? '');
      ensure(request.method === 'POST' && origin.host === request.headers.get('host') && origin.origin === request.headers.get('origin') && request.headers.get('sec-fetch-site') === 'same-origin', 'UNAUTHORIZED', '需要同源网页操作');
      ensure(request.headers.get('content-type')?.split(';')[0] === 'application/json' && /^\s*\{\s*\}\s*$/.test(await request.text()), 'INVALID_INPUT', '请求体应为空对象');
      for (const [key, value] of this.tokens) if (value.expires <= Date.now()) this.tokens.delete(key);
      ensure(this.tokens.size < 128, 'BUSY', '连接过多，请稍后重试');
      const token = randomBytes(32).toString('base64url'), expires = Date.now() + 20 * 60_000;
      this.tokens.set(digest(token), { peer: admitted.peer, expires });
      return Response.json({ ok: true, data: { token, expiresAt: expires } }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) { return Response.json({ ok: false, error: failure(error) }, { status: 403 }); }
  }
  check(invocation: RemoteInvocation | undefined, token: string) {
    const grant = typeof token === 'string' ? this.tokens.get(digest(token)) : undefined;
    ensure(invocation && grant && grant.peer === invocation.peer && grant.expires > Date.now(), 'UNAUTHORIZED', '回答需要有效网页授权，请刷新后重试');
  }
  dispose() { this.tokens.clear(); }
}
