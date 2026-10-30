import { join } from 'node:path';
import { createRequire } from 'node:module';
import { mkdir, lstat, realpath, symlink, cp, readFile, writeFile } from 'node:fs/promises';
import { root, host, hostRequire, prepare as prepareHost } from '../../gateway/scripts/dev.mjs';
export { root, host, hostRequire };
export const runtime = join(root, 'packages/runtime');
export const sdk = join(root, 'packages/runtime-sdk');
export async function prepare() {
  await prepareHost();
  const imageRequire = createRequire(join(host, 'packages/web/web-fetch-http/package.json'));
  for (const name of ['ipaddr.js', 'undici']) {
    const target = join(root, 'node_modules', name);
    const source = await realpath(join(imageRequire.resolve(name + '/package.json'), '..'));
    await mkdir(join(root, 'node_modules'), { recursive: true });
    try {
      await lstat(target);
      if ((await realpath(target)).toLowerCase() !== source.toLowerCase()
        && (await readFile(join(target, '.sf-runtime-source'), 'utf8')).trim() !== source) throw new Error('Dependency target differs: ' + name);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (linkError) {
        if (linkError.code !== 'EPERM') throw linkError;
        await cp(source, target, { recursive: true });
        await writeFile(join(target, '.sf-runtime-source'), source);
      }
    }
  }
}
