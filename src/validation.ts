import { z } from 'zod';
export class RunError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = 'RunError'; } }
export function ensure(value: unknown, code: string, message: string): asserts value { if (!value) throw new RunError(code, message); }
export function failure(error: unknown) {
  if (error instanceof RunError) return { code: error.code, message: error.message };
  if (error instanceof z.ZodError) return { code: 'INVALID_INPUT', message: error.issues.map(i => i.path.join('.') + ': ' + i.message).join('; ') };
  return { code: 'EXECUTION_FAILED', message: error instanceof Error ? error.message : '执行失败' };
}
const id = z.string().min(1).max(512);
const runId = z.string().uuid();
export const status = z.enum(['queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted']);
export const model = z.object({ provider: id, model: id, reasoningEffort: id.optional() }).strict();
export const progress = z.object({ stage: id, stageName: id, progress: z.number().finite().min(0).max(100).optional(), message: z.string().max(16384).optional() }).strict();
export const issue = z.object({ level: z.enum(['warning', 'error']), stage: id.optional(), code: id.optional(), message: z.string().min(1).max(16384), fatal: z.boolean().optional() }).strict();
export const artifact = z.object({ kind: z.enum(['intermediate', 'final']), name: id, relativePath: z.string().min(1).max(4096), mime: id }).strict();
export const businessResult = z.object({ text: z.string().optional(), files: z.array(runId).max(100).optional() }).strict().refine(v => !!v.text?.trim() || !!v.files?.length, '至少返回文本或一个文件');
const json = z.json();
export const requests = {
  contract: z.object({ toolId: id }).strict(),
  run: z.object({ toolId: id, input: z.record(z.string(), json), model: model.optional(), timeoutMs: z.number().int().min(1000).max(7200000).optional() }).strict(),
  id: z.object({ runId }).strict(),
  list: z.object({ toolId: id.optional(), status: status.optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional() }).strict(),
  wait: z.object({ runId, afterSeq: z.number().int().min(0).optional(), waitMs: z.number().int().min(1).max(30000).optional() }).strict(),
  watch: z.object({ runId, afterSeq: z.number().int().min(0).optional() }).strict(),
  artifact: z.object({ runId, artifactId: runId }).strict(),
};
const modelPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string().min(1) }).strict() }).strict(),
]);
export const modelRequest = z.object({ messages: z.array(z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: z.string() }).strict(),
  z.object({ role: z.literal('assistant'), content: z.string() }).strict(),
  z.object({ role: z.literal('user'), content: z.union([z.string(), z.array(modelPart).min(1)]) }).strict(),
])).min(1).max(100) }).strict();
