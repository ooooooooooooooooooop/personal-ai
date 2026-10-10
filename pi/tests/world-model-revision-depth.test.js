/**
 * Revision depth (rubric D3) and mismatch diagnosis (rubric D4).
 *
 * The tool previously offered only `param | structural | representation`, so the
 * deepest level was simply not on the menu — the agent could not ask the question
 * D3 names: "是不是 H1/H2/H3 根本切错问题了". D4's diagnostic list was absent
 * altogether. Both live in the TOOL descriptions, not the instruction slot: the
 * agent reads them where it acts, and the instruction slot has a per-turn budget.
 *
 * D3 also says the taxonomy marks upgrade SPACE — it does not require four
 * separate mechanisms, and the order is not fixed. So the tool records depth; it
 * does not enforce a ladder.
 */
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/adapter/world-model.js';

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'pai-wm-depth-'));
  let tool = null;
  apply({
    on: () => {}, get: () => null,
    tools: { register: (t) => { tool = t; }, guard: () => {} },
  }, { stateDir: join(dir, 'state'), canonicalDir: join(dir, 'canonical'), mode: 'off', bodyId: 'test' });
  const exec = { agent: { session: { id: 's1' } } };
  return { dir, tool, exec };
}

test('the deepest revision depth is on the menu, and the taxonomy is named in full', () => {
  const { tool } = rig();
  const d = tool.parameters.properties.revision_type.description;
  for (const depth of ['param', 'structural', 'representation', 'ontological']) {
    assert.match(d, new RegExp(depth), `revision_type must offer ${depth}`);
  }
  // D3: depth is a mark, not a ladder
  assert.match(d, /not a fixed ladder|Not a fixed ladder/);
});

test('the mismatch kinds and the higher-level checks are named', () => {
  const { tool } = rig();
  const d = tool.parameters.properties.residual_diagnosis.description;
  for (const kind of ['isolated anomaly', 'systematic pattern', 'boundary failure',
    'new entity type', 'measurement problem']) {
    assert.match(d, new RegExp(kind), `residual_diagnosis must name ${kind}`);
  }
  // D4: a structured mismatch sends you higher up before re-tuning
  assert.match(d, /measurement/);
  assert.match(d, /representation/);
  assert.match(d, /hypothesis space/);
});

test('an ontological revision is recorded, not rejected', async () => {
  const { dir, tool, exec } = rig();
  const p = await tool.execute({ op: 'predict', subject: 'x', intended_action: 'edit y' }, exec);
  await tool.execute({ op: 'evaluate', prediction_id: p.prediction_id, verdict: 'refuted' }, exec);
  const r = await tool.execute({
    op: 'update', prediction_id: p.prediction_id, model_id: 'M-x',
    revision_type: 'ontological', residual_diagnosis: 'systematic pattern',
    change: 'the question was mis-cut',
  }, exec);
  assert.equal(r.ok, true, JSON.stringify(r));

  // and it lands in the ledger event, so the depth is auditable afterwards
  const led = join(dir, 'state', 'ledger');
  const lines = readdirSync(led).flatMap((f) => readFileSync(join(led, f), 'utf-8').split('\n'));
  const ev = lines.filter(Boolean).map((l) => JSON.parse(l))
    .find((e) => e.event_type === 'MODEL_UPDATED');
  assert.ok(ev, 'MODEL_UPDATED must be emitted');
  assert.match(ev.happened, /ontological/);
  assert.match(ev.happened, /systematic pattern/);
});
