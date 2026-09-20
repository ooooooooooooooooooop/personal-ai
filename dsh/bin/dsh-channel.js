#!/usr/bin/env node
/**
 * dsh-channel — the Personal AI host channel over a DSH web-profile server.
 *
 * Same JSONL framing as pi/bin/pai-channel.js (LF-delimited records on
 * stdin/stdout): the supervisor talks the host protocol; the body underneath
 * is DSH's own web runtime.
 *
 * Usage:
 *   node dsh/bin/dsh-channel.js --instance <instanceRoot> [--workdir <dir>]
 *     [--dsh-bin <path to dsh lib/bin.js>] [--port <port>]
 *
 * Boot sequence:
 *   1. resolve the managed dsh CLI (DSH_CLI env → --dsh-bin → PATH probe is the
 *      app catalog's job; here --dsh-bin or DSH_CLI is required)
 *   2. spawn `node <dshBin> --profile web --host 127.0.0.1 --port <p> --no-open`
 *   3. poll host.describe until the server is ready (or fail closed)
 *   4. session.create {cwd} → serve the channel over stdio
 */
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createTypertClient } from '../adapter/typert.js';
import { createDshChannel } from '../adapter/channel.js';
import { DshBody } from '../adapter/index.js';
import { AuditWriter } from '../../host/src/core/audit.js';
import { instancePaths } from '../../host/src/core/instance.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const workdir = opt('workdir', process.cwd());
const dshBin = opt('dsh-bin', process.env.DSH_CLI ?? null);
const readyTimeoutMs = Number(opt('ready-timeout', '60000'));
const instanceRoot = opt('instance', null);

if (!dshBin) {
  process.stderr.write('dsh-channel: --dsh-bin <dsh lib/bin.js> or DSH_CLI required\n');
  process.exit(2);
}

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(client, deadline) {
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      return await client.call('host.describe', {});
    } catch (e) {
      lastErr = e;
      await sleep(400);
    }
  }
  throw new Error(`dsh web server did not become ready: ${lastErr?.message ?? lastErr}`);
}

const port = Number(opt('port', '0')) || await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [
  dshBin, '--profile', 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open',
], { stdio: ['ignore', 'inherit', 'inherit'] });

const shutdown = (code = 0) => {
  try { child.kill(); } catch { /* already gone */ }
  process.exit(code);
};
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
child.on('exit', (code) => {
  process.stderr.write(`dsh-channel: dsh web exited (${code})\n`);
  shutdown(code ?? 1);
});

const client = createTypertClient({ baseUrl });
await waitReady(client, Date.now() + readyTimeoutMs).catch((e) => {
  process.stderr.write(`dsh-channel: ${e.message}\n`);
  shutdown(1);
});

const created = await client.call('session.create', { cwd: workdir }).catch((e) => {
  process.stderr.write(`dsh-channel: session.create failed: ${e.message}\n`);
  shutdown(1);
});

const facts = new DshBody({ runId: 'channel', dshCli: dshBin }).facts();
// D3: DSH tool calls / operator asks land in the canonical audit stream —
// the body's own runtime executes them, but the instance's audit record is
// the single evidence trail both bodies write into.
const audit = instanceRoot
  ? new AuditWriter(instancePaths(instanceRoot), { annotations: { body: 'dsh' } })
  : null;
const { channel, dispose } = createDshChannel({
  client,
  sessionId: created.sessionId,
  cwd: workdir,
  facts,
  audit,
});

const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
channel.subscribe(write);

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let cmd;
  try {
    cmd = JSON.parse(trimmed);
  } catch {
    write({ type: 'response', success: false, error: 'invalid JSON' });
    return;
  }
  write(await channel.handle(cmd));
});
rl.on('close', () => {
  dispose();
  shutdown(0);
});
