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
