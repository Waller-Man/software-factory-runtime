import z from '@deepseek-ai/schemastery';
import type { Volatile } from '@deepseek-ai/cordis';

export interface RuntimeConfig { defaultTimeoutMs?: number; modelTimeoutMs?: number }
export type LiveRuntimeConfig = { [K in keyof Required<RuntimeConfig>]: Volatile<number> };
export const DEFAULT_TIMEOUT_MS = 3600000;
export const MODEL_TIMEOUT_MS = 480000;
export const Config = z.object({
  defaultTimeoutMs: z.number().step(1).min(1000).max(7200000).default(DEFAULT_TIMEOUT_MS)
    .description('整个任务最长运行时间，单位毫秒；默认1小时。').volatile(),
  modelTimeoutMs: z.number().step(1).min(1000).max(7200000).default(MODEL_TIMEOUT_MS)
    .description('每次模型请求最长时间，单位毫秒；默认8分钟。').volatile(),
});
export function resolveTimeouts(config: RuntimeConfig): Readonly<Required<RuntimeConfig>> {
  return Object.freeze({ defaultTimeoutMs: config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, modelTimeoutMs: config.modelTimeoutMs ?? MODEL_TIMEOUT_MS });
}
export function snapshotConfig(config: LiveRuntimeConfig): Readonly<Required<RuntimeConfig>> {
  return resolveTimeouts({ defaultTimeoutMs: config.defaultTimeoutMs.get(), modelTimeoutMs: config.modelTimeoutMs.get() });
}
