/** Two focused checks: native persistence/live values, and the small settings form. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { boot, initProfile, readProfilePatches } from '@deepseek-ai/dsh-app-boot';
import ConfigEditor from '@deepseek-ai/dsh-config-editor';
import Settings from '@deepseek-ai/dsh-settings';
import Registry from '@deepseek-ai/dsh-typert-registry';
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit';
import Runtime from '../lib/index.js';
import { snapshotConfig } from '../lib/config.js';

test('native settings: defaults, save without restart, snapshot and persistence', async () => {
  await mkdir(resolve('test-results'), { recursive: true });
  const home = await mkdtemp(resolve('test-results/runtime-settings-')), dir = join(home, 'profile');
  initProfile(dir, ['runtime-settings-test']);
  const bundle = join(dir, 'node_modules/runtime-settings-test'); await mkdir(bundle, { recursive: true });
  await writeFile(join(home, 'package.json'), '{"name":"runtime-settings-test"}');
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'runtime-settings-test', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' }, { id: 'sf-runtime', name: 'cordis:runtime' },
  ] }]));
  await writeFile(join(dir, 'cordis.yml'), '[]\n');
  const profile = { name: 'test', startedBundles: ['runtime-settings-test'], dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [] };
  const start = () => boot('dsh', join(dir, 'cordis.yml'), readProfilePatches('dsh', profile as never), async ctx => {
    ctx.provide('profileContext', profile as never);
    ctx.provide('appReady', { onReady: listener => { listener(); return () => {}; } } as never);
    await mountAgentLoopTestDependencies(ctx); await ctx.plugin(Registry);
    Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, runtime: Runtime });
  });
  const ctx = await start();
  try {
    const entry = [...ctx.loader.entries()].find(item => item.options.id === 'sf-runtime')!, fiber = entry.fiber!;
    const before = snapshotConfig(fiber.config as never);
    assert.deepEqual(before, { defaultTimeoutMs: 3600000, modelTimeoutMs: 480000 });
    const descriptor = ctx.settings.describe().find(item => item.ns === 'sf-runtime')!;
    assert.equal(descriptor.autoGenerate, false);
    await ctx.settings.mutate('sf-runtime', [{ op: 'set', path: ['modelTimeoutMs'], value: 240000 }], descriptor.revision);
    assert.equal(entry.fiber, fiber, 'Saving must not restart or cancel Runtime');
    assert.equal(snapshotConfig(fiber.config as never).modelTimeoutMs, 240000);
    assert.equal(before.modelTimeoutMs, 480000, 'Existing task snapshots retain their original value');
    assert.match(await readFile(profile.patchPath, 'utf8'), /240000/);
  } finally { await ctx.fiber.dispose(); }
  const restarted = await start();
  try { assert.equal(restarted.settings.describe().find(item => item.ns === 'sf-runtime')!.value.modelTimeoutMs, 240000); }
  finally { await restarted.fiber.dispose(); }
});

test('configuration form: minute defaults, save in milliseconds and discard', async () => {
  const host = resolve(process.env.DSH_SOURCE ?? '../DSH-Softwarefactory');
  const hostRequire = createRequire(join(host, 'package.json')), uiRequire = createRequire(join(host, 'packages/client/ui-primitives/package.json'));
  const { JSDOM } = hostRequire('jsdom'), dom = new JSDOM('<!doctype html><div id="root"></div>');
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const React = uiRequire('react'), { createRoot } = uiRequire('react-dom/client'), root = createRoot(dom.window.document.getElementById('root'));
  let state = { status: 'ready', writable: true, revision: 1, value: { defaultTimeoutMs: 3600000, modelTimeoutMs: 480000 } };
  const listeners = new Set<() => void>(); let registration: any, Component: any, dictionaries: any, artifact: any, saves = 0;
  const scope = { getSnapshot: () => state, subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    async mutate(ops: any[], revision: number) { assert.equal(revision, state.revision); saves++; const value = { ...state.value }; for (const op of ops) value[op.path[0] as keyof typeof value] = op.value; state = { ...state, revision: revision + 1, value }; listeners.forEach(fn => fn()); return true; } };
  try {
    runInNewContext(await readFile(resolve('packages/runtime/client.js'), 'utf8'), { window: { __ModuleLoader__: { load: (item: any) => { artifact = item; } } } });
    artifact.factory(uiRequire).apply({ effect: (fn: Function) => fn(), locale: { register: (_ns: string, data: any) => { dictionaries = data; } },
      configForms: { get: (id: string) => { assert.equal(id, 'sf-runtime'); return scope; } },
      slots: { inject: (_name: string, fn: Function) => fn(), register: (options: any, view: any) => { registration = options; Component = view; } } });
    assert.equal(registration.key, '@software-factory/runtime');
    await React.act(async () => root.render(React.createElement(Component, { scope, t: (key: string) => dictionaries.zh[key] })));
    const input = (name: string) => dom.window.document.querySelector(`input[name="${name}"]`);
    const edit = async (name: string, value: string) => React.act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input(name), value); input(name).dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    assert.equal(input('defaultTimeoutMs').value, '60'); assert.equal(input('modelTimeoutMs').value, '8');
    await edit('modelTimeoutMs', '4');
    await React.act(async () => dom.window.document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(saves, 1); assert.equal(state.value.modelTimeoutMs, 240000); assert.match(dom.window.document.body.textContent, /已保存/);
    await edit('modelTimeoutMs', '0');
    await React.act(async () => dom.window.document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(saves, 1); assert.match(dom.window.document.body.textContent, /请输入/);
    await React.act(async () => dom.window.document.querySelector('button[type="button"]').click());
    assert.equal(input('modelTimeoutMs').value, '4');
  } finally {
    await React.act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
