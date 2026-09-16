/**
 * M2 governance kernel semantics — real AttestedPolicy + PredictionStore on a
 * real temp filesystem. The classifier is injected (host stays neutral).
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { instancePaths } from '../src/core/instance.js';
import { AuditWriter } from '../src/core/audit.js';
import { AttestedPolicy } from '../src/core/policy.js';
import { PredictionStore } from '../src/core/prediction.js';
import { GovernanceKernel } from '../src/core/governance.js';

function fixture(policyDoc = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pai-gov-'));
  const canonicalDir = join(dir, 'canonical');
  mkdirSync(canonicalDir, { recursive: true });
  writeFileSync(join(canonicalDir, 'policy.json'), JSON.stringify({
    version: 1,
    deny: [],
    tools: {},
    riskActions: { destructive: 'deny', privilege: 'deny', network: 'allow' },
    ...policyDoc,
  }));
  const paths = instancePaths(dir);
  const audit = new AuditWriter(paths);
  const policy = new AttestedPolicy(canonicalDir);
  const predictions = new PredictionStore(canonicalDir);
  return { dir, paths, audit, policy, predictions, canonicalDir };
}

const ctx = (over = {}) => ({
  toolName: 'write', toolCallId: 'tc-1', args: { path: 'worktree/a.txt' }, ...over,
});

test('policy drift is fail-closed and terminates the batch', async () => {
  const { audit, policy, predictions, canonicalDir } = fixture();
  const kernel = new GovernanceKernel({ audit, policy, predictions });
  // drift the canonical policy under the live session
  writeFileSync(join(canonicalDir, 'policy.json'), JSON.stringify({ version: 2 }));
  const d = await kernel.decideToolCall(ctx());
  assert.equal(d.block, true);
  assert.equal(d.terminate, true);
  assert.equal(d.rule, 'policy_drift');
});

test('explicit tool deny rule blocks with repair guidance', async () => {
  const { audit, policy, predictions } = fixture({
    tools: { dangerous: { action: 'deny', repair: 'use safe-tool instead' } },
  });
  const kernel = new GovernanceKernel({ audit, policy, predictions });
  const d = await kernel.decideToolCall(ctx({ toolName: 'dangerous' }));
  assert.equal(d.block, true);
  assert.equal(d.rule, 'tool_denied');
  assert.equal(d.repair, 'use safe-tool instead');
});

test('negative capability: args targeting protected roots are denied', async () => {
  const { audit, policy, predictions, paths } = fixture();
  const kernel = new GovernanceKernel({
    audit, policy, predictions,
    protectedRoots: [paths.auditDir],
  });
  const d = await kernel.decideToolCall(ctx({
    args: { path: join(paths.auditDir, 'host-audit.jsonl') },
  }));
  assert.equal(d.block, true);
  assert.equal(d.rule, 'negative_capability');
});

test('command classification maps risk classes onto policy actions', async () => {
  const { audit, policy, predictions } = fixture();
  const kernel = new GovernanceKernel({
    audit, policy, predictions,
    commandArgs: { shell: 'command' },
    commandClassifier: async (source) => source.includes('rm -rf')
      ? { units: [{ raw: source }], parseError: null, risk: 'destructive' }
      : { units: [{ raw: source }], parseError: null, risk: 'benign' },
  });
  const denied = await kernel.decideToolCall(ctx({ toolName: 'shell', args: { command: 'rm -rf /' } }));
  assert.equal(denied.block, true);
  assert.equal(denied.rule, 'risk_destructive');
  const ok = await kernel.decideToolCall(ctx({ toolName: 'shell', args: { command: 'ls -la' } }));
  assert.equal(ok, undefined);
});

test('unparseable commands are unverifiable — denied', async () => {
  const { audit, policy, predictions } = fixture();
  const kernel = new GovernanceKernel({
    audit, policy, predictions,
    commandArgs: { shell: 'command' },
    commandClassifier: async () => ({ units: [], parseError: 'parse produced ERROR nodes', risk: 'unknown' }),
  });
  const d = await kernel.decideToolCall(ctx({ toolName: 'shell', args: { command: '???' } }));
  assert.equal(d.block, true);
  assert.equal(d.rule, 'command_unparseable');
});

test('prediction binding: open prediction admits + records binding', async () => {
  const { audit, policy, predictions } = fixture({
    tools: { world_model_write: { requiresPrediction: true } },
  });
  const kernel = new GovernanceKernel({ audit, policy, predictions });
  const noPred = await kernel.decideToolCall(ctx({ toolName: 'world_model_write' }));
  assert.equal(noPred.block, true);
  assert.equal(noPred.rule, 'prediction_required');

  const pred = predictions.open({ claim: 'x will happen' });
  const ok = await kernel.decideToolCall(ctx({
    toolName: 'world_model_write',
    args: { predictionId: pred.id, delta: {} },
  }));
  assert.equal(ok, undefined);
  assert.equal(predictions.bindings(pred.id).length, 1);

  // closed prediction cannot accept new bindings
  predictions.close(pred.id, 'done');
  const closed = await kernel.decideToolCall(ctx({
    toolName: 'world_model_write',
    args: { predictionId: pred.id, delta: {} },
  }));
  assert.equal(closed.block, true);
  assert.equal(closed.rule, 'prediction_binding_failed');
});

test('admitted calls are audited', async () => {
  const { audit, policy, predictions, paths } = fixture();
  const kernel = new GovernanceKernel({ audit, policy, predictions });
  await kernel.decideToolCall(ctx());
  const log = readFileSync(join(paths.auditDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf-8');
  assert.ok(log.includes('TOOL_CALL_ADMITTED'));
});
