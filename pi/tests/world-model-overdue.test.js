/**
 * 04[msg 7]「时间失效」: an observation that should have arrived by the
 * horizon and did not IS negative evidence. Before this change `time_horizon`
 * was stored on the prediction record and never read again — a prediction
 * could sit open past its deadline forever with nothing noticing the lapse.
 *
 * Found by the original-theory acceptance (theory/sources/04, A股 pilot):
 * field-present-but-inert. The mechanism: horizon → horizon_deadline at
 * open(); open predictions past deadline surface three ways —
 *   1. openPredictions() projects `overdue` into the context envelope
 *   2. the first session event emits SESSION_EVENT prediction_overdue
 *      (EXTERNAL_REALITY — the clock passing is a recorded world fact),
 *      deduped durably by stale_notified
 *   3. world_model status lists overdue_predictions
 * Surfacing ≠ refuting: the verdict still belongs to evaluate.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/adapter/world-model.js';
import { PredictionStore, parseHorizonDeadline } from '../../host/src/core/prediction.js';

function rig(stateDir = null, canonicalDir = null) {
  const dir = mkdtempSync(join(tmpdir(), 'pai-wm-od-'));
  canonicalDir = canonicalDir ?? join(dir, 'canonical');
  stateDir = stateDir ?? join(dir, 'state');
  mkdirSync(canonicalDir, { recursive: true });
  if (!existsSync(join(canonicalDir, 'current.yaml'))) writeFileSync(join(canonicalDir, 'current.yaml'), 'world_model:\n  models: {}\n');
  let tool = null;
  const handlers = {};
  apply({
    on: (name, fn) => { handlers[name] = fn; }, get: () => null,
    tools: { register: (t) => { tool = t; }, guard: () => {} },
  }, { stateDir, canonicalDir, mode: 'core', bodyId: 'test' });
  const exec = { agent: { session: { id: 's1' } } };
  const ledger = () => {
    const d = join(stateDir, 'ledger');
    const out = [];
    for (const f of readdirSync(d).filter((n) => n.endsWith('.jsonl'))) {
      for (const l of readFileSync(join(d, f), 'utf8').split('\n')) {
        if (l.trim()) out.push(JSON.parse(l));
      }
    }
    return out;
  };
  return { tool, exec, handlers, ledger, stateDir, canonicalDir };
}

test('parseHorizonDeadline: ISO date, datetime, relative shorthand; unparseable → null', () => {
  const base = Date.parse('2026-10-10T00:00:00Z');
  assert.equal(parseHorizonDeadline('+3d', base), base + 3 * 86400e3);
  assert.equal(parseHorizonDeadline('+12h', base), base + 12 * 3600e3);
  assert.ok(parseHorizonDeadline('2020-01-01') < Date.now(), 'past date parses');
  // bare date = through end of that day UTC, not midnight
  assert.equal(parseHorizonDeadline('2026-10-15'), Date.parse('2026-10-15') + 86400e3 - 1);
  assert.ok(parseHorizonDeadline('2999-01-01T00:00:00Z') > Date.now(), 'future datetime parses');
  assert.equal(parseHorizonDeadline('soon'), null);
  assert.equal(parseHorizonDeadline(''), null);
  assert.equal(parseHorizonDeadline(null), null);
});

test('store: open prediction past horizon is stale and projects overdue into openPredictions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-wm-store-'));
  const store = new PredictionStore(dir);
  const a = store.open({ claim: 'X resolves by yesterday', horizon: '2000-01-01' });
  const b = store.open({ claim: 'Y resolves next year', horizon: '+365d' });
  const c = store.open({ claim: 'Z has text horizon', horizon: 'whenever' });

  const stale = store.stale();
  assert.deepEqual(stale.map((p) => p.id), [a.id], 'only the lapsed prediction is stale');
  const opens = store.openPredictions();
  assert.equal(opens.find((p) => p.id === a.id).overdue, true, 'overdue flag rides the context projection');
  assert.equal(opens.find((p) => p.id === b.id).overdue, undefined);
  assert.equal(opens.find((p) => p.id === c.id).overdue, undefined, 'unparseable horizon never mechanizes silently');

  store.markStaleNotified([a.id]);
  const store2 = new PredictionStore(dir);
  assert.equal(store2.index[a.id].stale_notified, true, 'stale_notified survives restart');
});

test('adapter: overdue prediction emits SESSION_EVENT once, status reports it, dedup durable across restart', async () => {
  const r1 = rig();
  const p = await r1.tool.execute({ op: 'predict', subject: 'x', intended_action: 'write', falsifier: 'z', time_horizon: '2000-01-01' }, r1.exec);
  const q = await r1.tool.execute({ op: 'predict', subject: 'y', intended_action: 'write', falsifier: 'z' }, r1.exec);

  r1.handlers['session/event']({ id: 's1' }, { type: 'turn/start' });
  const overdue1 = r1.ledger().filter((e) => e.subject === 'prediction_overdue');
  assert.equal(overdue1.length, 1, 'one lapse event for the lapsed prediction only');
  assert.equal(overdue1[0].payload.prediction_id, p.prediction_id);
  assert.equal(overdue1[0].namespace, 'EXTERNAL_REALITY', 'the clock passing is a recorded world fact');

  r1.handlers['session/event']({ id: 's1' }, { type: 'step/start' });
  r1.handlers['session/event']({ id: 's1' }, { type: 'user/message' });
  assert.equal(r1.ledger().filter((e) => e.subject === 'prediction_overdue').length, 1, 'no repeat within the session');

  const st = await r1.tool.execute({ op: 'status' }, r1.exec);
  assert.deepEqual(st.overdue_predictions.map((o) => o.id), [p.prediction_id], 'status surfaces the lapse; the no-horizon prediction does not appear');
  assert.equal(st.overdue_predictions[0].horizon, '2000-01-01');

  const r2 = rig(r1.stateDir, r1.canonicalDir);
  r2.handlers['session/event']({ id: 's2' }, { type: 'turn/start' });
  // r2 reads the same shared ledger — the r1 event is still there; what must
  // NOT appear is a SECOND emission for the same prediction.
  const overdue2 = r2.ledger().filter((e) => e.subject === 'prediction_overdue' && e.payload.prediction_id === p.prediction_id);
  assert.equal(overdue2.length, 1, 'a lapse already recorded does not re-emit after restart — stale_notified is durable');
  assert.ok(q.prediction_id);
});

test('status.revision_pulse: 03[msg15] — "how long since anything actually changed the model" is answerable', async () => {
  const { tool, exec } = rig();
  const st0 = await tool.execute({ op: 'status' }, exec);
  assert.equal(st0.revision_pulse.last_model_change, null, 'honest null before any model change');
  assert.equal(st0.revision_pulse.last_refuted, null);

  const p = await tool.execute({ op: 'predict', subject: 'x', intended_action: 'write', falsifier: 'z' }, exec);
  await tool.execute({ op: 'evaluate', prediction_id: p.prediction_id, verdict: 'refuted' }, exec);
  await tool.execute({
    op: 'update', prediction_id: p.prediction_id, model_id: 'M-x',
    revision_type: 'variable', residual_diagnosis: 'systematic pattern', change: 'add omitted variable',
  }, exec);

  const st = await tool.execute({ op: 'status' }, exec);
  assert.equal(st.revision_pulse.last_model_change.type, 'MODEL_UPDATED', 'the newest model-changing event is found');
  assert.ok(st.revision_pulse.last_refuted?.event_id, 'the newest refuted verdict is found — learning-system vs explanation-system is observable');
});
