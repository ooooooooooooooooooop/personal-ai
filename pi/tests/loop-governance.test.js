/**
 * M3 loop governance extension — handler behavior with a fake pi/ctx,
 * real ContinuationGovernor + real audit on a temp instance.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loopGovernanceExtension } from '../src/adapter/loop.js';
import { instancePaths } from '../../host/src/core/instance.js';
import { AuditWriter } from '../../host/src/core/audit.js';
import { ContinuationGovernor } from '../../host/src/core/continuation.js';
import { PredictionStore } from '../../host/src/core/prediction.js';

function rig(requirements = [{ id: 'wrote', kind: 'tool_success', tool: 'write' }]) {
  const dir = mkdtempSync(join(tmpdir(), 'pai-loop-'));
  const paths = instancePaths(dir);
  const audit = new AuditWriter(paths);
  const canonical = join(dir, 'canonical');
  const predictions = new PredictionStore(canonical);
  const continuation = new ContinuationGovernor({
    ledgerPath: join(dir, 'continuation.jsonl'),
    audit,
    requirements,
  });
  const handlers = {};
  const pi = { on: (event, fn) => { handlers[event] = fn; } };
  loopGovernanceExtension({ continuation, predictions, audit, contextEnvelope: { kind: 'ContextEnvelope', briefing: 'b' } }).factory(pi);
  const sent = [];
  const ctx = { sendUserMessage: (text) => sent.push(text) };
  return { handlers, ctx, sent, dir, audit, predictions };
}

const auditKinds = (dir) =>
  readFileSync(join(dir, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf-8')
    .trim().split('\n').map((l) => JSON.parse(l).kind);

test('agent_end with missing evidence steers a governed continuation', async () => {
  const { handlers, ctx, sent } = rig();
  handlers.turn_end({
    turnIndex: 0,
    message: { content: [{ type: 'text', text: 'done!' }] },
    toolResults: [], // nothing actually ran — evidence gap
  });
  handlers.agent_end({ messages: [] }, ctx);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /EVIDENCE GAP/);
  assert.match(sent[0], /wrote: tool_success/);
});

test('agent_end with satisfied evidence does not steer', async () => {
  const { handlers, ctx, sent } = rig();
  handlers.turn_end({
    turnIndex: 0,
    message: { content: 'ok' },
    toolResults: [{ toolName: 'write', isError: false }],
  });
  handlers.agent_end({ messages: [] }, ctx);
  assert.equal(sent.length, 0);
});

test('evidence is cumulative across turns and continuation runs', async () => {
  const { handlers, ctx, sent } = rig();
  handlers.agent_start();
  handlers.turn_end({
    turnIndex: 0,
    message: { content: 'calling the tool' },
    toolResults: [{ toolName: 'write', isError: false }], // evidence in turn 0
  });
  handlers.turn_end({
    turnIndex: 1,
    message: { content: 'DONE' },
    toolResults: [], // text-only turn must NOT forget turn 0's evidence
  });
  handlers.agent_end({ messages: [] }, ctx);
  assert.equal(sent.length, 0); // complete — no re-gap

  // a fresh user prompt opens a fresh task transcript
  handlers.agent_start();
  handlers.turn_end({ turnIndex: 0, message: { content: 'hi' }, toolResults: [] });
  handlers.agent_end({ messages: [] }, ctx);
  assert.equal(sent.length, 1); // new task re-evaluates, gap reopens
});

test('steered continuation keeps accumulating the same task', async () => {
  const { handlers, ctx, sent } = rig();
  handlers.agent_start();
  handlers.turn_end({ turnIndex: 0, message: { content: 'working' }, toolResults: [] });
  handlers.agent_end({ messages: [] }, ctx);
  assert.equal(sent.length, 1); // gap → steer injected

  // the steer-triggered run is the same task: its transcript keeps prior context
  handlers.agent_start();
  handlers.turn_end({
    turnIndex: 0,
    message: { content: 'now writing' },
    toolResults: [{ toolName: 'write', isError: false }],
  });
  handlers.agent_end({ messages: [] }, ctx);
  assert.equal(sent.length, 1); // evidence closed — no second steer
});

test('compaction events audit reason/willRetry/open predictions', async () => {
  const { handlers, dir, predictions } = rig();
  predictions.open({ claim: 'world stays coherent' });
  handlers.session_before_compact({
    reason: 'overflow', willRetry: true, branchEntries: [1, 2, 3],
    preparation: {}, customInstructions: undefined,
  });
  handlers.session_compact({ reason: 'overflow', willRetry: true, fromExtension: false, compactionEntry: {} });
  const kinds = auditKinds(dir);
  assert.ok(kinds.includes('COMPACT_BEFORE'));
  assert.ok(kinds.includes('COMPACT_DONE'));
  const before = readFileSync(join(dir, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf-8')
    .trim().split('\n').map(JSON.parse).find((e) => e.kind === 'COMPACT_BEFORE');
  assert.equal(before.data.openPredictions, 1);
  assert.equal(before.data.willRetry, true);
});

test('model_select is audited', () => {
  const { handlers, dir } = rig();
  handlers.model_select({ model: { id: 'm2' }, previousModel: { id: 'm1' }, source: 'set' });
  assert.ok(auditKinds(dir).includes('MODEL_SELECT'));
});
