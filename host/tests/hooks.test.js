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
