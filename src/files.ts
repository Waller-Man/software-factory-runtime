import { mkdir, readFile, writeFile, rename, readdir, realpath, lstat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RunRecord, RunEvent, RunRequest } from '@software-factory/contracts/runtime';
import { ensure } from './validation.ts';

export async function safeDirectory(root: string, path: string): Promise<string> {
  const base = await realpath(root);
  const rel = relative(base, resolve(path));
  ensure(rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel)), 'INVALID_PATH', '路径不属于当前任务');
  let current = base;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    try { await mkdir(current); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const info = await lstat(current);
    ensure(info.isDirectory() && !info.isSymbolicLink(), 'INVALID_PATH', '任务目录不能是链接');
  }
  return current;
}
export async function taskFile(root: string, path: string): Promise<string> {
  ensure(!isAbsolute(path) && !path.includes(':') && !path.includes('\0') && !path.split(/[\\/]/).includes('..'), 'INVALID_PATH', '必须使用任务内相对路径');
  const base = await realpath(root), target = resolve(base, path), rel = relative(base, target);
  ensure(!!rel && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel), 'INVALID_PATH', '文件不属于当前任务');
  let current = base;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    ensure(!(await lstat(current)).isSymbolicLink(), 'INVALID_PATH', '文件不能经过链接');
  }
  const info = await lstat(target);
  ensure(info.isFile(), 'INVALID_PATH', '需要真实文件');
  return target;
}
/** Read an existing directory under a workspace; never create it or follow links. */
export async function taskDirectory(root: string, path: string): Promise<string> {
  ensure(!isAbsolute(path) && !path.includes(':') && !path.includes('\0') && !path.split(/[\\/]/).includes('..'), 'INVALID_PATH', '必须使用工作区内相对目录');
  const base = await realpath(root), target = resolve(base, path), rel = relative(base, target);
  ensure(!!rel && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel), 'INVALID_PATH', '目录不属于当前工作区');
  let current = base;
  for (const part of rel.split(sep)) {
    current = join(current, part); const info = await lstat(current);
    ensure(info.isDirectory() && !info.isSymbolicLink(), 'INVALID_PATH', '任务目录不能经过链接');
  }
  return target;
}
export async function saveJson(path: string, data: unknown): Promise<void> {
  const temp = path + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
  await rename(temp, path);
}
export interface StoredRun { record: RunRecord; events: RunEvent[]; directory: string }
export async function createRunDirectory(workspace: string, runId: string, input: RunRequest): Promise<string> {
  const root = await safeDirectory(workspace, join(workspace, 'outputs/runs'));
  const directory = await safeDirectory(root, join(root, runId));
  for (const name of ['input', 'intermediate', 'snapshots', 'final', 'logs']) await safeDirectory(directory, join(directory, name));
  await saveJson(join(directory, 'input/request.json'), input);
  return directory;
}
export async function loadHistory(workspace: string): Promise<StoredRun[]> {
  const root = join(workspace, 'outputs/runs');
  try {
    for (const path of [join(workspace, 'outputs'), root]) {
      const info = await lstat(path);
      ensure(info.isDirectory() && !info.isSymbolicLink(), 'INVALID_PATH', '任务根目录不能是链接');
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const result: StoredRun[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
    const directory = join(root, entry.name);
    try {
      const file = await taskFile(directory, 'run.json');
      const stored = JSON.parse(await readFile(file, 'utf8')) as { record: RunRecord; events: RunEvent[] };
      ensure(stored.record.apiVersion === '1.0' && stored.record.runId === entry.name && Array.isArray(stored.events), 'INVALID_RECORD', '无效任务记录');
      result.push({ ...stored, directory });
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  return result;
}
