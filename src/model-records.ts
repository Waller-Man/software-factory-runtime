import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ModelCallRecord, ModelCallSummary, ModelRef, ModelProtocol, RunJson } from '@software-factory/contracts/runtime';
import { safeDirectory, saveJson } from './files.ts';
import { failure } from './validation.ts';

/** Keep request structure without duplicating binary image payloads in JSON logs. */
export function modelLogValue(input: RunJson): RunJson {
  if (typeof input === 'string') return /^data:image\//i.test(input) ? '[inline image omitted]' : input;
  if (Array.isArray(input)) return input.map(modelLogValue);
  if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, value]) =>
    [key, key === 'data' && input.type === 'base64' ? '[inline image omitted]' : modelLogValue(value)]));
  return input;
}

export async function recordModelCall<T>(directory: string, model: ModelRef, stage: string | undefined,
  protocol: ModelProtocol | 'sdk', input: RunJson, signal: AbortSignal,
  update: (summary: ModelCallSummary) => Promise<void>,
  work: (record: ModelCallRecord) => Promise<T>): Promise<T> {
  const started = Date.now();
  const record: ModelCallRecord = { requestId: randomUUID(), model: { ...model }, protocol,
    ...(stage ? { stage } : {}), status: 'running', startedAt: new Date(started).toISOString(), request: modelLogValue(input) };
  const folder = await safeDirectory(directory, join(directory, 'logs/model-calls'));
  const file = join(folder, record.requestId + '.json');
  const publish = async () => {
    await saveJson(file, record);
    const { request: _request, response: _response, transcript: _transcript, ...summary } = record;
    await update(summary);
  };
  await publish();
  try { const value = await work(record); record.status = 'completed'; return value; }
  catch (error) { record.status = signal.aborted ? 'cancelled' : 'failed'; record.error = failure(error); throw error; }
  finally { record.finishedAt = new Date().toISOString(); record.durationMs = Date.now() - started; await publish(); }
}
