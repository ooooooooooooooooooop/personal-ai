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

test('unknown event name: gate refuses loud; observational audits + skips (agent-reachable file must not brick bootstrap)', () => {
  const w = dir();
  cfg(w, { hooks: { promt_submit: [{ command: 'echo hi' }], session_start: [{ command: 'echo ok' }] } });
  // gate (operator-private) stays loud
  assert.throws(() => new HookRunner(w, { gate: true }), /unknown lifecycle event/);
  // observational: no throw, bad event rejected, valid event kept
  const audit = fakeAudit();
  const h = new HookRunner(w, { audit });
  assert.deepEqual(h.events, ['session_start']);
  const err = audit.events.find((e) => e.kind === 'HOOK_CONFIG_ERROR');
  assert.deepEqual(err.data.rejectedEvents, ['promt_submit']);
});

test('observational malformed JSON is audited and skipped, never thrown', async () => {
  const w = dir();
  mkdirSync(join(w, '.pai'), { recursive: true });
  writeFileSync(join(w, '.pai', 'hooks.json'), '{ not json');
  const audit = fakeAudit();
  const h = new HookRunner(w, { audit });
  assert.deepEqual(h.events, []);
  assert.equal(await h.fire('session_start'), 0);
  assert.ok(audit.events.some((e) => e.kind === 'HOOK_CONFIG_ERROR' && e.data.ignored));
  // gate mode with the same file still throws loud
  assert.throws(() => new HookRunner(w, { gate: true, configPath: join(w, '.pai', 'hooks.json') }));
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

test('non-gate runner rejects pre_tool entries with audit (agent cannot veto itself)', () => {
  const w = dir();
  cfg(w, { hooks: { pre_tool: [{ command: 'echo no' }] } });
  const audit = fakeAudit();
  const h = new HookRunner(w, { audit });
  assert.deepEqual(h.events, []); // pre_tool never registered on a non-gate runner
  const err = audit.events.find((e) => e.kind === 'HOOK_CONFIG_ERROR');
  assert.deepEqual(err.data.rejectedEvents, ['pre_tool']);
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

test('gate: {"requireApproval":"q"} structured output escalates instead of deny/allow', async () => {
  const w = dir();
  const gateFile = join(w, 'gate-hooks.json');
  const script = join(w, 'ask.js');
  writeFileSync(script, `process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({requireApproval:'deploy to prod?'}))});`);
  writeFileSync(gateFile, JSON.stringify({ hooks: { pre_tool: [{ command: `node ${JSON.stringify(script)}` }] } }));
  const g = new HookRunner(w, { configPath: gateFile, gate: true });
  const r = await g.fireGate('pre_tool', { tool: 'bash' });
  assert.equal(r.deny, undefined);
  assert.equal(r.requireApproval, 'deploy to prod?');
  // a hook can never mint approval — there is no approve branch by design
});

test('fireGate on a non-gate runner throws', async () => {
  const h = new HookRunner(dir());
  await assert.rejects(() => h.fireGate('pre_tool', {}), /non-gate/);
});

test('observational hooks get a scrubbed env; gate hooks keep the full env', async () => {
  const w = dir();
  const outFile = join(w, 'env-out.json');
  const script = join(w, 'dump-env.js');
  writeFileSync(script, `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{require('fs').writeFileSync(${JSON.stringify(outFile)},JSON.stringify({k:process.env.FAKE_PROVIDER_API_KEY??null,t:process.env.GH_TOKEN??null,p:process.env.PAI_PLAIN??null,g:process.env.GIT_AUTHOR_NAME??null}));});`);
  const env = {
    ...process.env,
    FAKE_PROVIDER_API_KEY: 'sk-secret',
    GH_TOKEN: 'ghp_secret',
    PAI_PLAIN: 'visible',
    GIT_AUTHOR_NAME: 'Operator',
  };

  cfg(w, { hooks: { prompt_submit: [{ command: `node ${JSON.stringify(script)}` }] } });
  const h = new HookRunner(w, { env });
  await h.fire('prompt_submit');
  const seen = JSON.parse(readFileSync(outFile, 'utf-8'));
  assert.equal(seen.k, null);        // *_KEY scrubbed — no credential exfil channel
  assert.equal(seen.t, null);        // *TOKEN scrubbed
  assert.equal(seen.p, 'visible');   // ordinary vars pass through
  assert.equal(seen.g, 'Operator');  // GIT_AUTHOR_* is not a secret — survives

  const gateFile = join(w, 'gate-hooks.json');
  writeFileSync(gateFile, JSON.stringify({ hooks: { pre_tool: [{ command: `node ${JSON.stringify(script)}` }] } }));
  const g = new HookRunner(w, { env, configPath: gateFile, gate: true });
  assert.equal(await g.fireGate('pre_tool', { tool: 'bash' }), null); // exit 0 → allow
  const gateSeen = JSON.parse(readFileSync(outFile, 'utf-8'));
  assert.equal(gateSeen.k, 'sk-secret'); // operator-private gate keeps full env
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

test('observational fire honors match prefix filter (tool-name scoping)', async () => {
  const w = dir();
  const audit = fakeAudit();
  cfg(w, { hooks: { tool_start: [
    { command: 'echo any' },                          // no match → always
    { command: 'echo bash-only', match: 'bash' },     // scoped
  ] } });
  const h = new HookRunner(w, { audit });
  // non-tool payload toolName → only the unscoped entry runs
  assert.equal(await h.fire('tool_start', { toolName: 'write' }), 1);
  assert.equal(await h.fire('tool_start', { toolName: 'bash' }), 2);
  // a non-tool event with no toolName → match entries never fire
  assert.equal(await h.fire('notification', { message: 'x' }), 0);
});

test('subagent_*/notification events accepted at load', () => {
  const w = dir();
  cfg(w, { hooks: {
    subagent_start: [{ command: 'echo ss' }],
    subagent_stop: [{ command: 'echo se' }],
    notification: [{ command: 'echo n' }],
  } });
  const h = new HookRunner(w);
  assert.deepEqual(h.events.sort(), ['notification', 'subagent_start', 'subagent_stop']);
});

test('dedup-h #280: turn_started/prompt_queued/task_started/session_heartbeat accepted at load + fire', async () => {
  const w = dir();
  cfg(w, { hooks: {
    turn_started: [{ command: 'echo ts' }],
    prompt_queued: [{ command: 'echo pq' }],
    task_started: [{ command: 'echo ta' }],
    session_heartbeat: [{ command: 'echo hb' }],
  } });
  const h = new HookRunner(w);
  assert.deepEqual(h.events.sort(), ['prompt_queued', 'session_heartbeat', 'task_started', 'turn_started']);
  assert.equal(await h.fire('task_started', { jobId: 'j1' }), 1);
  assert.equal(await h.fire('prompt_queued', { preview: 'x' }), 1);
});

test('file_checkpoint is a first-class observational event (#884)', async () => {
  const w = dir();
  const out = join(w, 'hit.txt');
  const script = join(w, 's.js');
  writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(out)}, 'fired:'+process.env.PAI_HOOK_EVENT);`);
  cfg(w, { hooks: { file_checkpoint: [{ command: `node ${JSON.stringify(script)}` }] } });
  const h = new HookRunner(w);
  assert.deepEqual(h.events, ['file_checkpoint']);
  const n = await h.fire('file_checkpoint', { op: 'write', target: 'x', receiptId: 'fo-1' });
  assert.equal(n, 1);
  assert.equal(readFileSync(out, 'utf-8'), 'fired:file_checkpoint');
});
