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
 *     [--append-system-prompt <text>]… [--append-system-prompt-file <path>]…
 *
 * Every stdout line is either:
 *   {"id":…,"type":"response","command":…,"success":…,"data"|"error":…}
 *   {"type":"event","event":{…}}   (agent session events, plain data)
 *   {"type":"audit","event":{…}}   (host audit events)
 */
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { startHost } from '../src/bootstrap/host.js';
import { makeDelegationCommand } from '../src/adapter/delegate.js';

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
// M76/M94-R3: when the template can branch on {target}, the operator names
// which resolved targets carry a real enforcement gate (repeatable or
// comma-separated). A template without {target} runs one fixed body, so the
// template text alone decides enforceability.
const delegateEnforceable = new Set(
  args
    .flatMap((a, i) => (args[i - 1] === '--delegate-enforceable-target' ? String(a).split(',') : []))
    .map((s) => s.trim())
    .filter(Boolean),
);

// dedup-h #2091 — --append-system-prompt <text> / --append-system-prompt-file
// <path> (both repeatable, order preserved across the two flags): extra
// operator prompt blocks appended after the instruction envelope. File
// contents are read HERE so an unreadable path fails loud at startup instead
// of silently degrading to the literal path string inside the loader.
const appendSystemPrompt = args
  .map((a, i) => ({ a, i }))
  .filter(({ a, i }) => i > 0 && (args[i - 1] === '--append-system-prompt' || args[i - 1] === '--append-system-prompt-file'))
  .map(({ a, i }) => {
    if (args[i - 1] === '--append-system-prompt-file') {
      const p = String(a);
      try {
        return readFileSync(p, 'utf-8');
      } catch (e) {
        process.stderr.write(`pai-channel: --append-system-prompt-file ${p}: ${e.message}\n`);
        process.exit(2);
      }
    }
    return String(a);
  });

// Planted-exe defense (Cline 4.1.19 analogue): on Windows, cmd.exe resolves
// bare commands through the current directory first — a checkout containing
// a planted npm.exe/git.exe would execute it on any `npm …` call. Setting
// NoDefaultCurrentDirectoryInExePath removes '.' from the CreateProcess
// search path for this process AND every child it spawns (jobs, delegate
// bridge, built-in bash tool — one stamp covers the whole tree).
if (process.platform === 'win32') {
  process.env.NoDefaultCurrentDirectoryInExePath ||= '1';
}

const host = await startHost({
  instanceRoot,
  workdir,
  // {model}/{effort}/{target}/{task} slots let an operator template consume
  // profile hints and branch per body; enforceability is asserted per
  // resolved target inside makeDelegationCommand.
  delegationCommand: delegateCmd
    ? makeDelegationCommand(delegateCmd, { enforceableTargets: delegateEnforceable })
    : null,
  appendSystemPrompt,
});

// Fatal-error forensics: Node's default for an unhandled rejection or
// exception is an opaque death — the stack prints to stderr and the process
// is gone. The supervisor persists the stderr tail into <instance>/crashes/
// (BODY_EXITED audit + crash report), so write the FULL stack to stderr
// first, dispose what we can, then exit non-zero. Fail closed with evidence;
// never limp on in a possibly-corrupt state.
for (const evt of ['uncaughtException', 'unhandledRejection']) {
  process.on(evt, (err) => {
    process.stderr.write(`pai-channel: FATAL ${evt}: ${err?.stack ?? err}\n`);
    try { host.dispose?.(); } catch { /* already dying */ }
    process.exit(1);
  });
}

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
  host.dispose?.();
  process.exit(0);
});
// A supervisor kills the channel with SIGTERM on body switch — release the
// writer lease so the acquiring body does not wait out the TTL.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    host.dispose?.();
    process.exit(0);
  });
}
