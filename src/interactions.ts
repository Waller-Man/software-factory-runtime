import { z } from 'zod';
import type { InteractionRequest, InteractionAnswerInput } from '@software-factory/contracts/runtime';
import { ensure } from './validation.ts';

export const INTERACTION_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const option = z.object({ value: z.string().min(1).max(256), label: z.string().min(1).max(512), description: z.string().max(4096).optional() }).strict();
const base = { question: z.string().trim().min(1).max(4096), detail: z.string().max(16384).optional(), timeoutMs: z.number().int().min(1).max(7 * INTERACTION_TIMEOUT_MS).optional() };
const choices = z.array(option).min(1).max(30).refine(items => new Set(items.map(item => item.value)).size === items.length, '选项value不能重复');
export const interactionRequest = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('select'), options: choices }).strict(),
  z.object({ ...base, type: z.literal('text'), placeholder: z.string().max(1024).optional() }).strict(),
  z.object({ ...base, type: z.literal('mixed'), options: choices, placeholder: z.string().max(1024).optional() }).strict(),
]);
export const interactionAnswer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('select'), value: z.string().min(1).max(256) }).strict(),
  z.object({ type: z.literal('text'), text: z.string().trim().min(1).max(16384) }).strict(),
  z.object({ type: z.literal('mixed'), value: z.string().min(1).max(256).optional(), text: z.string().trim().min(1).max(16384).optional() }).strict().refine(value => value.value !== undefined || value.text !== undefined, '请选择或填写文本'),
]);
export const answerRequest = z.object({ runId: z.string().uuid(), interactionId: z.string().uuid(), answer: interactionAnswer }).strict();
export function validateAnswer(request: InteractionRequest, input: unknown): InteractionAnswerInput {
  const answer = interactionAnswer.parse(input);
  ensure(answer.type === request.type, 'INTERACTION_INVALID_ANSWER', '答案类型与问题不一致');
  if ('value' in answer && answer.value !== undefined) {
    ensure('options' in request && request.options.some(option => option.value === answer.value), 'INTERACTION_INVALID_ANSWER', '答案不属于问题选项');
  }
  return answer;
}

/** Monotonic execution-time budget; human waiting does not consume it. */
export class ExecutionBudget {
  private remaining: number;
  private started = performance.now();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(milliseconds: number, private expire: () => void) { this.remaining = milliseconds; this.resume(); }
  pause() {
    if (this.timer === undefined) return;
    clearTimeout(this.timer); this.timer = undefined;
    this.remaining -= performance.now() - this.started;
  }
  resume() {
    if (this.timer !== undefined) return;
    this.started = performance.now();
    this.timer = setTimeout(this.expire, Math.max(0, this.remaining));
  }
  dispose() { clearTimeout(this.timer); this.timer = undefined; }
}
