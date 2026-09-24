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

test('prompt_submit gate (operator-private file) answers transform/deny JSON (#935)', async () => {
  const w = dir();
  const gateFile = join(w, 'gate-hooks.json');
  const script = join(w, 'gate.js');
  writeFileSync(script, `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const p=JSON.parse(d);console.log(JSON.stringify(p.text==='rewrite me'?{text:'REWRITTEN'}:p.text==='bad'?{deny:'nope'}:{context:'C'}));});`);
  writeFileSync(gateFile, JSON.stringify({ hooks: { prompt_submit: [{ command: `node ${JSON.stringify(script)}` }] } }));
  const h = new HookRunner(w, { gate: true, configPath: gateFile });
  assert.equal(await h.fireValue('prompt_submit', { text: 'rewrite me' }).then((r) => r.text), 'REWRITTEN');
  assert.equal((await h.fireValue('prompt_submit', { text: 'bad' })).deny, 'nope');
  assert.equal((await h.fireValue('prompt_submit', { text: 'ok' })).context, 'C');
});

test('dedup-h #937: http/prompt/agent hook forms normalize to {code,tail}', async () => {
  const w = dir();
  // http form — POSTs the payload; response body last-line JSON answers gates
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, text: async () => 'noise\n{"deny":"http says no"}' };
  };
  cfg(w, { hooks: { prompt_submit: [{ http: 'https://hooks.local/x' }] } });
  const hHttp = new HookRunner(w, { fetchImpl });
  // observational fire runs the http entry
  assert.equal(await hHttp.fire('prompt_submit', { preview: 'p' }), 1);
  assert.equal(calls[0].url, 'https://hooks.local/x');
  assert.equal(calls[0].body.event, 'prompt_submit');

  // gate http: fireValue parses the body's last-line JSON
  const gateFile = join(w, 'gate2.json');
  writeFileSync(gateFile, JSON.stringify({ hooks: { prompt_submit: [{ http: 'https://hooks.local/gate' }] } }));
  const hGate = new HookRunner(w, { gate: true, configPath: gateFile, fetchImpl });
  const v = await hGate.fireValue('prompt_submit', { text: 'hi' });
  assert.equal(v.deny, 'http says no');

  // prompt form — routed through injected llmFn; response text is the tail
  const w2 = dir();
  cfg(w2, { hooks: { session_start: [{ prompt: 'summarize this event' }] } });
  const llmCalls = [];
  const hPrompt = new HookRunner(w2, { llmFn: async (instruction, payload) => { llmCalls.push({ instruction, payload }); return '{"ok":1}'; } });
  assert.equal(await hPrompt.fire('session_start', { sessionId: 's1' }), 1);
  assert.equal(llmCalls[0].instruction, 'summarize this event');
  assert.equal(llmCalls[0].payload.sessionId, 's1');

  // agent form without llmFn: observational = audited skip; gate = fail closed
  const w3 = dir();
  cfg(w3, { hooks: { tool_end: [{ agent: 'review the call' }] } });
  const audit = fakeAudit();
  const hNoLlm = new HookRunner(w3, { audit });
  assert.equal(await hNoLlm.fire('tool_end', { toolName: 'bash' }), 1); // ran, entry failed internally
  const gateFile3 = join(w3, 'gate3.json');
  writeFileSync(gateFile3, JSON.stringify({ hooks: { pre_tool: [{ agent: 'veto check' }] } }));
  const hGate3 = new HookRunner(w3, { gate: true, configPath: gateFile3 });
  const g = await hGate3.fireGate('pre_tool', { tool: 'bash', args: {} });
  assert.match(g.deny, /no llmFn|exited 1/);
});

// dedup-h #1143 — unknown typed hook entries are load-time errors (gate)
// or audited drops (untrusted); allowPromptInjection gates model output.
test('#1143: unknown typed hook entries — gate throws, untrusted drops+audits', async () => {
  const w = mkdtempSync(join(tmpdir(), 'pai-hook1143-'));
  // entry with an unrecognized type / no known runnable form
  cfg(w, { hooks: { session_start: [{ type: 'teleport', foo: 'x' }, { command: 'echo ok' }] } });
  const auditRows = [];
  const audit = { write: (r) => auditRows.push(r) };
  const h = new HookRunner(w, { audit });
  assert.equal((h.hooks.session_start ?? []).length, 1, 'bad entry dropped, good entry kept');
  assert.ok(auditRows.some((r) => r.kind === 'HOOK_CONFIG_ERROR' && r.data?.reason === 'unknown hook form'));
  // gate file: same entry shape refuses the whole load
  const gateFile = join(w, 'gate-hooks.json');
  writeFileSync(gateFile, JSON.stringify({ hooks: { pre_tool: [{ type: 'teleport' }] } }));
  assert.throws(() => new HookRunner(w, { gate: true, configPath: gateFile }), /no known hook form/);
  // type that disagrees with the field present is also invalid
  writeFileSync(gateFile, JSON.stringify({ hooks: { pre_tool: [{ type: 'prompt', command: 'x' }] } }));
  assert.throws(() => new HookRunner(w, { gate: true, configPath: gateFile }), /no known hook form|mismatched/);
  // non-array event value rejected
  writeFileSync(gateFile, JSON.stringify({ hooks: { pre_tool: 'nope' } }));
  assert.throws(() => new HookRunner(w, { gate: true, configPath: gateFile }), /must be an array/);
  // declared type matching the field is accepted
  writeFileSync(gateFile, JSON.stringify({ hooks: { pre_tool: [{ type: 'command', command: 'exit 0' }] } }));
  assert.doesNotThrow(() => new HookRunner(w, { gate: true, configPath: gateFile }));
});

test('#1143: model-backed hook answers veto-only unless allowPromptInjection', async () => {
  const w = mkdtempSync(join(tmpdir(), 'pai-hook1143b-'));
  const gateFile = join(w, 'gate.json');
  const auditRows = [];
  const audit = { write: (r) => auditRows.push(r) };
  const llmFn = async () => '{"text":"INJECTED","context":"INJECTED","deny":"no"}';
  // no opt-in: injection fields stripped, veto survives
  writeFileSync(gateFile, JSON.stringify({ hooks: { prompt_submit: [{ prompt: 'judge this' }] } }));
  const g1 = new HookRunner(w, { gate: true, configPath: gateFile, audit, llmFn });
  const a1 = await g1.fireValue('prompt_submit', { text: 'hi' });
  assert.equal(a1.deny, 'no', 'veto field survives');
  assert.equal(a1.text, undefined);
  assert.equal(a1.context, undefined);
  assert.ok(auditRows.some((r) => r.kind === 'HOOK_INJECTION_REFUSED'));
  // answer that is ONLY injection fields → loud failure (fail closed)
  const g1b = new HookRunner(w, { gate: true, configPath: gateFile, audit, llmFn: async () => '{"text":"INJECTED"}' });
  await assert.rejects(() => g1b.fireValue('prompt_submit', {}), /only injection fields/);
  // per-entry opt-in lets generated content through
  writeFileSync(gateFile, JSON.stringify({ hooks: { prompt_submit: [{ prompt: 'judge', allowPromptInjection: true }] } }));
  const g2 = new HookRunner(w, { gate: true, configPath: gateFile, audit, llmFn });
  const a2 = await g2.fireValue('prompt_submit', {});
  assert.equal(a2.text, 'INJECTED');
  // config-wide opt-in (inside hooks map) works too
  writeFileSync(gateFile, JSON.stringify({ hooks: { allowPromptInjection: true, prompt_submit: [{ prompt: 'judge' }] } }));
  const g3 = new HookRunner(w, { gate: true, configPath: gateFile, audit, llmFn });
  const a3 = await g3.fireValue('prompt_submit', {});
  assert.equal(a3.text, 'INJECTED');
  // command entries are operator-authored — injection flag irrelevant
  writeFileSync(gateFile, JSON.stringify({ hooks: { prompt_submit: [{ type: 'command', command: `node -e "console.log(JSON.stringify({text:'ok'}))"` }] } }));
  const g4 = new HookRunner(w, { gate: true, configPath: gateFile, audit });
  const a4 = await g4.fireValue('prompt_submit', {});
  assert.equal(a4.text, 'ok');
});

/* ---- dedup-h #1334: plugin-provided exec env (resolve_exec_env) ---- */

test('#1334 exec env wrapper prefixes the spawned command; payload still flows', async () => {
  const w = dir();
  const audit = fakeAudit();
  const marker = join(w, 'wrapped.txt');
  // wrapper = node -e script that writes a marker then runs the inner command
  // via the shell — proves the plugin env truly wraps (not replaces) the hook.
  const wrapperScript = join(w, 'wrap.js');
  writeFileSync(wrapperScript, `const i=process.argv.indexOf('--');const inner=process.argv.slice(i+1).join(' ');require('fs').writeFileSync(${JSON.stringify(marker)},'wrapped:'+inner.slice(0,80));require('child_process').spawnSync(inner,{shell:true,stdio:'inherit'});`);
  const inner = join(w, 'inner.js');
  writeFileSync(inner, `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{require('fs').writeFileSync(${JSON.stringify(join(w,'inner-out.txt'))},'inner-ran');});`);
  cfg(w, { hooks: { tool_end: [{ command: `node ${JSON.stringify(inner)}` }] } });
  const h = new HookRunner(w, { audit, resolveExecEnv: (cmd) => `node ${JSON.stringify(wrapperScript)} -- ${cmd}` });
  const ran = await h.fire('tool_end', { toolName: 'write' });
  assert.equal(ran, 1);
  const wrapped = readFileSync(marker, 'utf-8');
  assert.match(wrapped, /^wrapped:/);
  assert.match(wrapped, /inner\.js/, 'wrapper receives the original command line');
  assert.equal(readFileSync(join(w, 'inner-out.txt'), 'utf-8'), 'inner-ran');
});

test('#1334 resolver returning falsy runs the raw command; throwing fails closed', async () => {
  const w = dir();
  const audit = fakeAudit();
  const outFile = join(w, 'raw.txt');
  const script = join(w, 's.js');
  writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(outFile)},'raw');`);
  cfg(w, { hooks: { session_start: [{ command: `node ${JSON.stringify(script)}` }] } });
  // falsy → provider declines → raw command still runs
  const h1 = new HookRunner(w, { audit, resolveExecEnv: () => null });
  await h1.fire('session_start');
  assert.equal(readFileSync(outFile, 'utf-8'), 'raw');
  // throwing resolver → fail closed: hook reports error, command never spawned
  const w2 = dir();
  const audit2 = fakeAudit();
  cfg(w2, { hooks: { session_start: [{ command: 'echo should-never-run > ran.txt' }] } });
  const h2 = new HookRunner(w2, { audit: audit2, resolveExecEnv: () => { throw new Error('plugin env unavailable'); } });
  await h2.fire('session_start');
  assert.ok(!existsSync(join(w2, 'ran.txt')), 'command must not run when exec env resolution fails');
  assert.ok(audit2.events.some((e) => e.kind === 'HOOK_ERROR' && /exec env resolution failed/.test(e.data.error)));
});

/* ---- dedup-h #1858: before_tool arg rewrite + post_tool output append ---- */

test('#1858 gate: {"args":{…}} rewrites tool input and composes across hooks', async () => {
  const w = dir();
  const audit = fakeAudit();
  const gateFile = join(w, 'gate.json');
  const echo = join(w, 'echo-args.json');
  // hook 1 rewrites; hook 2 records the args it receives on stdin — the
  // rewrite must compose so hook 2 sees hook 1's output, not the original.
  const rw = join(w, 'rw.js');
  writeFileSync(rw, `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(JSON.stringify({args:{command:'rewritten-cmd',extra:1}}));});`);
  const rec = join(w, 'rec.js');
  writeFileSync(rec, `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const p=JSON.parse(d);require('fs').writeFileSync(${JSON.stringify(echo)},JSON.stringify(p.args));});`);
  writeFileSync(gateFile, JSON.stringify({ hooks: { pre_tool: [
    { command: `node ${JSON.stringify(rw)}` },
    { command: `node ${JSON.stringify(rec)}` },
  ] } }));
  const g = new HookRunner(w, { gate: true, configPath: gateFile, audit });
  const r = await g.fireGate('pre_tool', { tool: 'bash', args: { command: 'orig-cmd' } });
  assert.deepEqual(r.args, { command: 'rewritten-cmd', extra: 1 });
  assert.deepEqual(JSON.parse(readFileSync(echo, 'utf-8')), { command: 'rewritten-cmd', extra: 1 });
});

test('#1858 gate: malformed args rewrite denies closed; prompt-kind needs opt-in', async () => {
  const w = dir();
  const audit = fakeAudit();
  const gateFile = join(w, 'gate.json');
  const bad = join(w, 'bad.js');
  writeFileSync(bad, `process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({args:'not-an-object'}));});`);
  writeFileSync(gateFile, JSON.stringify({ hooks: { pre_tool: [{ command: `node ${JSON.stringify(bad)}` }] } }));
  const g = new HookRunner(w, { gate: true, configPath: gateFile, audit });
  const d = await g.fireGate('pre_tool', { tool: 'bash', args: {} });
  assert.match(d.deny, /malformed args rewrite/);
  // model-backed entry: {args} is a content field — refused without opt-in
  const llmFn = async () => JSON.stringify({ args: { command: 'x' } });
  writeFileSync(gateFile, JSON.stringify({ hooks: { pre_tool: [{ prompt: 'rewrite it' }] } }));
  const g2 = new HookRunner(w, { gate: true, configPath: gateFile, audit, llmFn });
  const d2 = await g2.fireGate('pre_tool', { tool: 'bash', args: {} });
  assert.match(d2.deny, /without allowPromptInjection/);
  assert.ok(audit.events.some((e) => e.kind === 'HOOK_INJECTION_REFUSED'));
  // opted-in entry rewrites honestly
  writeFileSync(gateFile, JSON.stringify({ hooks: { pre_tool: [{ prompt: 'rewrite it', allowPromptInjection: true }] } }));
  const g3 = new HookRunner(w, { gate: true, configPath: gateFile, audit, llmFn });
  const a3 = await g3.fireGate('pre_tool', { tool: 'bash', args: {} });
  assert.deepEqual(a3.args, { command: 'x' });
});

test('#1858 gate: post_tool collects {"append"} across entries; malformed → deny; workdir cannot declare it', async () => {
  const w = dir();
  const audit = fakeAudit();
  const gateFile = join(w, 'gate.json');
  const a1 = join(w, 'a1.js');
  writeFileSync(a1, `process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({append:'ctx-one'}));});`);
  const a2 = join(w, 'a2.js');
  writeFileSync(a2, `process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({append:'ctx-two'}));});`);
  writeFileSync(gateFile, JSON.stringify({ hooks: { post_tool: [
    { command: `node ${JSON.stringify(a1)}` },
    { command: `node ${JSON.stringify(a2)}` },
  ] } }));
  const g = new HookRunner(w, { gate: true, configPath: gateFile, audit });
  const r = await g.fireGate('post_tool', { tool: 'read', args: {}, output: 'file body' });
  assert.deepEqual(r.append, ['ctx-one', 'ctx-two']);
  // deny on post_tool stays a veto (output suppression)
  const dn = join(w, 'dn.js');
  writeFileSync(dn, `process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({deny:'leaked secret'}));});`);
  writeFileSync(gateFile, JSON.stringify({ hooks: { post_tool: [{ command: `node ${JSON.stringify(dn)}` }] } }));
  const g2 = new HookRunner(w, { gate: true, configPath: gateFile, audit });
  const r2 = await g2.fireGate('post_tool', { tool: 'read', output: 'x' });
  assert.equal(r2.deny, 'leaked secret');
  // malformed append → fail closed
  const bd = join(w, 'bd.js');
  writeFileSync(bd, `process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({append:42}));});`);
  writeFileSync(gateFile, JSON.stringify({ hooks: { post_tool: [{ command: `node ${JSON.stringify(bd)}` }] } }));
  const g3 = new HookRunner(w, { gate: true, configPath: gateFile, audit });
  const r3 = await g3.fireGate('post_tool', { tool: 'read', output: 'x' });
  assert.match(r3.deny, /malformed append/);
  // workdir observational file can never declare post_tool — agent must not
  // inject into its own tool results
  cfg(w, { hooks: { post_tool: [{ command: 'echo x' }] } });
  const h = new HookRunner(w, { audit });
  assert.deepEqual(h.events, []);
  assert.ok(audit.events.some((e) => e.kind === 'HOOK_CONFIG_ERROR' && e.data.rejectedEvents?.includes('post_tool')));
});
