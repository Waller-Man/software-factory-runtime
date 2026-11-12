/** Resolve only the selected DSH connection; never accept an upstream URL from a caller. */
import type { Context } from '@deepseek-ai/cordis';
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import type {} from '@deepseek-ai/dsh-settings';
import type { ModelProtocol, ModelRef, RunObject } from '@software-factory/contracts/runtime';
import { ensure } from './validation.ts';

export const modelProtocols: ModelProtocol[] = ['openai-completions', 'openai-responses', 'anthropic-messages'];
export const modelPaths: Record<ModelProtocol, string> = {
  'openai-completions': '/chat/completions', 'openai-responses': '/responses', 'anthropic-messages': '/messages',
};
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
export interface UpstreamConnection {
  selection: ModelRef; protocol: ModelProtocol; url: string; credentialRef?: string; credentialProvider?: string;
  nativeDeepSeek: boolean; effort?: string; compat: Record<string, any>; headers: Record<string, string>;
  thinkingBudgets: Record<string, number>;
  /** Frozen, confirmed endpoints on this connection; not URLs supplied by a Tool. */
  protocolUrls: Partial<Record<ModelProtocol, string>>;
  deepSeek: boolean;
}

/** Keep custom endpoints intact. Alternate paths are declared only for verified official roots. */
export function protocolUrlsFor(base: URL, protocol: ModelProtocol, currentUrl: string): Partial<Record<ModelProtocol, string>> {
  const urls: Partial<Record<ModelProtocol, string>> = { [protocol]: currentUrl };
  const path = base.pathname.replace(/\/+$/, '');
  if (base.origin === 'https://api.deepseek.com' && ['', '/v1', '/anthropic', '/anthropic/v1'].includes(path)) {
    Object.assign(urls, {
      'openai-completions': base.origin + '/chat/completions',
      'openai-responses': base.origin + '/responses',
      'anthropic-messages': base.origin + '/anthropic/v1/messages',
    });
  } else if (base.origin === 'https://api.openai.com' && ['', '/v1'].includes(path)) {
    Object.assign(urls, { 'openai-completions': base.origin + '/v1/chat/completions', 'openai-responses': base.origin + '/v1/responses' });
  }
  return urls;
}

/** Tool protocol selects an upstream route; DSH's own default protocol is not a constraint. */
export function routeForProtocol(connection: UpstreamConnection, protocol: ModelProtocol): UpstreamConnection {
  const url = connection.protocolUrls[protocol];
  ensure(url, 'MODEL_PROTOCOL_UNSUPPORTED', `所选服务地址尚未登记${protocol}协议入口；Runtime不能猜测自定义地址或转换协议`);
  return { ...connection, protocol, url, compat: { ...connection.compat,
    ...(connection.deepSeek && protocol === 'openai-completions' ? { thinkingFormat: 'deepseek' } : {}) } };
}

export async function resolveConnection(ctx: Context, selection: ModelRef): Promise<UpstreamConnection> {
  const llm = ctx.get('llm'); ensure(llm, 'MODEL_UNAVAILABLE', 'DSH模型服务未启用');
  const metadata = await llm.resolveModelInfo(selection.provider, selection.model);
  const entry = llm.listConfigurableProviders().find(item => item.provider === selection.provider);
  ensure(entry, 'MODEL_CONNECTION_UNAVAILABLE', '所选连接未提供可读取的DSH连接配置');
  const settings = ctx.get('settings'); ensure(settings, 'MODEL_CONNECTION_UNAVAILABLE', 'DSH配置服务未启用');
  const descriptor = settings.describe({ redactSecrets: true }).find(item => item.ns === entry.settingsNs);
  ensure(descriptor, 'MODEL_CONNECTION_UNAVAILABLE', '所选连接的配置尚不可用');
  let profile = object(descriptor.value);
  for (const part of entry.settingsPath) profile = object(profile[part]);
  const nativeDeepSeek = selection.provider === 'deepseek-official';
  ensure(selection.provider !== 'deepseek-account', 'MODEL_AUTH_UNSUPPORTED', '账号登录连接请继续使用旧model.call；原生HTTP网关需要API Key连接');
  let catalog: Record<string, any> = {};
  // The public installed catalog supplies defaults, never inferred from a display name.
  if (!nativeDeepSeek) {
    try {
      const { getBuiltinModels } = await import('@earendil-works/pi-ai/providers/all');
      catalog = object(getBuiltinModels(selection.provider as never).find(item => item.id === selection.model));
    } catch { /* Fully declared custom routes do not need the optional catalog. */ }
  }
  const declared = (Array.isArray(profile.models) ? profile.models : []).find((item: any) => item.id === selection.model);
  const model = object(declared ?? object(profile.modelOverrides)[selection.model]);
  const protocol = nativeDeepSeek ? 'anthropic-messages' : profile.api ?? catalog.api;
  ensure(modelProtocols.includes(protocol), 'MODEL_PROTOCOL_UNSUPPORTED', '所选连接不属于三种支持的协议，请在DSH中明确配置协议');
  const base = nativeDeepSeek ? profile.baseURL ?? launchEnvironmentOf(ctx).get('DEEPSEEK_BASE_URL')?.value ?? 'https://api.deepseek.com/anthropic' : profile.baseURL ?? catalog.baseUrl;
  ensure(typeof base === 'string' && base.length > 0, 'MODEL_CONNECTION_UNAVAILABLE', '所选连接没有明确的请求地址');
  const url = new URL(base);
  ensure(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash,
    'MODEL_CONNECTION_INVALID', '模型连接地址必须是无认证信息、查询串和片段的HTTP(S)根地址');
  const path = modelPaths[protocol as ModelProtocol];
  const endpointBase = new URL(url);
  // OpenAI base URLs conventionally already include /v1; Anthropic SDK bases do not.
  url.pathname = url.pathname.replace(/\/$/, '') + (protocol === 'anthropic-messages' && !url.pathname.replace(/\/$/, '').endsWith('/v1') ? '/v1' : '') + path;
  const effort = selection.reasoningEffort ?? metadata.reasoning?.defaultEffort;
  if (effort) ensure(metadata.reasoning?.efforts.some(item => item.id === effort), 'MODEL_REASONING_UNSUPPORTED', '所选思考强度不在DSH模型目录中');
  const mapped = effort === undefined ? undefined : object(model.reasoningEfforts)[effort] ?? object(catalog.thinkingLevelMap)[effort] ?? effort;
  ensure(mapped === undefined || typeof mapped === 'string', 'MODEL_REASONING_UNSUPPORTED', '所选思考强度没有可用的协议映射');
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(object(profile.headers))) {
    ensure(typeof value === 'string' && !/[\r\n]/.test(value), 'MODEL_CONNECTION_INVALID', '模型连接头无效');
    if (!['authorization', 'x-api-key', 'cookie', 'host', 'content-length', 'connection'].includes(key.toLowerCase())) headers[key] = value;
  }
  const thinkingBudgets = { ...object(profile.thinkingBudgets) };
  if (!nativeDeepSeek && protocol === 'anthropic-messages' && effort && effort !== 'off' && thinkingBudgets[mapped!] === undefined) {
    try {
      const { thinkingBudgetForLevel } = await import('@earendil-works/pi-ai/api/simple-options');
      if (['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) thinkingBudgets[mapped!] = thinkingBudgetForLevel(effort as never);
    } catch { /* An explicit DSH thinkingBudgets declaration can be used without the optional catalog. */ }
  }
  return { selection: { ...selection }, protocol, url: url.href, nativeDeepSeek,
    credentialRef: profile.apiKeyEnv ?? (nativeDeepSeek ? 'DEEPSEEK_API_KEY' : undefined),
    credentialProvider: nativeDeepSeek ? undefined : selection.provider, effort: mapped,
    compat: { ...object(catalog.compat), ...object(profile.compat), ...object(model.compat) }, headers,
    thinkingBudgets, protocolUrls: protocolUrlsFor(endpointBase, protocol, url.href),
    deepSeek: nativeDeepSeek || endpointBase.origin === 'https://api.deepseek.com' };
}

export async function connectionKey(ctx: Context, connection: UpstreamConnection): Promise<string> {
  const credentials = ctx.get('credentials'); ensure(credentials, 'MODEL_CREDENTIAL_UNAVAILABLE', 'DSH凭据服务未启用');
  let key: string | undefined;
  if (connection.credentialRef) key = (await credentials.resolve(credentialRef(connection.credentialRef)))?.value;
  else if (connection.credentialProvider) {
    const record = await credentials.readRecord(credentialKey('llm-pi-ai', connection.credentialProvider));
    ensure(!record || record.kind === 'api-key', 'MODEL_AUTH_UNSUPPORTED', '该连接使用账号授权，原生HTTP网关只支持API Key');
    key = record?.kind === 'api-key' ? record.key : undefined;
  }
  ensure(typeof key === 'string' && !!key.trim() && !/[\r\n]/.test(key), 'MODEL_CREDENTIAL_UNAVAILABLE', '所选DSH连接尚未配置可用的API Key');
  return key;
}

/** Only routing/effort fields are controlled by the platform; other protocol fields survive. */
export function prepareBody(connection: UpstreamConnection, input: RunObject): RunObject {
  ensure(input.model === connection.selection.model, 'MODEL_CHANGED', '请求模型与上层指定模型不一致');
  const body = structuredClone(input) as Record<string, any>;
  const effort = connection.effort;
  if (connection.protocol === 'anthropic-messages') ensure(body.reasoning === undefined && body.reasoning_effort === undefined, 'MODEL_REASONING_CONFLICT', 'Messages请求请使用上层指定的思考设置');
  if (connection.protocol === 'openai-responses') ensure(body.thinking === undefined && body.reasoning_effort === undefined && body.output_config?.effort === undefined, 'MODEL_REASONING_CONFLICT', 'Responses请求请使用上层指定的思考设置');
  if (connection.protocol === 'openai-completions') ensure(body.reasoning === undefined && body.output_config?.effort === undefined, 'MODEL_REASONING_CONFLICT', 'Chat请求请使用上层指定的思考设置');
  const merge = (key: string, expected: Record<string, any>) => {
    const actual = object(body[key]);
    for (const [field, value] of Object.entries(expected)) ensure(actual[field] === undefined || actual[field] === value,
      'MODEL_REASONING_CONFLICT', '下层请求的思考设置与上层选择冲突');
    body[key] = { ...actual, ...expected };
  };
  if (effort !== undefined) {
    if (connection.protocol === 'openai-responses') merge('reasoning', { effort: effort === 'off' ? 'none' : effort });
    else if (connection.protocol === 'openai-completions') {
      const format = connection.compat.thinkingFormat;
      if (format === 'deepseek') {
        merge('thinking', { type: effort === 'off' ? 'disabled' : 'enabled' });
        if (effort !== 'off') { ensure(body.reasoning_effort === undefined || body.reasoning_effort === effort, 'MODEL_REASONING_CONFLICT', '思考强度冲突'); body.reasoning_effort = effort; }
      } else {
        const value = effort === 'off' ? 'none' : effort;
        ensure(body.reasoning_effort === undefined || body.reasoning_effort === value, 'MODEL_REASONING_CONFLICT', '思考强度冲突'); body.reasoning_effort = value;
      }
    } else if (connection.deepSeek) {
      merge('thinking', { type: effort === 'off' ? 'disabled' : 'enabled' });
      if (effort !== 'off') merge('output_config', { effort });
    } else if (effort === 'off') merge('thinking', { type: 'disabled' });
    else if (connection.compat.forceAdaptiveThinking === true || connection.compat.supportsAdaptiveThinking === true || connection.compat.adaptiveThinking === true) {
      merge('thinking', { type: 'adaptive' }); merge('output_config', { effort });
    } else {
      const budget = connection.thinkingBudgets[effort];
      ensure(Number.isSafeInteger(budget) && budget > 0, 'MODEL_REASONING_UNSUPPORTED', '此Messages连接需要明确的thinkingBudgets或自适应思考声明；请在DSH中配置');
      ensure(body.max_tokens === undefined || body.max_tokens > budget, 'MODEL_REASONING_CONFLICT', 'max_tokens须大于上层思考强度对应的thinking预算');
      merge('thinking', { type: 'enabled', budget_tokens: budget });
    }
  } else {
    ensure(body.thinking === undefined && body.reasoning === undefined && body.reasoning_effort === undefined && body.output_config?.effort === undefined,
      'MODEL_REASONING_CONFLICT', '思考强度由上层指定，请在执行审核界面选择');
  }
  return body as RunObject;
}
