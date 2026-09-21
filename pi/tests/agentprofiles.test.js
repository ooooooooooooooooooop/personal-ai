/**
 * agentprofiles — frontmatter personas for delegate_task; compat dirs from
 * other harnesses (.claude/.cursor/.kiro/.devin agents) load the same way.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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
    commandFor: (t) => (t === 'pai' ? 'node pai-channel.js --serve' : 'codex run'),
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
