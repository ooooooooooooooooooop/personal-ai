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

test("policy 'ask' risk action suspends for the operator; allow admits, deny blocks", async () => {
  const { audit, policy, predictions } = fixture({
    riskActions: { destructive: 'ask', privilege: 'deny' },
  });
  const calls = [];
  const kernel = new GovernanceKernel({
    audit, policy, predictions,
    commandArgs: { shell: 'command' },
    commandClassifier: async () => ({ units: [{ raw: 'rm -rf x' }], parseError: null, risk: 'destructive' }),
    ask: async (pending) => { calls.push(pending); return pending.toolCallId === 'tc-yes' ? 'allow' : 'deny'; },
  });
  const admitted = await kernel.decideToolCall(ctx({ toolName: 'shell', toolCallId: 'tc-yes', args: { command: 'rm -rf x' } }));
  assert.equal(admitted, undefined);
  assert.equal(calls[0].rule, 'risk_destructive');
  assert.equal(calls[0].summary, 'command: rm -rf x');
  const denied = await kernel.decideToolCall(ctx({ toolName: 'shell', toolCallId: 'tc-no', args: { command: 'rm -rf x' } }));
  assert.equal(denied.block, true);
  assert.equal(denied.rule, 'ask_deny');
});

test("policy 'ask' with no ask channel fails closed", async () => {
  const { audit, policy, predictions } = fixture({
    tools: { write: { action: 'ask' } },
  });
  const kernel = new GovernanceKernel({ audit, policy, predictions });
  const d = await kernel.decideToolCall(ctx());
  assert.equal(d.block, true);
  assert.equal(d.rule, 'ask_unavailable');
});

test("tool-level 'ask' rule consults the operator; timeout refuses", async () => {
  const { audit, policy, predictions } = fixture({
    tools: { write: { action: 'ask' } },
  });
  const kernel = new GovernanceKernel({
    audit, policy, predictions,
    ask: async () => 'timeout',
  });
  const d = await kernel.decideToolCall(ctx());
  assert.equal(d.block, true);
  assert.equal(d.rule, 'ask_timeout');
});

test("negative capabilities still outrank 'ask' — operators cannot unlock protected roots", async () => {
  const { audit, policy, predictions, paths } = fixture({
    tools: { write: { action: 'ask' } },
  });
  let asked = false;
  const kernel = new GovernanceKernel({
    audit, policy, predictions,
    protectedRoots: [paths.auditDir],
    ask: async () => { asked = true; return 'allow'; },
  });
  const d = await kernel.decideToolCall(ctx({ args: { path: join(paths.auditDir, 'x.jsonl') } }));
  assert.equal(d.block, true);
  assert.equal(d.rule, 'negative_capability');
  assert.equal(asked, false);
});

test('admitted calls are audited', async () => {
  const { audit, policy, predictions, paths } = fixture();
  const kernel = new GovernanceKernel({ audit, policy, predictions });
  await kernel.decideToolCall(ctx());
  const log = readFileSync(join(paths.auditDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf-8');
  assert.ok(log.includes('TOOL_CALL_ADMITTED'));
});

test('plan mode escalates mutating-capable calls to ask; benign stays allow', async () => {
  const { audit, policy, predictions } = fixture();
  let mode = 'normal';
  const asked = [];
  let askedArgs = null;
  const kernel = new GovernanceKernel({
    audit, policy, predictions,
    commandArgs: { shell: 'command' },
    mutatingTools: ['write', 'edit', 'delete'],
    modeProvider: () => mode,
    ask: async (pending) => { asked.push(pending.rule); askedArgs ??= pending.args; return 'allow'; },
    commandClassifier: async (source) => source.startsWith('rm')
      ? { units: [{ raw: source }], parseError: null, risk: 'destructive', hasUnknown: false }
      : source.startsWith('mkdir')
        ? { units: [{ raw: source }], parseError: null, risk: 'mutating', hasUnknown: false }
        : { units: [{ raw: source }], parseError: null, risk: 'benign', hasUnknown: false },
  });

  mode = 'plan';
  // mutating command → suspended to operator ask (rule plan_mode)
  const w = await kernel.decideToolCall(ctx({ toolName: 'shell', args: { command: 'mkdir x' } }));
  assert.equal(w, undefined); // operator approved → allow
  assert.deepEqual(asked, ['plan_mode']);
  // file mutation tool → same escalation
  await kernel.decideToolCall(ctx({ toolName: 'write', args: { path: 'a.txt' } }));
  assert.deepEqual(asked, ['plan_mode', 'plan_mode']);
  // benign read command → untouched by the mode
  const r = await kernel.decideToolCall(ctx({ toolName: 'shell', args: { command: 'ls -la' } }));
  assert.equal(r, undefined);
  assert.equal(asked.length, 2, 'benign read did not ask');
  // the ask payload carries the real args — the operator approves what they see
  assert.equal(askedArgs?.command, 'mkdir x');
});

test('plan mode cannot soften policy — destructive deny still denies', async () => {
  const { audit, policy, predictions } = fixture({
    riskActions: { destructive: 'deny' },
  });
  const kernel = new GovernanceKernel({
    audit, policy, predictions,
    commandArgs: { shell: 'command' },
    modeProvider: () => 'plan',
    mutatingTools: ['write'],
    ask: async () => 'allow', // even a willing operator cannot lift a deny
    commandClassifier: async (s) => ({ units: [{ raw: s }], parseError: null, risk: 'destructive', hasUnknown: false }),
  });
  const d = await kernel.decideToolCall(ctx({ toolName: 'shell', args: { command: 'rm -rf /' } }));
  assert.equal(d.block, true);
  assert.equal(d.rule, 'risk_destructive');
});

test('plan mode fail-closed without an ask channel', async () => {
  const { audit, policy, predictions } = fixture();
  const kernel = new GovernanceKernel({
    audit, policy, predictions,
    modeProvider: () => 'plan',
    mutatingTools: ['write'],
    // no ask channel — the escalation must resolve to a denial, not a crash
  });
  const d = await kernel.decideToolCall(ctx({ toolName: 'write', args: { path: 'a.txt' } }));
  assert.equal(d.block, true);
  assert.equal(d.rule, 'ask_unavailable');
});

test('kernel ask descriptor carries truncation flags for oversized args (B1)', async () => {
  const { audit, policy, predictions } = fixture({ riskActions: { destructive: 'ask' } });
  let pending = null;
  const kernel = new GovernanceKernel({
    audit, policy, predictions,
    commandArgs: { shell: 'command' },
    ask: async (p) => { pending = p; return 'deny'; },
    commandClassifier: async (s) => ({ units: [{ raw: s }], parseError: null, risk: 'destructive', hasUnknown: false }),
  });
  await kernel.decideToolCall(ctx({ toolName: 'shell', args: { command: `rm ${'x'.repeat(60000)}` } }));
  assert.equal(pending.rule, 'risk_destructive');
  assert.equal(pending.argsTruncated, true);
  assert.ok(pending.argsTotalChars > 60000);
  assert.ok(pending.args.command.length < pending.argsTotalChars);
});
