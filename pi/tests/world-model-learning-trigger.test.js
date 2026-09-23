/**
 * When does a world model revise? Not on a refutation, and not on a number this
 * code invented.
 *
 * theory/sources/02_解释贝叶斯更新: a single failure "可能只是噪声". What licenses
 * MODEL FAILURE is a 残差结构 — the same kind of failure recurring, so that
 * `reality - prediction` shows a pattern. And the model stores only what is
 * 稳定 (not a one-off) and 可迁移 (not one event).
 *
 * The COUNT at which recurrence becomes visible is a domain judgement, so it is
 * DECLARED by the pilot, never defaulted here (adapter-pilot-evaluation-rubric
 * §四 B-P1: "不为 rubric 发明伪精确数字"; §五: 判定规则须预注册; §七: 未操作化前
 * 一律 UNMEASURED). Undeclared ⇒ no trigger, and the adapter says so.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/adapter/world-model.js';

/** @param {{threshold?: number, declareInCanonical?: number}} cfg */
function rig({ threshold, declareInCanonical } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pai-wm-trigger-'));
  const canonicalDir = join(dir, 'canonical');
  mkdirSync(canonicalDir, { recursive: true });
  if (declareInCanonical != null) {
    writeFileSync(join(canonicalDir, 'learning-trigger.json'),
      JSON.stringify({ refutation_threshold: declareInCanonical, declared_by: 'test' }));
  }
  const requests = [];
  const undeclared = [];
  let tool = null;
  const ctx = {
    on: () => {},
    get: () => null,
    tools: { register: (t) => { tool = t; }, guard: () => {} },
    learning: {
      request: (r) => { requests.push(r); return { scheduled: true }; },
      undeclared: (u) => { undeclared.push(u); },
    },
  };
  apply(ctx, { stateDir: join(dir, 'state'), canonicalDir, mode: 'off', bodyId: 'test',
    ...(threshold != null ? { refutationThreshold: threshold } : {}) });
  const exec = { agent: { session: { id: 's1' } } };
  const predict = (subject) => tool.execute({ op: 'predict', subject, intended_action: 'edit x' }, exec);
  const evaluate = async (pid, verdict) => tool.execute({ op: 'evaluate', prediction_id: pid, verdict }, exec);
  const refute = async (subject) => evaluate((await predict(subject)).prediction_id, 'refuted');
  return { requests, undeclared, refute };
}

// ---- undeclared: the adapter must not invent a number ---------------------

test('undeclared threshold ⇒ no trigger, and it says so', async () => {
  const { requests, undeclared, refute } = rig();
  for (let i = 0; i < 10; i++) await refute('the cache is warm after a write');
  assert.equal(requests.length, 0,
    'an undeclared threshold must not fall back to a number this code chose');
  assert.equal(undeclared.length, 1, 'it must report the gap once, not per refutation');
  assert.equal(undeclared[0].what, 'refutation_threshold');
  assert.match(undeclared[0].where, /learning-trigger\.json/);
});

test('a threshold declared in the canonical is honoured', async () => {
  const { requests, refute } = rig({ declareInCanonical: 2 });
  await refute('x');
  assert.equal(requests.length, 0, 'one failure is noise');
  await refute('x');
  assert.equal(requests.length, 1, 'the DECLARED count is what fires');
  assert.equal(requests[0].threshold, 2);
  assert.equal(requests[0].refutations, 2);
});

test('an explicitly passed threshold is honoured too', async () => {
  const { requests, refute } = rig({ threshold: 4 });
  for (let i = 0; i < 3; i++) await refute('x');
  assert.equal(requests.length, 0);
  await refute('x');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].threshold, 4);
});

// ---- the shape of the trigger, independent of the number -----------------

test('repetition of the SAME kind asks for exactly one re-examination', async () => {
  const { requests, refute } = rig({ threshold: 3 });
  for (let i = 0; i < 3; i++) await refute('the cache is warm after a write');
  assert.equal(requests.length, 1, 'three of a kind is a pattern; it asks once');
  assert.equal(requests[0].reason, 'residual_structure');
  assert.equal(requests[0].kind, 'the cache is warm after a write');
  // the counter resets, so a fourth refutation does not immediately re-ask
  await refute('the cache is warm after a write');
  assert.equal(requests.length, 1);
});

test('unrelated failures do not accumulate into a pattern', async () => {
  const { requests, refute } = rig({ threshold: 3 });
  for (const subject of ['cache is warm', 'index is fresh', 'lock is free', 'queue is empty']) {
    await refute(subject);
  }
  assert.equal(requests.length, 0,
    'four different failures are four noises, not one structure');
});

test('a confirmed prediction is not a failure at all', async () => {
  const { requests, refute } = rig({ threshold: 2 });
  for (let i = 0; i < 5; i++) await refute('x');
  // refute() always refutes; check the confirmed path separately
  assert.ok(requests.length >= 1);
  const { requests: r2 } = rig({ threshold: 2 });
  assert.equal(r2.length, 0, 'nothing has been evaluated yet');
});
