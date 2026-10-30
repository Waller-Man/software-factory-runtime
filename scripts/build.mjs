import { mkdir, cp, copyFile, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { root, host, hostRequire, runtime, sdk, prepare } from './dev.mjs';
await prepare();
const compile = spawnSync(process.execPath, [hostRequire.resolve('typescript/bin/tsc'), '-b', 'packages/contracts', 'packages/runtime-sdk', 'packages/runtime', '--pretty', 'false'], { cwd: root, stdio: 'inherit', windowsHide: true });
if (compile.status !== 0) process.exit(compile.status ?? 1);
const stage = join(runtime, 'artifacts/analysis');
for (const name of ['contracts', 'runtime-sdk', 'runtime']) {
  const to = join(stage, 'packages', name); await mkdir(to, { recursive: true });
  await cp(join(root, 'packages', name, 'src'), join(to, 'src'), { recursive: true });
  for (const file of ['package.json', 'tsconfig.json']) await copyFile(join(root, 'packages', name, file), join(to, file));
}
const protocol = join(stage, 'packages/protocol'); await mkdir(protocol, { recursive: true });
await cp(join(host, 'packages/typert/protocol/src'), join(protocol, 'src'), { recursive: true });
await copyFile(join(host, 'packages/typert/protocol/package.json'), join(protocol, 'package.json'));
await writeFile(join(protocol, 'tsconfig.json'), JSON.stringify({ include: ['src/**/*.ts'] }));
await writeFile(join(stage, 'tsconfig.host.json'), JSON.stringify({ files: [], references: ['contracts', 'runtime-sdk', 'runtime', 'protocol'].map(name => ({ path: 'packages/' + name })), compilerOptions: { target: 'ES2024', module: 'ESNext', moduleResolution: 'Bundler', strict: true, skipLibCheck: true, baseUrl: '.', paths: { '@deepseek-ai/dsh-typert-protocol': ['packages/protocol/src/index.ts'], '@software-factory/contracts/runtime': ['packages/contracts/src/runtime.ts'], '@software-factory/runtime-sdk': ['packages/runtime-sdk/src/index.ts'] }, ignoreDeprecations: '6.0' } }));
// The analyzer requires a nonempty consumer program; this is type-only, no UI code.
await writeFile(join(stage, 'tsconfig.client.json'), JSON.stringify({ files: ['packages/contracts/src/runtime.ts'] }));
const { WorkspaceTypertGenerator } = await import('@deepseek-ai/dsh-typert-generator');
const outputs = new WorkspaceTypertGenerator(stage, { checkDiagnostics: false }).generate(['@software-factory/runtime'], ['host']);
if (outputs.length !== 1 || !outputs[0].remote) throw new Error('Missing Runtime strict Remote descriptors');
for (const output of outputs) {
  await writeFile(join(stage, 'typert.host.js'), output.js); await writeFile(join(runtime, 'lib/typert.host.d.ts'), output.dts);
  await writeFile(join(stage, 'typert.remote-client.js'), output.remote.js); await writeFile(join(runtime, 'lib/typert.remote-client.d.ts'), output.remote.dts);
}
const { build } = await import(pathToFileURL(hostRequire.resolve('tsdown'))), ts = hostRequire('typescript');
const decorators = { name: 'runtime-standard-decorators', transform(code, id) { if (!id.endsWith('.ts') || !/^\s*@/m.test(code)) return; return { code: ts.transpileModule(code, { fileName: id, compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext } }).outputText, map: null }; } };
await build({ config: false, entry: { index: join(sdk, 'src/index.ts') }, outDir: join(sdk, 'lib'), platform: 'node', format: 'esm', clean: false, dts: false, deps: { neverBundle: [/^@deepseek-ai\//] }, outputOptions: { entryFileNames: 'index.js' } });
for (const dir of [sdk, runtime]) {
  await mkdir(join(dir, 'lib/contracts'), { recursive: true });
  for (const file of ['runtime.js', 'runtime.d.ts']) await copyFile(join(root, 'packages/contracts/lib', file), join(dir, 'lib/contracts', file));
}
await mkdir(join(runtime, 'lib/sdk'), { recursive: true });
for (const file of ['index.d.ts', 'index.js']) await copyFile(join(sdk, 'lib', file), join(runtime, 'lib/sdk', file));
// SDK declarations may already have been rewritten by a previous incremental build.
const copiedSdk = join(runtime, 'lib/sdk/index.d.ts');
await writeFile(copiedSdk, (await readFile(copiedSdk, 'utf8')).replaceAll("'./contracts/runtime.js'", "'../contracts/runtime.js'"));
async function declarations(dir, packageRoot) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name); if (entry.isDirectory()) { await declarations(path, packageRoot); continue; }
    if (!entry.name.endsWith('.d.ts')) continue;
    let source = await readFile(path, 'utf8');
    for (const [name, target] of [['@software-factory/contracts/runtime', join(packageRoot, 'lib/contracts/runtime.js')], ['@software-factory/runtime-sdk', join(packageRoot, 'lib/sdk/index.js')]]) {
      let to = relative(dirname(path), target).replaceAll('\\', '/'); if (!to.startsWith('.')) to = './' + to; source = source.replaceAll(name, to);
    }
    await writeFile(path, source.replace(/(from ['"]\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1.js$2'));
  }
}
for (const dir of [sdk, runtime]) await declarations(join(dir, 'lib'), dir);
for (const entry of ['typert.host', 'typert.remote-client']) await build({ config: false, entry: { [entry]: join(stage, entry + '.js') }, outDir: join(runtime, 'lib'), platform: 'neutral', format: 'esm', clean: false, dts: false, deps: { onlyBundle: ['zod'] }, outputOptions: { entryFileNames: entry + '.js' } });
await build({ config: false, entry: { index: join(runtime, 'src/index.ts') }, outDir: join(runtime, 'lib'), platform: 'node', format: 'esm', clean: false, dts: false, deps: { onlyBundle: ['zod', 'ipaddr.js', 'undici'], neverBundle: [/^@deepseek-ai\//] }, plugins: [decorators], outputOptions: { entryFileNames: 'index.js' } });
console.log('Built Runtime backend, strict Remote descriptors and standalone TypeScript SDK. No frontend built.');
