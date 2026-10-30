import { spawnSync } from 'node:child_process';
import { root, hostRequire, prepare } from './dev.mjs';
await prepare();
const check = spawnSync(process.execPath, [hostRequire.resolve('typescript/bin/tsc'), '-b', 'packages/contracts', 'packages/runtime-sdk', 'packages/runtime', '--pretty', 'false'], { cwd: root, stdio: 'inherit', windowsHide: true });
process.exitCode = check.status ?? 1;
