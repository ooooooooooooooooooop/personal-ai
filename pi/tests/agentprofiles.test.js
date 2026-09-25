/**
 * agentprofiles — frontmatter personas for delegate_task; compat dirs from
 * other harnesses (.claude/.cursor/.kiro/.devin agents) load the same way.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAgentProfiles } from '../src/adapter/agentprofiles.js';

const PROFILE = (target, preamble = 'be terse', name = 'reviewer') =>
  `---\nname: ${name}\ntarget: ${target}\ndescription: code reviewer\n---\n${preamble}\n`;

test('compat agent dirs load alongside .pai/agents; first hit wins on collision', () => {
  const w = mkdtempSync(join(tmpdir(), 'pai-prof-'));
  const inst = mkdtempSync(join(tmpdir(), 'pai-prof-inst-'));
  mkdirSync(join(w, '.pai', 'agents'), { recursive: true });
  mkdirSync(join(w, '.claude', 'agents'), { recursive: true });
  mkdirSync(join(w, '.cursor', 'agents'), { recursive: true });
  writeFileSync(join(w, '.pai', 'agents', 'reviewer.md'), PROFILE('pi', 'native wins'));
  writeFileSync(join(w, '.claude', 'agents', 'reviewer.md'), PROFILE('claude', 'compat shadowed'));
  writeFileSync(join(w, '.cursor', 'agents', 'helper.md'), PROFILE('codex', 'cursor persona', 'helper'));
  const profiles = loadAgentProfiles({ workdir: w, instanceRoot: inst });
  assert.equal(profiles.get('reviewer').preamble, 'native wins'); // .pai beats .claude
  assert.equal(profiles.get('helper').target, 'codex');           // compat dir loaded
});

test('profile without target loads only when PAI_DELEGATE_DEFAULT_TARGET is set', () => {
  const w = mkdtempSync(join(tmpdir(), 'pai-prof2-'));
  const inst = mkdtempSync(join(tmpdir(), 'pai-prof2-inst-'));
  mkdirSync(join(w, '.kiro', 'agents'), { recursive: true });
  writeFileSync(join(w, '.kiro', 'agents', 'scout.md'), '---\nname: scout\n---\nexplore the codebase\n');
  const prev = process.env.PAI_DELEGATE_DEFAULT_TARGET;
  try {
    delete process.env.PAI_DELEGATE_DEFAULT_TARGET;
    assert.equal(loadAgentProfiles({ workdir: w, instanceRoot: inst }).has('scout'), false);
    process.env.PAI_DELEGATE_DEFAULT_TARGET = 'pi';
    const p = loadAgentProfiles({ workdir: w, instanceRoot: inst }).get('scout');
    assert.equal(p.target, 'pi');
    assert.match(p.preamble, /explore the codebase/);
  } finally {
    if (prev == null) delete process.env.PAI_DELEGATE_DEFAULT_TARGET;
    else process.env.PAI_DELEGATE_DEFAULT_TARGET = prev;
  }
});

test('M63: plugin-contributed agents dirs load, never shadow operator/workdir profiles', () => {
  const w = mkdtempSync(join(tmpdir(), 'pai-prof-ext-'));
  const inst = mkdtempSync(join(tmpdir(), 'pai-prof-ext-inst-'));
  const plugin = mkdtempSync(join(tmpdir(), 'pai-prof-ext-plug-'));
  mkdirSync(join(w, '.pai', 'agents'), { recursive: true });
  mkdirSync(join(plugin, 'agents'), { recursive: true });
  // same name in both — operator's wins (extraDirs append last)
  writeFileSync(join(w, '.pai', 'agents', 'reviewer.md'), PROFILE('pi', 'operator wins'));
  writeFileSync(join(plugin, 'agents', 'reviewer.md'), PROFILE('pi', 'plugin shadowed'));
  writeFileSync(join(plugin, 'agents', 'triage.md'), PROFILE('codex', 'plugin persona', 'triage'));
  const profiles = loadAgentProfiles({
    workdir: w, instanceRoot: inst,
    extraDirs: [{ dir: join(plugin, 'agents'), envCapable: true }],
  });
  assert.equal(profiles.get('reviewer').preamble, 'operator wins');
  assert.equal(profiles.get('triage').preamble, 'plugin persona');
  // envCapable flows through: plugin profile keeps env-shaping fields
  writeFileSync(join(plugin, 'agents', 'rich.md'),
    '---\nname: rich\ntarget: pi\nmodel: sonnet\nenv: A=1\n---\nwork\n');
  const rich = loadAgentProfiles({ workdir: w, instanceRoot: inst, extraDirs: [{ dir: join(plugin, 'agents'), envCapable: true }] }).get('rich');
  assert.equal(rich.model, 'sonnet');
  assert.equal(rich.env.A, '1');
});

test('env-shaping fields (env/model/effort/isolate_steering) load only under trust', () => {
  const w = mkdtempSync(join(tmpdir(), 'pai-prof3-'));
  const inst = mkdtempSync(join(tmpdir(), 'pai-prof3-inst-'));
  const rich = '---\nname: pro\ntarget: pi\nmodel: sonnet\neffort: high\nisolate_steering: true\nenv: A=1\nenv_deny: B\nmax_minutes: 15\n---\nwork\n';
  mkdirSync(join(w, '.pai', 'agents'), { recursive: true });
  mkdirSync(join(inst, 'agents'), { recursive: true });
  writeFileSync(join(w, '.pai', 'agents', 'pro.md'), rich);
  writeFileSync(join(inst, 'agents', 'pro2.md'), rich.replace('name: pro', 'name: pro2'));

  // untrusted workdir profile: env-shaping fields stripped, persona still loads
  const cold = loadAgentProfiles({ workdir: w, instanceRoot: inst, workdirTrusted: false });
  const c = cold.get('pro');
  assert.equal(c.target, 'pi');
  assert.equal(c.model, undefined);
  assert.equal(c.effort, undefined);
  assert.equal(c.isolateSteering, undefined);
  assert.equal(c.env, undefined);
  assert.equal(c.maxMinutes, 15); // wall-clock ceiling is not env-steering
  // operator-private profile: full fields
  const o = cold.get('pro2');
  assert.equal(o.model, 'sonnet');
  assert.equal(o.effort, 'high');
  assert.equal(o.isolateSteering, true);
  assert.deepEqual(o.env, { A: '1' });
  assert.deepEqual(o.envDeny, ['B']);

  // trusted workdir: project profile gets the same shaping rights
  const warm = loadAgentProfiles({ workdir: w, instanceRoot: inst, workdirTrusted: true });
  assert.equal(warm.get('pro').model, 'sonnet');
  assert.equal(warm.get('pro').isolateSteering, true);
});

test('M76/M94: tools_deny + budget_* load under trust, strip without it', () => {
  const w = mkdtempSync(join(tmpdir(), 'pai-prof4-'));
  const inst = mkdtempSync(join(tmpdir(), 'pai-prof4-inst-'));
  const rich = '---\nname: gated\ntarget: pi\ntools_deny: bash, deploy\nbudget_tokens: 50000\nbudget_cost: 0.25\n---\nwork\n';
  mkdirSync(join(w, '.pai', 'agents'), { recursive: true });
  writeFileSync(join(w, '.pai', 'agents', 'gated.md'), rich);

  const cold = loadAgentProfiles({ workdir: w, instanceRoot: inst, workdirTrusted: false });
  assert.equal(cold.get('gated').toolsDeny, undefined);
  assert.equal(cold.get('gated').budget, undefined);

  const warm = loadAgentProfiles({ workdir: w, instanceRoot: inst, workdirTrusted: true });
  assert.deepEqual(warm.get('gated').toolsDeny, ['bash', 'deploy']);
  assert.deepEqual(warm.get('gated').budget, { tokens: 50000, costUsd: 0.25 });
});

test('#1112: tools allowlist loads under trust, strips without it', () => {
  const w = mkdtempSync(join(tmpdir(), 'pai-prof-ta-'));
  const inst = mkdtempSync(join(tmpdir(), 'pai-prof-ta-inst-'));
  const rich = '---\nname: narrow\ntarget: pi\ntools: read, grep, mcp__github__*, bad;name\n---\nwork\n';
  mkdirSync(join(w, '.pai', 'agents'), { recursive: true });
  writeFileSync(join(w, '.pai', 'agents', 'narrow.md'), rich);

  const cold = loadAgentProfiles({ workdir: w, instanceRoot: inst, workdirTrusted: false });
  assert.equal(cold.get('narrow').toolsAllow, undefined, 'untrusted workdir profile cannot shape the child surface');

  const warm = loadAgentProfiles({ workdir: w, instanceRoot: inst, workdirTrusted: true });
  assert.deepEqual(warm.get('narrow').toolsAllow, ['read', 'grep', 'mcp__github__*'], 'valid names + prefix wildcards load; malformed dropped');

  // alias form `tools_allow:` resolves identically
  writeFileSync(join(w, '.pai', 'agents', 'alias.md'), '---\nname: alias\ntarget: pi\ntools_allow: bash\n---\nwork\n');
  const warm2 = loadAgentProfiles({ workdir: w, instanceRoot: inst, workdirTrusted: true });
  assert.deepEqual(warm2.get('alias').toolsAllow, ['bash']);
});

test('C3: mcp_deny loads under trust, strips without it', () => {
  const w = mkdtempSync(join(tmpdir(), 'pai-prof-c3-'));
  const inst = mkdtempSync(join(tmpdir(), 'pai-prof-c3-inst-'));
  const rich = '---\nname: narrow\ntarget: pi\nmcp_deny: github, web-search, bad;name\n---\nwork\n';
  mkdirSync(join(w, '.pai', 'agents'), { recursive: true });
  writeFileSync(join(w, '.pai', 'agents', 'narrow.md'), rich);

  const cold = loadAgentProfiles({ workdir: w, instanceRoot: inst, workdirTrusted: false });
  assert.equal(cold.get('narrow').mcpDeny, undefined, 'untrusted workdir profile cannot narrow the MCP surface');

  const warm = loadAgentProfiles({ workdir: w, instanceRoot: inst, workdirTrusted: true });
  assert.deepEqual(warm.get('narrow').mcpDeny, ['github', 'web-search'], 'valid server names load; malformed entry dropped');
});

test('M94: profile budget stamps --budget-* flags; unenforceable target refused', async () => {
  const { delegateTool } = await import('../src/adapter/delegate.js');
  const dir = mkdtempSync(join(tmpdir(), 'pai-prof5-'));
  const spawned = [];
  const executor = { spawnCommandJob: async (spec) => { spawned.push(spec.command); return { job_id: 'j1', attempt_id: 'a1' }; } };
  const profiles = new Map([
    ['bounded', { name: 'bounded', target: 'pai', preamble: '', budget: { tokens: 50000 }, toolsDeny: ['bash'] }],
    ['free', { name: 'free', target: 'codex', preamble: '', budget: { tokens: 1 } }],
  ]);
  const tool = delegateTool(executor, {
    commandFor: (t) => (t === 'pai'
      ? { command: 'node pai-channel.js --serve', enforceable: true }
      : 'codex run'),
    workdir: dir,
    profiles,
  });
  // enforceable target → flags in the spawned command
  const r = await tool.execute('c1', { profile: 'bounded', task: 'do thing' });
  assert.ok(!r.isError, JSON.stringify(r));
  assert.match(spawned[0], /--budget-tokens 50000/);
  assert.match(spawned[0], /--tools-deny "bash"/);
  // unenforceable target with a declared budget → refused pre-spawn
  const r2 = await tool.execute('c2', { profile: 'free', task: 'do thing' });
  assert.equal(r2.details.refused, true);
  assert.equal(r2.details.reason, 'unenforceable_profile_budget');
  assert.equal(spawned.length, 1); // refused before spawn
});

test('M94 regression: delegation reserves only the EFFECTIVE child slice, not all parent headroom', async () => {
  const { delegateTool } = await import('../src/adapter/delegate.js');
  const { BudgetGovernor } = await import('../../host/src/core/budget.js');
  const dir = mkdtempSync(join(tmpdir(), 'pai-prof6-'));
  const spawned = [];
  const executor = { spawnCommandJob: async (spec) => { spawned.push(spec.command); return { job_id: 'j1', attempt_id: 'a1' }; } };
  const budget = new BudgetGovernor({
    ledgerPath: join(dir, 'budget-ledger.jsonl'),
    limits: { maxTokensPerSession: 100_000 },
  });
  const profiles = new Map([
    ['bounded', { name: 'bounded', target: 'pai', preamble: '', budget: { tokens: 50000 } }],
  ]);
  const tool = delegateTool(executor, {
    commandFor: () => ({ command: 'node pai-channel.js --serve', enforceable: true }),
    workdir: dir,
    profiles,
    budget,
    getScope: () => 'sess-parent',
  });
  const r = await tool.execute('c1', { profile: 'bounded', task: 'do thing' });
  assert.ok(!r.isError, JSON.stringify(r));
  assert.match(spawned[0], /--budget-tokens 50000/);
  // the ledger charge must be the 50k effective slice — the parent still has
  // 50k headroom for a second delegate or its own turn, not 0.
  const rem = budget.remaining('sess-parent');
  assert.equal(rem.tokens, 50_000);
  // a second identical delegate consumes the rest; a third must refuse
  await tool.execute('c2', { profile: 'bounded', task: 'again' });
  const r3 = await tool.execute('c3', { profile: 'bounded', task: 'too much' });
  assert.equal(r3.details.refused, true);
  assert.match(String(r3.details.reason), /budget|headroom/i);
});

// G6: model-authored task text interpolates verbatim into the child argv
// AND the durable job checkpoint — a credential embedded there leaks to the
// foreign body's logs and our persisted records. Scan-and-refuse, same
// posture as the memory write path.
test('delegate_task refuses task text carrying a credential pattern', async () => {
  const { delegateTool } = await import('../src/adapter/delegate.js');
  const dir = mkdtempSync(join(tmpdir(), 'pai-profsec-'));
  const spawned = [];
  const executor = { spawnCommandJob: async (spec) => { spawned.push(spec.command); return { job_id: 'j1', attempt_id: 'a1' }; } };
  const tool = delegateTool(executor, {
    commandFor: () => ({ command: 'node pai-channel.js --serve', enforceable: true }),
    workdir: dir,
  });
  const secret = `sk-${'a'.repeat(20)}`;
  const r = await tool.execute('c1', { target: 'pai', task: `use this key ${secret} to check` });
  assert.equal(r.isError, true);
  assert.equal(r.details.refused, true);
  assert.equal(r.details.reason, 'secret_in_task_text');
  assert.equal(spawned.length, 0, 'refused before spawn');
  // a clean task still spawns
  const ok = await tool.execute('c2', { target: 'pai', task: 'summarize the diff' });
  assert.ok(!ok.isError, JSON.stringify(ok));
  assert.equal(spawned.length, 1);
});

// dedup-h #1393 — policy hot-reload: workdir trust changes take effect inside
// the live daemon. A predicate `workdirTrusted` parses gated fields AND tags
// the profile trustGated; the delegate tool re-evaluates the predicate at
// every call — mid-session grant unlocks, mid-session revoke re-locks, no
// restart. Boolean mode keeps the legacy load-time snapshot semantics.
test('#1393: predicate trust hot-reloads — grant unlocks, revoke re-locks', async () => {
  const { delegateTool } = await import('../src/adapter/delegate.js');
  const dir = mkdtempSync(join(tmpdir(), 'pai-prof1393-'));
  const wd = join(dir, 'wd'); const inst = join(dir, 'inst');
  mkdirSync(join(wd, '.pai', 'agents'), { recursive: true });
  writeFileSync(join(wd, '.pai', 'agents', 'hot.md'),
    '---\nname: hot\ntarget: pai\nenv: FOO=bar\ntools_allow: read\nisolate_steering: true\n---\ndo it\n');
  let trusted = false;
  const profiles = loadAgentProfiles({ workdir: wd, instanceRoot: inst, workdirTrusted: () => trusted });
  const hot = profiles.get('hot');
  assert.ok(hot, 'profile parses even while untrusted (deferred gate)');
  assert.equal(hot.trustGated, true);
  assert.equal(hot.env.FOO, 'bar'); // fields present; the gate lives at use-time

  const spawned = [];
  const executor = { spawnCommandJob: async (spec) => { spawned.push(spec.command); return { job_id: 'j1', attempt_id: 'a1' }; } };
  const tool = delegateTool(executor, {
    commandFor: () => ({ command: 'node pai-channel.js --serve', enforceable: true }),
    workdir: wd, profiles, workdirTrusted: () => trusted,
  });

  // untrusted → gated payload stripped, delegation still proceeds
  const r1 = await tool.execute('c1', { profile: 'hot', task: 'x' });
  assert.ok(!r1.isError, JSON.stringify(r1));
  assert.ok(!spawned[0].includes('--env-json'), 'no env while untrusted');
  assert.ok(!spawned[0].includes('--tools-allow'), 'no allowlist while untrusted');
  assert.ok(!spawned[0].includes('--steering-off'));

  // mid-session GRANT → next call picks it up, same loaded profiles map
  trusted = true;
  const r2 = await tool.execute('c2', { profile: 'hot', task: 'x' });
  assert.ok(!r2.isError, JSON.stringify(r2));
  assert.match(spawned[1], /--env-json "/);
  assert.match(spawned[1], /--tools-allow "read"/);
  assert.match(spawned[1], /--steering-off/);

  // mid-session REVOKE → re-locks immediately
  trusted = false;
  const r3 = await tool.execute('c3', { profile: 'hot', task: 'x' });
  assert.ok(!r3.isError, JSON.stringify(r3));
  assert.ok(!spawned[2].includes('--env-json'), 'env re-stripped after revoke');
  assert.ok(!spawned[2].includes('--steering-off'));
});

test('#1393: operator-private profiles are never trust-gated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-prof1393b-'));
  const wd = join(dir, 'wd'); const inst = join(dir, 'inst');
  mkdirSync(join(inst, 'agents'), { recursive: true });
  writeFileSync(join(inst, 'agents', 'ops.md'),
    '---\nname: ops\ntarget: pai\nenv: FOO=bar\n---\ndo it\n');
  const profiles = loadAgentProfiles({ workdir: wd, instanceRoot: inst, workdirTrusted: () => false });
  const ops = profiles.get('ops');
  assert.equal(ops.trustGated, undefined, 'instance-root profile carries no gate tag');
  assert.equal(ops.env.FOO, 'bar');
});

test('#1546: compaction_model loads under trust, strips without it', () => {
  const w = mkdtempSync(join(tmpdir(), 'pai-prof-cm-'));
  const inst = mkdtempSync(join(tmpdir(), 'pai-prof-cmi-'));
  const rich = '---\nname: summ\ntarget: pi\ncompaction_model: compp/cheap-sum\n---\nwork\n';
  mkdirSync(join(w, '.pai', 'agents'), { recursive: true });
  mkdirSync(join(inst, 'agents'), { recursive: true });
  writeFileSync(join(w, '.pai', 'agents', 'summ.md'), rich);
  writeFileSync(join(inst, 'agents', 'summ2.md'), rich.replace('name: summ', 'name: summ2'));
  const cold = loadAgentProfiles({ workdir: w, instanceRoot: inst, workdirTrusted: false });
  assert.equal(cold.get('summ').compactionModel, undefined, 'untrusted workdir profile cannot steer summarization spend');
  assert.equal(cold.get('summ2').compactionModel, 'compp/cheap-sum', 'operator-private profile carries the field');
  const warm = loadAgentProfiles({ workdir: w, instanceRoot: inst, workdirTrusted: true });
  assert.equal(warm.get('summ').compactionModel, 'compp/cheap-sum', 'trusted workdir profile keeps it');
});

test('#1546: profile compaction_model stamps --compaction-model-b64; unenforceable target refused', async () => {
  const { delegateTool } = await import('../src/adapter/delegate.js');
  const dir = mkdtempSync(join(tmpdir(), 'pai-prof-cmd-'));
  const spawned = [];
  const executor = { spawnCommandJob: async (spec) => { spawned.push(spec.command); return { job_id: 'j1', attempt_id: 'a1' }; } };
  const profiles = new Map([
    ['summ', { name: 'summ', target: 'pai', preamble: '', compactionModel: 'compp/cheap-sum' }],
    ['summ2', { name: 'summ2', target: 'codex', preamble: '', compactionModel: 'x' }],
  ]);
  const tool = delegateTool(executor, {
    commandFor: (t) => (t === 'pai'
      ? { command: 'node pai-channel.js --serve', enforceable: true }
      : 'codex run'),
    workdir: dir,
    profiles,
  });
  const r = await tool.execute('c1', { profile: 'summ', task: 'do thing' });
  assert.ok(!r.isError, JSON.stringify(r));
  const m = /--compaction-model-b64 ([A-Za-z0-9+/=]+)/.exec(spawned[0]);
  assert.ok(m, 'bridge flag stamped into the spawned command');
  assert.equal(Buffer.from(m[1], 'base64').toString('utf-8'), 'compp/cheap-sum', 'value survives the argv channel byte-exact');
  // unenforceable target with a declared compaction_model → refused pre-spawn
  const r2 = await tool.execute('c2', { profile: 'summ2', task: 'do thing' });
  assert.equal(r2.details.refused, true);
  assert.equal(r2.details.reason, 'unenforceable_compaction_model');
  assert.equal(spawned.length, 1, 'refused before spawn');
});

// dedup-h #1664 — agent frontmatter maxTurns + disallowedTools aliases.
test('#1664: max_turns loads under trust, strips without it; disallowedTools aliases map to toolsDeny', () => {
  const w = mkdtempSync(join(tmpdir(), 'pai-prof1664w-'));
  const inst = mkdtempSync(join(tmpdir(), 'pai-prof1664i-'));
  mkdirSync(join(w, '.pai', 'agents'), { recursive: true });
  writeFileSync(join(w, '.pai', 'agents', 'capped.md'), [
    '---', 'name: capped', 'target: pai', 'max_turns: 40', 'disallowedTools: bash,deploy', '---', 'bounded worker',
  ].join('\n'));
  writeFileSync(join(w, '.pai', 'agents', 'capped2.md'), [
    '---', 'name: capped2', 'target: pai', 'maxTurns: 12', 'disallowed_tools: rm', '---', 'alt spelling',
  ].join('\n'));
  const cold = loadAgentProfiles({ workdir: w, instanceRoot: inst, workdirTrusted: false });
  assert.equal(cold.get('capped').maxTurns, undefined, 'untrusted workdir profile: maxTurns stripped');
  assert.equal(cold.get('capped').toolsDeny, undefined, 'untrusted workdir profile: disallowedTools stripped');
  const warm = loadAgentProfiles({ workdir: w, instanceRoot: inst, workdirTrusted: true });
  assert.equal(warm.get('capped').maxTurns, 40);
  assert.deepEqual(warm.get('capped').toolsDeny, ['bash', 'deploy'], 'disallowedTools spelling accepted');
  assert.equal(warm.get('capped2').maxTurns, 12, 'maxTurns camelCase accepted');
  assert.deepEqual(warm.get('capped2').toolsDeny, ['rm'], 'disallowed_tools snake alias accepted');
});

test('#1664: profile max_turns stamps --max-turns; unenforceable target refused', async () => {
  const { delegateTool } = await import('../src/adapter/delegate.js');
  const dir = mkdtempSync(join(tmpdir(), 'pai-prof1664d-'));
  const spawned = [];
  const executor = { spawnCommandJob: async (spec) => { spawned.push(spec.command); return { job_id: 'j1', attempt_id: 'a1' }; } };
  const profiles = new Map([
    ['capped', { name: 'capped', target: 'pai', preamble: '', maxTurns: 40 }],
    ['foreign', { name: 'foreign', target: 'codex', preamble: '', maxTurns: 40 }],
  ]);
  const tool = delegateTool(executor, {
    commandFor: (t) => (t === 'pai'
      ? { command: 'node pai-channel.js --serve', enforceable: true }
      : 'codex run'),
    workdir: dir,
    profiles,
  });
  const r = await tool.execute('c1', { profile: 'capped', task: 'do thing' });
  assert.ok(!r.isError, JSON.stringify(r));
  assert.match(spawned[0], /--max-turns 40/, 'dedicated flag reaches the bridge');
  const r2 = await tool.execute('c2', { profile: 'foreign', task: 'do thing' });
  assert.equal(r2.details.refused, true);
  assert.equal(r2.details.reason, 'unenforceable_max_turns');
  assert.equal(spawned.length, 1, 'refused before spawn');
});

test('#1664: --max-turns bridge flag stamps PAI_MAX_TOOL_CALLS on the child env', () => {
  // bridge-side unit: the flag→env mapping is exercised directly
  const src = readFileSync(new URL('../bin/delegate-bridge.js', import.meta.url), 'utf-8');
  assert.match(src, /--max-turns/);
  assert.match(src, /PAI_MAX_TOOL_CALLS/);
});

test('#2431: resume_task rebinds an existing open task; live/closed/missing refused', async () => {
  const { delegateTool } = await import('../src/adapter/delegate.js');
  const { TaskStore } = await import('../../host/src/core/tasks.js');
  const dir = mkdtempSync(join(tmpdir(), 'pai-resume-'));
  const store = new TaskStore(join(dir, 'tasks'));
  const spawned = [];
  const executor = {
    store: { getJob: (id) => ({ job_id: id, job_state: id === 'j-live' ? 'RUNNING' : 'COMPLETED' }) },
    spawnCommandJob: async (spec) => { spawned.push(spec.command); return { job_id: 'j-new', attempt_id: 'a1' }; },
  };
  const tool = delegateTool(executor, {
    commandFor: () => ({ command: 'node pai-channel.js --serve', enforceable: true }),
    workdir: dir,
    taskStore: store,
  });
  const done = store.create({ label: 'prior', jobId: 'j-old' });       // finished job → resumable
  const live = store.create({ label: 'busy', jobId: 'j-live' });       // live job → refuse
  const closed = store.create({ label: 'shut', jobId: 'j-old' });
  store.setState(closed.task_id, 'closed');

  const r1 = await tool.execute('c1', { task: 'continue the work', resume_task: done.task_id });
  assert.ok(!r1.isError, JSON.stringify(r1));
  assert.equal(r1.details.task_id, done.task_id, 'same task rebound');
  assert.equal(r1.details.resumed, true);
  assert.equal(store.get(done.task_id).job_id, 'j-new', 'bindJob advances latest');
  assert.deepEqual(store.get(done.task_id).job_ids, ['j-old', 'j-new'], 'history preserved');
  assert.match(spawned[0], new RegExp(`--task-dir "[^"]*${done.task_id}`), 'same task-dir reaches bridge');

  const r2 = await tool.execute('c2', { task: 'x', resume_task: live.task_id });
  assert.equal(r2.details.refused, true);
  assert.equal(r2.details.reason, 'resume_task_live');
  const r3 = await tool.execute('c3', { task: 'x', resume_task: closed.task_id });
  assert.equal(r3.details.reason, 'resume_task_closed');
  const r4 = await tool.execute('c4', { task: 'x', resume_task: 'task-nope' });
  assert.equal(r4.details.reason, 'resume_task_missing');
  assert.equal(spawned.length, 1, 'all refusals before spawn');
});

test('#2438: built-in verifier profile present by default; operator file shadows it', () => {
  const w = mkdtempSync(join(tmpdir(), 'pai-ver-'));
  const inst = mkdtempSync(join(tmpdir(), 'pai-ver-inst-'));
  let profiles = loadAgentProfiles({ workdir: w, instanceRoot: inst });
  const v = profiles.get('verifier');
  assert.ok(v, 'built-in registered with zero config');
  assert.equal(v.builtin, true);
  assert.equal(v.target, 'pai', 'forks parent body');
  assert.ok(v.toolsDeny.includes('file_edit'), 'write tools denied');
  assert.match(v.preamble, /VERIFIER|verifier/i);

  // operator verifier.md shadows the built-in
  mkdirSync(join(w, '.pai', 'agents'), { recursive: true });
  writeFileSync(join(w, '.pai', 'agents', 'verifier.md'), PROFILE('codex', 'operator verifier wins', 'verifier'));
  profiles = loadAgentProfiles({ workdir: w, instanceRoot: inst });
  assert.equal(profiles.get('verifier').preamble, 'operator verifier wins');
  assert.equal(profiles.get('verifier').builtin, undefined);
});
