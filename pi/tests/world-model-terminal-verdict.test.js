/**
 * Terminal verdicts are immutable — at BOTH layers.
 *
 * PredictionStore.close() already refuses silently on a terminal record, but
 * the adapter's evaluate op used to keep going: it emitted a second
 * PREDICTION_EVALUATED event for the same prediction, so the append-only
 * ledger the distiller reads could hold confirmed→refuted for one pid.
 * The store held the truth; the trail contradicted it. The p.evaluated flag
 * was written but never read. Found by the theory audit (T11): every claim
 * gets exercised, and this one failed.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/adapter/world-model.js';
import { PredictionStore } from '../../host/src/core/prediction.js';

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'pai-wm-terminal-'));
  const canonicalDir = join(dir, 'canonical');
  const stateDir = join(dir, 'state');
  mkdirSync(canonicalDir, { recursive: true });
  writeFileSync(join(canonicalDir, 'current.yaml'), 'world_model:\n  models: {}\n');
  let tool = null;
  apply({
    on: () => {}, get: () => null,
    tools: { register: (t) => { tool = t; }, guard: () => {} },
  }, { stateDir, canonicalDir, mode: 'core', bodyId: 'test' });
  const exec = { agent: { session: { id: 's1' } } };
  const ledger = () => {
    const d = join(stateDir, 'ledger');
    const out = [];
    for (const f of readdirSync(d).filter(n => n.endsWith('.jsonl'))) {
      for (const l of readFileSync(join(d, f), 'utf8').split('\n')) {
        if (l.trim()) out.push(JSON.parse(l));
      }
    }
    return out;
  };
  return { dir, stateDir, tool, exec, ledger };
}

test('evaluate on an already-evaluated prediction is refused — no contradictory verdict event', async () => {
  const { stateDir, tool, exec, ledger } = rig();
  const p = await tool.execute({ op: 'predict', subject: 'x', intended_action: 'write', expected_observation: 'y', falsifier: 'z' }, exec);
  const e1 = await tool.execute({ op: 'evaluate', prediction_id: p.prediction_id, verdict: 'confirmed' }, exec);
  assert.equal(e1.ok, true);
  const e2 = await tool.execute({ op: 'evaluate', prediction_id: p.prediction_id, verdict: 'refuted' }, exec);
  assert.equal(e2.ok, false, 'second verdict must be refused, not emitted');
  assert.equal(e2.code, 'PREDICTION_ALREADY_EVALUATED');

  const events = ledger().filter(e => e.event_type === 'PREDICTION_EVALUATED' && e.prediction_id === p.prediction_id);
  assert.equal(events.length, 1, 'exactly one verdict event per prediction — the ledger cannot contradict the store');
  const stored = new PredictionStore(stateDir).list().find(r => r.id === p.prediction_id);
  assert.equal(stored.status, 'confirmed', 'store verdict stays the first one');
});
