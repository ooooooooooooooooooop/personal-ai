import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookRunner } from '../src/core/hooks.js';

function dir() { return mkdtempSync(join(tmpdir(), 'pai-hooks-')); }
function cfg(workdir, doc) {
  mkdirSync(join(workdir, '.pai'), { recursive: true });
  writeFileSync(join(workdir, '.pai', 'hooks.json'), JSON.stringify(doc));
}
function fakeAudit() {
  const events = [];
  return { events, write: (e) => events.push(e) };
}

test('absent config → no-op runner', async () => {
  const w = dir();
  const h = new HookRunner(w);
  assert.deepEqual(h.events, []);
  assert.equal(await h.fire('session_start'), 0);
});

test('unknown event name refuses at load (typo must be loud)', () => {
  const w = dir();
  cfg(w, { hooks: { promt_submit: [{ command: 'echo hi' }] } });
  assert.throws(() => new HookRunner(w), /unknown lifecycle event/);
});

test('hook receives event payload on stdin and env; audit trail written', async () => {
  const w = dir();
  const audit = fakeAudit();
  const outFile = join(w, 'hook-out.json');
  // node script writes stdin payload + env marker to a file
  const script = join(w, 'hook.js');
  writeFileSync(script, `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{require('fs').writeFileSync(${JSON.stringify(outFile)},d+'|'+process.env.PAI_HOOK_EVENT);});`);
  cfg(w, { hooks: { prompt_submit: [{ command: `node ${JSON.stringify(script)}` }] } });

  const h = new HookRunner(w, { audit });
  const ran = await h.fire('prompt_submit', { preview: 'hello' });
  assert.equal(ran, 1);
  const body = readFileSync(outFile, 'utf-8');
  assert.match(body, /"preview":"hello"/);
  assert.ok(body.endsWith('|prompt_submit'));
  assert.ok(audit.events.some((e) => e.kind === 'HOOK_FIRE'));
  assert.ok(audit.events.some((e) => e.kind === 'HOOK_RESULT' && e.data.exitCode === 0));
});

test('failing hook audits error/result but never throws into the lifecycle', async () => {
  const w = dir();
  const audit = fakeAudit();
  cfg(w, { hooks: { tool_end: [{ command: 'exit 3' }] } });
  const h = new HookRunner(w, { audit });
  const ran = await h.fire('tool_end', { toolName: 'write' });
  assert.equal(ran, 1);
  const res = audit.events.find((e) => e.kind === 'HOOK_RESULT');
  assert.equal(res.data.exitCode, 3);
});

test('timeout kills a hung hook; close() kills in-flight', async () => {
  const w = dir();
  cfg(w, { hooks: { session_start: [{ command: 'node -e "setTimeout(()=>{},60000)"', timeoutMs: 300 }] } });
  const audit = fakeAudit();
  const h = new HookRunner(w, { audit });
  await h.fire('session_start');
  assert.ok(audit.events.some((e) => e.kind === 'HOOK_ERROR' && /timed out/.test(e.data.error)));
  h.close();
});

/* ---- gate mode: operator-private pre_tool veto ---- */

test('non-gate runner refuses pre_tool at load (agent cannot veto itself)', () => {
  const w = dir();
  cfg(w, { hooks: { pre_tool: [{ command: 'echo no' }] } });
  assert.throws(() => new HookRunner(w), /unknown lifecycle event/);
});

test('gate: absent file → allow; exit≠0 → deny; {"deny"} JSON → deny with reason', async () => {
  const w = dir();
  const gateFile = join(w, 'gate-hooks.json');
  const audit = fakeAudit();
  const g = new HookRunner(w, { audit, configPath: gateFile, gate: true });
  assert.equal(await g.fireGate('pre_tool', { tool: 'bash' }), null); // absent file

  writeFileSync(gateFile, JSON.stringify({ hooks: { pre_tool: [{ command: 'exit 3' }] } }));
  const d1 = await g.fireGate('pre_tool', { tool: 'bash' });
  assert.match(d1.deny, /exited 3/);

  const script = join(w, 'veto.js');
  writeFileSync(script, `process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({deny:'no prod deploys'}))});`);
  writeFileSync(gateFile, JSON.stringify({ hooks: { pre_tool: [{ command: `node ${JSON.stringify(script)}` }] } }));
  const d2 = await g.fireGate('pre_tool', { tool: 'bash' });
  assert.equal(d2.deny, 'no prod deploys');
  assert.ok(audit.events.some((e) => e.kind === 'HOOK_RESULT' && e.data.gate));
});

test('gate: match prefix filters tools; exit 0 → allow; broken hook fails closed', async () => {
  const w = dir();
  const gateFile = join(w, 'gate-hooks.json');
  writeFileSync(gateFile, JSON.stringify({
    hooks: { pre_tool: [{ command: 'exit 9', match: 'bash' }] },
  }));
  const g = new HookRunner(w, { configPath: gateFile, gate: true });
  assert.equal(await g.fireGate('pre_tool', { tool: 'read' }), null);   // filtered out
  assert.match((await g.fireGate('pre_tool', { tool: 'bash' })).deny, /exited 9/);

  writeFileSync(gateFile, JSON.stringify({
    hooks: { pre_tool: [{ command: 'echo ok', timeoutMs: 5000 }] },
  }));
  assert.equal(await g.fireGate('pre_tool', { tool: 'bash' }), null);   // allow

  // live re-read: edit lands without reconstructing the runner; a command
  // the shell can't resolve exits non-zero → deny (fail-closed either way)
  writeFileSync(gateFile, JSON.stringify({
    hooks: { pre_tool: [{ command: 'definitely-not-a-real-binary-xyz', timeoutMs: 5000 }] },
  }));
  const d = await g.fireGate('pre_tool', { tool: 'bash' });
  assert.ok(d.deny);
});

test('fireGate on a non-gate runner throws', async () => {
  const h = new HookRunner(dir());
  await assert.rejects(() => h.fireGate('pre_tool', {}), /non-gate/);
});

test('expanded event family: tool_start/agent_stop/compact_* accepted at load', () => {
  const w = dir();
  cfg(w, { hooks: {
    tool_start: [{ command: 'echo ts' }],
    agent_stop: [{ command: 'echo as' }],
    compact_start: [{ command: 'echo cs' }],
    compact_end: [{ command: 'echo ce' }],
  } });
  const h = new HookRunner(w);
  assert.deepEqual(h.events.sort(), ['agent_stop', 'compact_end', 'compact_start', 'tool_start']);
});
