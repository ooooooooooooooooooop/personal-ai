/**
 * The EXIT gate — the entry gate's mirror.
 *
 * The entry gate makes you open a loop before you act. Nothing made you close it,
 * and two real cross-session runs showed the loop stopping at observation every
 * time: predict → act → observe → 【stop】. `observe` does not settle a prediction
 * and `update` refuses one with no evidence, so an entity that stops at observation
 * left the loop open — predictions accumulated and never became belief.
 *
 * The gate is deliberately NOT "you must have evaluated": a prediction about how
 * the world will be found LATER cannot be settled now, and 跨阶段/跨会话继续 is one
 * of the gate criteria's own reasons to be in CORE. A hard requirement would
 * deadlock exactly the case the mechanism exists for. So it refuses only the
 * DANGLING case — open, never settled, and never declared. `persist` is the
 * declaration.
 */
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/adapter/world-model.js';

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'pai-wm-exit-'));
  const canonicalDir = join(dir, 'canonical');
  mkdirSync(canonicalDir, { recursive: true });
  let guard = null, tool = null;
  apply({
    on: () => {}, get: () => null,
    tools: { register: (t) => { tool = t; }, guard: (fn) => { guard = fn; } },
  }, { stateDir: join(dir, 'state'), canonicalDir, mode: 'core', bodyId: 'test' });
  const exec = { agent: { session: { id: 's1' } } };
  const deny = (name, args) => guard({ name, arguments: args, agent: { session: { id: 's1' } } });
  const predict = (ia) => tool.execute({ op: 'predict', subject: 'x', intended_action: ia }, exec);
  return { tool, exec, deny, predict, stateDir: join(dir, 'state') };
}

test('a second loop may not be opened while the first is still dangling', async () => {
  const { tool, exec, deny, predict } = rig();
  const a = await predict('write file one');
  assert.equal(deny('write', { path: 'one' }), undefined, 'the first loop opens and acts');

  // Open a second loop, then try to act on it. The FIRST one is still dangling.
  const b = await predict('write file two');
  const blocked = deny('write', { path: 'two' });
  assert.match(String(blocked), /BLOCKED/);
  // The call binds to ONE of the two; the denial names the OTHER — the one left
  // dangling. (Whichever it picks, exactly one of them must be named.)
  assert.ok(String(blocked).includes(a.prediction_id) || String(blocked).includes(b.prediction_id),
    'the denial must name the prediction that is dangling');
  assert.match(String(blocked), /persist/, 'and must say how to declare a deliberate carry');

  // Settle the first: observe then evaluate → the second is free to proceed.
  await tool.execute({ op: 'observe', prediction_id: a.prediction_id, observation: 'one exists' }, exec);
  await tool.execute({ op: 'evaluate', prediction_id: a.prediction_id, verdict: 'confirmed' }, exec);
  assert.equal(deny('write', { path: 'two' }), undefined, 'settling the first frees the second');
  assert.ok(b.prediction_id);
});

test('a SINGLE loop cannot be caught by the guard — persist is where it is caught', async () => {
  const { tool, exec, deny, predict } = rig();
  await predict('write file one');

  // The guard permits this: the call BINDS to the one open prediction, so it is
  // the continuation of that loop, not a second one. This is exactly why the
  // measured defect (predict → act → observe → stop) cannot be caught here —
  // once the task ends there is no next call to refuse.
  assert.equal(deny('write', { path: 'two' }), undefined,
    'a single open loop is the loop this call belongs to');

  // The end-of-task step is the one place that CAN catch it.
  const silent = await tool.execute({ op: 'persist' }, exec);
  assert.equal(silent.ok, false);
  assert.equal(silent.code, 'CARRY_UNDECLARED');
  assert.match(silent.message, /open and unevaluated/);
  assert.match(silent.message, /carrying them deliberately/);

  // Say why, and it goes through — the legitimate cross-session case.
  const declared = await tool.execute({ op: 'persist', summary: 'carrying into the next session' }, exec);
  assert.equal(declared.ok, true);
  assert.equal(declared.open_predictions.length, 1);
});

test('the carry is recorded, not silent — and survives the process', async () => {
  const { tool, exec, stateDir } = rig();
  await tool.execute({ op: 'predict', subject: 'x', intended_action: 'write file one' }, exec);
  const r = await tool.execute({ op: 'persist', summary: 'into the next session' }, exec);
  assert.equal(r.ok, true);
  assert.equal(r.open_predictions.length, 1, 'the carried prediction is still open, and named');

  // Recorded on disk with the carry flag, so a restart does not treat inherited
  // work as something this session opened and left dangling.
  const doc = JSON.parse(readFileSync(join(stateDir, 'current.json'), 'utf-8'));
  assert.equal(doc.open_predictions.length, 1);
  assert.equal(doc.open_predictions[0].carried, true,
    'the carry must be a recorded fact, not an omission');
});

test('an evaluated loop leaves nothing dangling behind it', async () => {
  const { tool, exec, deny, predict } = rig();
  const a = await predict('write file one');
  await tool.execute({ op: 'observe', prediction_id: a.prediction_id, observation: 'ok' }, exec);
  await tool.execute({ op: 'evaluate', prediction_id: a.prediction_id, verdict: 'confirmed' }, exec);
  await predict('write file two');
  assert.equal(deny('write', { path: 'two' }), undefined,
    'a settled loop is not a dangling one');
});

/**
 * The §九 guarantee, tested separately from the exit gate because it is a
 * different claim. theory-v0.5 §九 lists what the mechanism DOES guarantee, and
 * one entry is 「关闭/拦截通道存在」 — the close/intercept channel exists.
 *
 * `evaluate` is that channel, and it used to resolve ids only against
 * `openPreds`, which was rebuilt from `current.json` alone. A prediction left
 * open by an earlier session lives in the instance's prediction store: the
 * entity SEES it (it is in the <open-predictions> block) but could not close it.
 * A channel that works for some predictions and not others is not the channel
 * §九 claims.
 */
test('the close channel reaches a prediction left open by an EARLIER session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-wm-inherit-'));
  const canonicalDir = join(dir, 'canonical');
  mkdirSync(canonicalDir, { recursive: true });

  // An earlier session's prediction, sitting open in the instance state dir
  // (predictions moved canonicalDir -> stateDir, owner-adjudicated boundary
  // 2026-10-10; this fixture follows the boundary).
  const { PredictionStore } = await import('../../host/src/core/prediction.js');
  const store = new PredictionStore(join(dir, 'state'));
  const older = store.open({ claim: 'the file from last time still has 41', actor: 'pi' });
  assert.ok(older && older.id, 'fixture: a prediction must exist to inherit');

  let guard = null, tool = null;
  apply({
    on: () => {}, get: () => null,
    tools: { register: (t) => { tool = t; }, guard: (fn) => { guard = fn; } },
  }, { stateDir: join(dir, 'state'), canonicalDir, mode: 'core', bodyId: 'test' });
  const exec = { agent: { session: { id: 's2' } } };

  // It can be CLOSED — the channel reaches it. (Before the fix: PREDICTION_UNKNOWN.)
  const r = await tool.execute({
    op: 'evaluate', prediction_id: older.id, verdict: 'confirmed',
  }, exec);
  assert.equal(r.ok, true, 'the close channel must reach it: ' + JSON.stringify(r));
  assert.equal(r.prediction_id, older.id);

  // And it does NOT block this session's OWN work: it is not a loop THIS session
  // left dangling. Blocking would deadlock — nothing ever declares a carry
  // (measured: 0 STATE_PERSISTED across 8 real sessions), so every session would
  // be stopped by its predecessor's leftovers.
  //
  // Open this session's own loop first: without one the ENTRY gate fires, which
  // is correct and would mask what this test is about.
  await tool.execute({ op: 'predict', subject: 'x', intended_action: 'write file x' }, exec);
  assert.equal(guard({ name: 'write', arguments: { path: 'x' }, agent: { session: { id: 's2' } } }),
    undefined, 'an inherited prediction must not gate this session');
});
