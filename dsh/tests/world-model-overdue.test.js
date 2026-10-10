/**
 * 04[msg 7]「时间失效」— dsh side parity with pi/tests/world-model-overdue.
 * The dsh plugin owns its own current.json (no host PredictionStore), so the
 * horizon→deadline machinery rides `prediction_meta` merged on persist and
 * checked at session restore. stale_notified lives in that meta — durable
 * dedup, same contract as the store-side flag.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../world-model/world-model.mjs';

function rig(stateDir = null, canonicalDir = null) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wm-od-'));
  canonicalDir = canonicalDir ?? join(dir, 'canonical');
  stateDir = stateDir ?? join(dir, 'state');
  mkdirSync(canonicalDir, { recursive: true });
  let tool = null;
  const handlers = {};
  apply({
    on: (name, fn) => { handlers[name] = fn; }, get: () => null,
    tools: { register: (t) => { tool = t; }, guard: () => {} },
  }, { stateDir, canonicalDir, mode: 'core', bodyId: 'dsh-test' });
  const exec = { agent: { session: { id: 's1' } } };
  const ledger = () => {
    const d = join(stateDir, 'ledger');
    if (!existsSync(d)) return [];
    const out = [];
    for (const f of readdirSync(d).filter((n) => n.endsWith('.jsonl'))) {
      for (const l of readFileSync(join(d, f), 'utf8').split('\n')) {
        if (l.trim()) { try { out.push(JSON.parse(l)); } catch { /* torn tail */ } }
      }
    }
    return out;
  };
  return { tool, exec, handlers, ledger, stateDir, canonicalDir };
}

test('dsh: overdue restored prediction emits once; prediction_meta dedup durable across restart', async () => {
  // session 1: predict + persist WITHOUT any session/event — the lapse is
  // recorded in prediction_meta with stale_notified=false, as if the process
  // died before anyone looked.
  const r1 = rig();
  const p = await r1.tool.execute({ op: 'predict', subject: 'x', intended_action: 'write', falsifier: 'z', time_horizon: '2000-01-01' }, r1.exec);
  assert.equal(p.ok, true);
  const per = await r1.tool.execute({ op: 'persist', summary: 'carry' }, r1.exec);
  assert.equal(per.ok, true);

  const cur = JSON.parse(readFileSync(join(r1.stateDir, 'current.json'), 'utf8'));
  assert.ok(cur.prediction_meta[p.prediction_id], 'horizon metadata persisted alongside the open prediction');
  assert.ok(cur.prediction_meta[p.prediction_id].horizon_deadline < Date.now());
  assert.equal(cur.prediction_meta[p.prediction_id].stale_notified, false);

  // session 2 (fresh process on same wmDir): restore detects the lapse
  const r2 = rig(r1.stateDir, r1.canonicalDir);
  r2.handlers['session/event']({ id: 's2' }, { type: 'user/message' });
  const overdue = r2.ledger().filter((e) => e.subject === 'prediction_overdue');
  assert.equal(overdue.length, 1, 'the restored lapse enters the evidence stream');
  assert.equal(overdue[0].payload.prediction_id, p.prediction_id);

  // stale_notified was written back — a third process must not re-emit
  const cur2 = JSON.parse(readFileSync(join(r1.stateDir, 'current.json'), 'utf8'));
  assert.equal(cur2.prediction_meta[p.prediction_id].stale_notified, true, 'write-back persisted');
  const r3 = rig(r1.stateDir, r1.canonicalDir);
  r3.handlers['session/event']({ id: 's3' }, { type: 'user/message' });
  // shared ledger: r2's emission is still visible — what must not appear is
  // a SECOND event for the same prediction.
  assert.equal(r3.ledger().filter((e) => e.subject === 'prediction_overdue' && e.payload.prediction_id === p.prediction_id).length, 1, 'no re-emit on second restart');

  const st = await r3.tool.execute({ op: 'status' }, { agent: { session: { id: 's3' } } });
  assert.deepEqual(st.overdue_predictions.map((o) => o.id), [p.prediction_id], 'status surfaces the still-open lapse');
});
