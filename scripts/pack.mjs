/** Build first; package only declared files, never a profile or real task workspace. */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { runtime, sdk, root, hostRequire } from './dev.mjs';
import { readTgz, createZip } from '../../gateway/scripts/archive.mjs';

const runtimeRequire = createRequire(join(runtime, 'package.json'));
let notices = '# Bundled dependencies\n\nZod powers validation and Remote codecs. ipaddr.js and Undici handle bounded public image downloads.\n';
for (const [name, resolvePackage] of [['zod', hostRequire], ['ipaddr.js', runtimeRequire], ['undici', runtimeRequire]]) {
  const license = await readFile(join(dirname(resolvePackage.resolve(name + '/package.json')), 'LICENSE'), 'utf8');
  notices += '\n## ' + name + '\n\n' + license + '\n';
}
await writeFile(join(runtime, 'THIRD_PARTY_NOTICES.md'), notices.trimEnd() + '\n');
for (const packageDir of [sdk, runtime]) {
  const artifacts = join(packageDir, 'artifacts'); await mkdir(artifacts, { recursive: true });
  await mkdir(join(packageDir, 'docs'), { recursive: true });
  await copyFile(join(root, 'docs/interfaces/runtime.md'), join(packageDir, 'docs/runtime-api.md'));
  const executable = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd pack --ignore-scripts --json --pack-destination artifacts'] : ['pack', '--ignore-scripts', '--json', '--pack-destination', 'artifacts'];
  const packed = spawnSync(executable, args, { cwd: packageDir, encoding: 'utf8', windowsHide: true, env: { ...process.env, npm_config_cache: join(artifacts, 'npm-cache') } });
  if (packed.status !== 0) throw new Error(packed.stderr || 'npm pack failed');
  const meta = JSON.parse(packed.stdout)[0];
  const entries = readTgz(await readFile(join(artifacts, meta.filename))), files = entries.map(e => e.name);
  for (const file of files) if (/(^|\/)(node_modules|artifacts|tests?|src)(\/|$)|(^|\/)\.env(?:\.|$)|\.tsbuildinfo$/.test(file)) throw new Error('Unexpected package file: ' + file);
  for (const file of ['package.json', 'README.md', 'docs/runtime-api.md', 'lib/index.js', 'lib/index.d.ts', 'lib/contracts/runtime.d.ts']) if (!files.includes(file)) throw new Error('Missing ' + file);
  for (const entry of entries.filter(e => e.name.endsWith('.d.ts'))) {
    const source = entry.data.toString('utf8');
    if (source.includes('@software-factory/contracts/')) throw new Error('Unpublished contract dependency in ' + entry.name);
    for (const match of source.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)) {
      const imported = posix.normalize(posix.join(posix.dirname(entry.name), match[1])).replace(/\.js$/, '.d.ts');
      if (!files.includes(imported)) throw new Error('Broken declaration import: ' + entry.name + ' -> ' + imported);
    }
  }
  const manifest = JSON.parse(entries.find(e => e.name === 'package.json').data.toString('utf8'));
  const prefix = packageDir === sdk ? 'software-factory-runtime-sdk' : 'software-factory-runtime';
  const zip = createZip(entries.map(e => ({ ...e, name: prefix + '/' + e.name })));
  const zipName = prefix + '-' + manifest.version + '.zip'; await writeFile(join(artifacts, zipName), zip);
  // Extract the verified entries for a normal local-directory DSH install or SDK inspection.
  const release = join(artifacts, 'release', prefix);
  for (const entry of entries) { const target = join(release, entry.name); await mkdir(dirname(target), { recursive: true }); await writeFile(target, entry.data); }
  const report = { version: manifest.version, tgz: meta.filename, zip: zipName, zipSha256: createHash('sha256').update(zip).digest('hex'), files, standaloneDeclarations: true, frontendIncluded: false };
  await writeFile(join(artifacts, 'package-check.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ package: manifest.name, tgz: meta.filename, zip: zipName, fileCount: files.length, declarationCheck: 'passed' }));
}
