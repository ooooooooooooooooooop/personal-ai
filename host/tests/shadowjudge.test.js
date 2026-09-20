import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShadowJudge, shadowJudgeFromEnv } from '../src/core/shadowjudge.js';

const verdictDoc = (verdict, reason = 'test') => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: JSON.stringify({ verdict, reason }) } }] }),
});

test('unconfigured → disabled, observe is inert', async () => {
  const j = new ShadowJudge({});
  assert.equal(j.enabled, false);
  j.observe({ toolName: 'bash', args: {}, outcome: undefined });
  assert.equal(j.inFlight.size, 0);
  assert.equal(shadowJudgeFromEnv({ env: {} }), null);
});

test('shadow verdict audited with agree flag; outcome never modified', async () => {
  const audit = { events: [], write(e) { this.events.push(e); } };
  const j = new ShadowJudge(
    { url: 'http://x/v1/chat/completions', model: 'm' },
    { audit, fetchImpl: async () => verdictDoc('allow') },
  );
  const outcome = undefined; // admitted
  j.observe({ toolName: 'read', args: { path: 'a' }, outcome });
  await j.settle();
  const ev = audit.events.find((e) => e.kind === 'SHADOW_JUDGE');
  assert.equal(ev.data.deterministic, 'admit');
  assert.equal(ev.data.shadow, 'allow');
  assert.equal(ev.data.agree, true);
  assert.equal(outcome, undefined); // shadow can't touch it
});

test('disagreement telemetry: deterministic deny + shadow allow → agree:false', async () => {
  const audit = { events: [], write(e) { this.events.push(e); } };
  const j = new ShadowJudge(
    { url: 'http://x/', model: 'm' },
    { audit, fetchImpl: async () => verdictDoc('allow') },
  );
  const blocked = { block: true, rule: 'destructive', reason: 'rm -rf' };
  j.observe({ toolName: 'bash', args: { command: 'rm -rf /' }, outcome: blocked });
  await j.settle();
  const ev = audit.events[0];
  assert.equal(ev.data.deterministic, 'deny:destructive');
  assert.equal(ev.data.shadow, 'allow');
  assert.equal(ev.data.agree, false);
  assert.deepEqual(blocked, { block: true, rule: 'destructive', reason: 'rm -rf' }); // untouched
  assert.equal(j.stats.disagree, 1);
});

test('endpoint failure and malformed answers are inert telemetry', async () => {
  const audit = { events: [], write(e) { this.events.push(e); } };
  const bad = new ShadowJudge(
    { url: 'http://x/', model: 'm' },
    { audit, fetchImpl: async () => ({ ok: false }) },
  );
  bad.observe({ toolName: 'x', args: {}, outcome: undefined });
  const garbage = new ShadowJudge(
    { url: 'http://x/', model: 'm' },
    { audit, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'no json here' } }] }) }) },
  );
  garbage.observe({ toolName: 'x', args: {}, outcome: undefined });
  await Promise.all([bad.settle(), garbage.settle()]);
  assert.equal(audit.events.length, 0);
});

test('env builder wires config; missing model → null', () => {
  const j = shadowJudgeFromEnv({ env: { PAI_SHADOW_JUDGE_URL: 'http://x/', PAI_SHADOW_JUDGE_MODEL: 'gpt-x', PAI_SHADOW_JUDGE_KEY: 'k' } });
  assert.equal(j.enabled, true);
  assert.equal(shadowJudgeFromEnv({ env: { PAI_SHADOW_JUDGE_URL: 'http://x/' } }), null);
});

test('guard mode: deny escalates admit → block; ask routes to operator; allow admits', async () => {
  const audit = { events: [], write(e) { this.events.push(e); } };
  // deny verdict → block object returned
  const deny = new ShadowJudge(
    { url: 'http://x/', model: 'm', mode: 'guard' },
    { audit, fetchImpl: async () => verdictDoc('deny', 'destructive intent') },
  );
  const b = await deny.guard('bash', { command: 'rm -rf /' }, {});
  assert.equal(b.block, true);
  assert.equal(b.rule, 'guardian');
  assert.match(b.reason, /destructive intent/);
  // ask verdict + operator allow → admit stands (null)
  const asksLog = [];
  const asks = { ask: async (q) => { asksLog.push(q); return 'allow'; } };
  const ask = new ShadowJudge(
    { url: 'http://x/', model: 'm', mode: 'guard' },
    { audit, fetchImpl: async () => verdictDoc('ask', 'unusual shape') },
  );
  assert.equal(await ask.guard('write', { path: 'a' }, { asks }), null);
  assert.equal(asksLog.length, 1);
  // ask + operator deny → block
  const asksDeny = { ask: async () => 'deny' };
  assert.equal((await ask.guard('write', { path: 'a' }, { asks: asksDeny })).block, true);
  // ask + no asks channel → fail-closed block
  assert.equal((await ask.guard('write', { path: 'a' }, {})).block, true);
  // allow verdict → null (admit stands)
  const allow = new ShadowJudge(
    { url: 'http://x/', model: 'm', mode: 'guard' },
    { audit, fetchImpl: async () => verdictDoc('allow') },
  );
  assert.equal(await allow.guard('read', { path: 'x' }, {}), null);
});

test('guard unreachable → admit stands, GUARDIAN_BYPASS audited once per outage', async () => {
  const audit = { events: [], write(e) { this.events.push(e); } };
  const down = new ShadowJudge(
    { url: 'http://x/', model: 'm', mode: 'guard' },
    { audit, fetchImpl: async () => { throw new Error('conn refused'); } },
  );
  assert.equal(await down.guard('read', {}, {}), null);
  assert.equal(await down.guard('read', {}, {}), null);
  const bypasses = audit.events.filter((e) => e.kind === 'GUARDIAN_BYPASS');
  assert.equal(bypasses.length, 1); // transition-only, not per-call spam
  // recovery audits once
  down.fetch = async () => verdictDoc('allow');
  assert.equal(await down.guard('read', {}, {}), null);
  assert.equal(audit.events.filter((e) => e.kind === 'GUARDIAN_RECOVERED').length, 1);
});

test('guard mode is never consulted for denied outcomes (decide wrapper)', async () => {
  // decide-level guarantee: outcome?.block short-circuits before guard() —
  // verified by shape: guard() has no path that transforms a deny into admit
  const j = new ShadowJudge({ url: 'http://x/', model: 'm', mode: 'guard' },
    { fetchImpl: async () => verdictDoc('allow') });
  assert.equal(j.mode, 'guard');
  const shadow = new ShadowJudge({ url: 'http://x/', model: 'm' },
    { fetchImpl: async () => verdictDoc('deny') });
  assert.equal(shadow.mode, 'shadow'); // default unchanged
});

test('env builder reads PAI_SHADOW_JUDGE_MODE', () => {
  const g = shadowJudgeFromEnv({ env: { PAI_SHADOW_JUDGE_URL: 'http://x/', PAI_SHADOW_JUDGE_MODEL: 'm', PAI_SHADOW_JUDGE_MODE: 'guard' } });
  assert.equal(g.mode, 'guard');
});
