/**
 * adapter §9 (theory-v0.5 §十一-9 / 02[47]): every event carries a namespace
 * stamped by CHANNEL, and a MODEL_INTERNAL record can never be cited as
 * another prediction's world evidence — inference must not re-enter as fact.
 *
 * Before this change the observe op accepted free text straight into
 * OBSERVATION_RECORDED with nothing distinguishing "pytest printed FAIL"
 * (real evidence) from "I believe the cause is X" (the model's own account).
 * Found by the original-theory acceptance: declared in adapter.md §9 but
 * unmechanised anywhere on the implementation surface.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/adapter/world-model.js';

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'pai-wm-ns-'));
  const canonicalDir = join(dir, 'canonical');
  const stateDir = join(dir, 'state');
  mkdirSync(canonicalDir, { recursive: true });
  writeFileSync(join(canonicalDir, 'current.yaml'), 'world_model:\n  models: {}\n');
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
    for (const f of readdirSync(d).filter(n => n.endsWith('.jsonl'))) {
      for (const l of readFileSync(join(d, f), 'utf8').split('\n')) {
        if (l.trim()) out.push(JSON.parse(l));
      }
    }
    return out;
  };
  return { tool, exec, handlers, ledger };
}

test('channel-stamped namespace: harness events EXTERNAL_REALITY, model-authored MODEL_INTERNAL', async () => {
  const { tool, exec, handlers, ledger } = rig();
  handlers['tools/result']({ name: 'bash', agent: { session: { id: 's1' } } }, 'PASS 42 tests');
  await tool.execute({ op: 'activate', mode: 'core' }, exec);
  await tool.execute({ op: 'predict', subject: 'x', intended_action: 'write', falsifier: 'z' }, exec);

  const ev = Object.fromEntries(ledger().map(e => [e.event_type, e]));
  assert.equal(ev.RAW_EVIDENCE.namespace, 'EXTERNAL_REALITY', 'auto-captured tool result is world evidence');
  assert.equal(ev.WM_ACTIVATE.namespace, 'EXTERNAL_REALITY', 'system state change is world fact');
  assert.equal(ev.PREDICTION_CREATED.namespace, 'MODEL_INTERNAL', 'a prediction is the model\u2019s own claim');
});

test('observe: entity-declared namespace with conservative default', async () => {
  const { tool, exec, ledger } = rig();
  const p = await tool.execute({ op: 'predict', subject: 'x', intended_action: 'write', falsifier: 'z' }, exec);
  await tool.execute({ op: 'observe', prediction_id: p.prediction_id, observation: 'pytest printed FAIL' }, exec);
  await tool.execute({ op: 'observe', prediction_id: p.prediction_id, observation: 'saw real output', namespace: 'EXTERNAL_REALITY' }, exec);
  await tool.execute({ op: 'observe', prediction_id: p.prediction_id, observation: 'bogus value', namespace: 'GALACTIC' }, exec);

  const obs = ledger().filter(e => e.event_type === 'OBSERVATION_RECORDED');
  assert.equal(obs[0].namespace, 'MODEL_INTERNAL', 'unmarked observation clamps to the conservative side');
  assert.equal(obs[1].namespace, 'EXTERNAL_REALITY', 'explicit declaration is honoured');
  assert.equal(obs[2].namespace, 'MODEL_INTERNAL', 'unrecognised value cannot self-escalate');
});

test('MODEL_INTERNAL events cannot be cited as world evidence (adapter §9)', async () => {
  const { tool, exec, ledger } = rig();
  const p = await tool.execute({ op: 'predict', subject: 'x', intended_action: 'write', falsifier: 'z' }, exec);
  const internalEv = ledger().find(e => e.event_type === 'PREDICTION_CREATED');

  const bad = await tool.execute({
    op: 'observe', prediction_id: p.prediction_id, observation: 'citing my own claim',
    evidence_refs: [internalEv.event_id],
  }, exec);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'EVIDENCE_MODEL_INTERNAL');
});

test('EXTERNAL_REALITY events remain citeable; foreign/unresolvable refs pass through', async () => {
  const { tool, exec, handlers, ledger } = rig();
  handlers['tools/result']({ name: 'bash', agent: { session: { id: 's1' } } }, 'exit 0');
  const rawEv = ledger().find(e => e.event_type === 'RAW_EVIDENCE');
  const p = await tool.execute({ op: 'predict', subject: 'x', intended_action: 'write', falsifier: 'z' }, exec);

  const good = await tool.execute({
    op: 'observe', prediction_id: p.prediction_id, observation: 'saw the real tool output',
    namespace: 'EXTERNAL_REALITY', evidence_refs: [rawEv.event_id, 'commit:abc123'],
  }, exec);
  assert.equal(good.ok, true, 'real evidence refs and external pointers are citeable');
});

test('confidence ceiling: high confidence without a falsifier is refused (§七 conditional gate)', async () => {
  const { tool, exec } = rig();
  const refused = await tool.execute({ op: 'predict', subject: 'x', intended_action: 'write', confidence_bucket: 'high' }, exec);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'CONFIDENCE_WITHOUT_FALSIFIER');

  const ok1 = await tool.execute({ op: 'predict', subject: 'x', intended_action: 'write', confidence_bucket: 'high', falsifier: 'test fails' }, exec);
  assert.equal(ok1.ok, true, 'high + falsifier is a discriminating claim');
  const ok2 = await tool.execute({ op: 'predict', subject: 'x', intended_action: 'write', confidence_bucket: 'medium' }, exec);
  assert.equal(ok2.ok, true, 'non-high confidence is not gated — adapter keeps falsifier discipline-level below high');
});
