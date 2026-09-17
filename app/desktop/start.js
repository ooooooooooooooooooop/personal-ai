/**
 * Desktop launcher — strips a leaked ELECTRON_RUN_AS_NODE before starting the
 * real Electron binary. Some Electron-based tools export it into shells; left
 * in place it makes electron.exe boot as plain Node and the app dies silently.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

delete process.env.ELECTRON_RUN_AS_NODE;

const require = createRequire(import.meta.url);
const electronBin = require('electron'); // resolves to the dist binary path
const appDir = fileURLToPath(new URL('..', import.meta.url));

const r = spawnSync(electronBin, [join(appDir)], { stdio: 'inherit', env: process.env });
process.exit(r.status ?? 1);
