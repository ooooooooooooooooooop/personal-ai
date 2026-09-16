#!/usr/bin/env node
/**
 * delegate-bridge — the real producer side of delegation usage attribution.
 *
 * Usage:  node delegate-bridge.js --target <name> -- <delegated shell command>
 *
 * Spawns the delegated command as a real subprocess, streams its output
 * through, measures wall time and output volume, forwards any usage the child
 * itself reported (a nested `PAI_USAGE {json}` line or a trailing
 * `usage {...}` JSON object), then emits ONE authoritative
 * `PAI_USAGE {json}` line on stdout. The host JobExecutor parses that line
 * into the result envelope and JOB_FINISHED audit under parent_run_id —
 * delegated work bills to the parent run identity.
 *
 * Emitted usage shape:
 *   { via:'delegate-bridge', target, wallMs, outputBytes, exitCode,
 *     childUsage: <object|null> }
 * childUsage carries token/cost when the delegate reports it; measured fields
 * are always real — never synthesized.
 */
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep === -1 || sep === argv.length - 1) {
  console.error('delegate-bridge: expected "-- <command>"');
  process.exit(2);
}
const tIdx = argv.indexOf('--target');
const target = tIdx !== -1 ? argv[tIdx + 1] : 'unknown';
// re-quote args that lost their shell quoting through argv — whitespace must
// survive the shell:true respawn as one token
const command = argv.slice(sep + 1)
  .map((a) => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
  .join(' ');

const started = Date.now();
const child = spawn(command, { windowsHide: true, shell: true });
let out = '';
let outputBytes = 0;
child.stdout.on('data', (d) => { out += d; outputBytes += d.length; });
child.stderr.on('data', (d) => { out += d; outputBytes += d.length; });

child.on('error', (e) => {
  console.log(`PAI_USAGE ${JSON.stringify({
    via: 'delegate-bridge', target, wallMs: Date.now() - started,
    outputBytes, exitCode: null, childUsage: null, error: e.message,
  })}`);
  process.exit(1);
});

child.on('exit', (code) => {
  // child's own usage report wins the detail slot; ours is the envelope
  const nested = out.match(/PAI_USAGE (\{[^\n]*\})/);
  const loose = out.match(/usage[=: ]+(\{[^\n]*\})/i);
  let childUsage = null;
  for (const m of [nested, loose]) {
    if (m) { try { childUsage = JSON.parse(m[1]); break; } catch { /* keep null */ } }
  }
  // strip the child's own marker lines — the bridge's single authoritative
  // PAI_USAGE envelope carries them nested under childUsage instead, so the
  // executor's first-match parse sees exactly one producer record
  process.stdout.write(out.split('\n').filter((l) => !/PAI_USAGE \{/.test(l)).join('\n'));
  console.log(`PAI_USAGE ${JSON.stringify({
    via: 'delegate-bridge', target, wallMs: Date.now() - started,
    outputBytes, exitCode: code, childUsage,
  })}`);
  process.exit(code ?? 1);
});
