/**
 * Evaluation awareness (theory-v0.5 §六 / adapter contract item 6).
 *
 * When the entity knows the evaluation goal, rules or treatment, the
 * observation's EXTERNAL VALIDITY changes — it is no longer a clean reading of
 * the world. This pilot is exactly the case that needs it: H1/H2/H3 are claims
 * about the entity's OWN mechanism benefit, and the entity both runs the tasks
 * and produces the conclusions. Without this recorded, an observation made by an
 * informed executor, judged by a non-blind evaluator, on a self-assessed outcome
 * looks IDENTICAL in the ledger to one made blind — and the two are not the same
 * evidence.
 *
 * The four fields are the ones the contract names; the values are the pilot's to
 * define.
 */
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/adapter/world-model.js';

const NAMED = ['task_source', 'executor_informed', 'evaluator_blind', 'outcome_objective'];

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'pai-wm-evalaware-'));
  let tool = null;
  apply({
    on: () => {}, get: () => null,
    tools: { register: (t) => { tool = t; }, guard: () => {} },
  }, { stateDir: join(dir, 'state'), canonicalDir: join(dir, 'canonical'), mode: 'off', bodyId: 'test' });
  return { dir, tool, exec: { agent: { session: { id: 's1' } } } };
}

test('the four named conditions are on the tool, each saying why it matters', () => {
  const { tool } = rig();
  for (const f of NAMED) {
    const d = tool.parameters.properties[f]?.description;
    assert.ok(d, `${f} must be a tool parameter`);
    assert.match(d, /observe:/, `${f} should declare which op records it`);
  }
  // the reason must be visible at the point of use, not only in a spec
  // The VALUES come from the pilot's own draft (theory/sources/13 §6), not invented here
  assert.match(tool.parameters.properties.task_source.description, /自然任务/);
  assert.match(tool.parameters.properties.task_source.description, /different evidence/);
  assert.match(tool.parameters.properties.outcome_objective.description, /same weight/);
});

test('the conditions travel WITH the observation into the ledger', async () => {
  const { dir, tool, exec } = rig();
  const p = await tool.execute({ op: 'predict', subject: 'x', intended_action: 'edit y' }, exec);
  const r = await tool.execute({
    op: 'observe', prediction_id: p.prediction_id,
    observation: 'the run took 4.1s',
    task_source: 'self-chosen from the backlog',
    executor_informed: 'informed',
    evaluator_blind: 'not-applicable',
    outcome_objective: 'self-judged',
  }, exec);
  assert.equal(r.ok, true, JSON.stringify(r));

  const led = join(dir, 'state', 'ledger');
  const ev = readdirSync(led).flatMap((f) => readFileSync(join(led, f), 'utf-8').split('\n'))
    .filter(Boolean).map((l) => JSON.parse(l))
    .find((e) => e.event_type === 'OBSERVATION_RECORDED');
  assert.ok(ev, 'OBSERVATION_RECORDED must be emitted');
  for (const f of NAMED) {
    assert.ok(f in ev.payload, `${f} must be in the payload — it is a property of how this reading was produced`);
  }
  assert.equal(ev.payload.executor_informed, 'informed');
  assert.equal(ev.payload.outcome_objective, 'self-judged');
});

test('omitting them is allowed but leaves explicit nulls, not silence', async () => {
  const { dir, tool, exec } = rig();
  const p = await tool.execute({ op: 'predict', subject: 'x', intended_action: 'edit y' }, exec);
  await tool.execute({ op: 'observe', prediction_id: p.prediction_id, observation: 'something' }, exec);
  const led = join(dir, 'state', 'ledger');
  const ev = readdirSync(led).flatMap((f) => readFileSync(join(led, f), 'utf-8').split('\n'))
    .filter(Boolean).map((l) => JSON.parse(l))
    .find((e) => e.event_type === 'OBSERVATION_RECORDED');
  for (const f of NAMED) {
    assert.ok(f in ev.payload, `${f} must be PRESENT as a key`);
    assert.equal(ev.payload[f], null, `${f} must be an explicit null, not absent`);
  }
});
