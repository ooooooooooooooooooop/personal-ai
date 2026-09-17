#!/usr/bin/env node
/**
 * Standalone dev entry — runs the supervisor + bridge without Electron and
 * serves the UI in a browser. Same code path the desktop shell uses.
 *
 *   node app/server/dev.js [--instance <dir>] [--workdir <dir>] [--port <n>]
 *
 * Defaults: instance ~/.personal-ai/instance, workdir = cwd, port 4173.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BodySupervisor } from './supervisor.js';
import { createHttpBridge } from './http-bridge.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const instanceRoot = opt('instance', join(homedir(), '.personal-ai', 'instance'));
const workdir = opt('workdir', process.cwd());
const port = Number(opt('port', 4173));

const supervisor = await new BodySupervisor({ instanceRoot, workdir, repoRoot: REPO_ROOT }).start();
const bridge = createHttpBridge({ supervisor });
const bound = await bridge.listen(port);
const url = `http://127.0.0.1:${bound}`;
process.stdout.write(`personal-ai app → ${url}\ninstance: ${instanceRoot}\nworkdir: ${workdir}\n`);

// Best-effort browser open; harmless if it fails (user can copy the URL).
try {
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', url], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
} catch { /* URL is printed; opening is a convenience */ }

process.on('SIGINT', async () => { await supervisor.dispose(); process.exit(0); });
process.on('SIGTERM', async () => { await supervisor.dispose(); process.exit(0); });
