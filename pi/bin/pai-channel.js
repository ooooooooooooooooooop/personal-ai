#!/usr/bin/env node
/**
 * pai-channel — the Personal AI host channel process.
 *
 * JSONL over stdin/stdout, same framing discipline as `pi --mode rpc`
 * (LF-delimited records). A UI spawns THIS process and talks the host
 * protocol — the body underneath is replaceable; the protocol is not.
 *
 * Usage:
 *   node pi/bin/pai-channel.js --instance <instanceRoot> [--workdir <dir>]
 *     [--delegate-command <shell-template>]
 *
 * Every stdout line is either:
 *   {"id":…,"type":"response","command":…,"success":…,"data"|"error":…}
 *   {"type":"event","event":{…}}   (agent session events, plain data)
 *   {"type":"audit","event":{…}}   (host audit events)
 */
import { createInterface } from 'node:readline';
import { startHost } from '../src/bootstrap/host.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const instanceRoot = opt('instance', null);
if (!instanceRoot) {
  process.stderr.write('pai-channel: --instance <instanceRoot> required\n');
  process.exit(2);
}
const workdir = opt('workdir', process.cwd());
const delegateCmd = opt('delegate-command', null);

const host = await startHost({
  instanceRoot,
  workdir,
  delegationCommand: delegateCmd
    ? (target, task) => delegateCmd.replaceAll('{target}', target).replaceAll('{task}', task.replaceAll('"', '\\"'))
    : null,
});

const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
host.channel.subscribe(write);

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
  write(await host.channel.handle(cmd));
});
rl.on('close', () => {
  host.channel.dispose();
  process.exit(0);
});
