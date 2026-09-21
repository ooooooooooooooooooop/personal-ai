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

test("command allowlist skips the ask card but never a deny (Roo whitelist analogue)", async () => {
  const { audit, policy, predictions } = fixture({
    riskActions: { destructive: 'ask', privilege: 'deny' },
  });
  const calls = [];
  const kernel = new GovernanceKernel({
    audit, policy, predictions,
    commandArgs: { shell: 'command' },
    commandClassifier: async (src) => ({
      units: [{ raw: src }], parseError: null,
      risk: src.startsWith('sudo') ? 'privilege' : 'destructive',
    }),
    commandAllowlist: (ctx) => String(ctx.args?.command ?? '').startsWith('rm -rf build'),
    ask: async (pending) => { calls.push(pending); return 'deny'; },
  });
  // allowlisted prefix → admitted without consulting the operator
  const ok = await kernel.decideToolCall(ctx({ toolName: 'shell', toolCallId: 't1', args: { command: 'rm -rf build/out' } }));
  assert.equal(ok, undefined);
  assert.equal(calls.length, 0);
  // non-matching prefix → still asks (operator denies → blocked)
  const no = await kernel.decideToolCall(ctx({ toolName: 'shell', toolCallId: 't2', args: { command: 'rm -rf src' } }));
  assert.equal(no.block, true);
  assert.equal(calls.length, 1);
  // deny-class commands are unreachable for the allowlist (deny ran first)
  const deny = await kernel.decideToolCall(ctx({ toolName: 'shell', toolCallId: 't3', args: { command: 'sudo rm -rf build/x' } }));
  assert.equal(deny.block, true);
  assert.equal(deny.rule, 'risk_privilege');
  assert.equal(calls.length, 1); // no new ask
});

test('instruction-file gate: mutating calls to standing-order files ask in every mode', async () => {
  const { audit, policy, predictions } = fixture();
  const asked = [];
  const kernel = new GovernanceKernel({
    audit, policy, predictions,
    mutatingTools: ['write', 'edit', 'delete'],
    ask: async (pending) => { asked.push(pending.rule); return 'allow'; },
  });
  // no modeProvider → default normal mode; gate must still fire
  const r1 = await kernel.decideToolCall(ctx({ toolName: 'write', args: { path: '.pai/steering/rules.md' } }));
  assert.equal(r1, undefined); // operator allowed → admit
  const r2 = await kernel.decideToolCall(ctx({ toolName: 'edit', args: { path: 'AGENTS.md' } }));
  assert.equal(r2, undefined);
  const r3 = await kernel.decideToolCall(ctx({ toolName: 'delete', args: { path: '.clinerules' } }));
  assert.equal(r3, undefined);
  assert.deepEqual(asked, ['instruction_file', 'instruction_file', 'instruction_file']);
  // ordinary source files are untouched by the gate
  await kernel.decideToolCall(ctx({ toolName: 'write', args: { path: 'src/main.js' } }));
  // non-mutating tools can still read instruction files freely
  await kernel.decideToolCall(ctx({ toolName: 'read', args: { path: 'AGENTS.md' } }));
  assert.equal(asked.length, 3, 'read + normal file did not escalate');
});

test('instruction-file gate: operator deny blocks the write', async () => {
  const { audit, policy, predictions } = fixture();
  const kernel = new GovernanceKernel({
    audit, policy, predictions,
    mutatingTools: ['write'],
    ask: async () => 'deny',
  });
  const d = await kernel.decideToolCall(ctx({ toolName: 'write', args: { path: '.cursor/rules/x.md' } }));
  assert.equal(d.block, true);
});

test('rejection memory: operator deny auto-denies the identical call signature', async () => {
  const { audit, policy, predictions } = fixture({
    riskActions: { destructive: 'ask', privilege: 'deny' },
  });
  let asks = 0;
  const kernel = new GovernanceKernel({
    audit, policy, predictions,
    mutatingTools: ['write'],
    ask: async () => { asks++; return 'deny'; },
  });
  const call = ctx({ toolName: 'write', args: { path: '.pai/plan.md', content: 'x' } });
  const d1 = await kernel.decideToolCall(call);
  assert.equal(d1.block, true);
  assert.equal(asks, 1);
  // identical call (different toolCallId, same signature) — no second card
  const d2 = await kernel.decideToolCall(ctx({ toolName: 'write', toolCallId: 'tc-2', args: { content: 'x', path: '.pai/plan.md' } }));
  assert.equal(d2.block, true);
  assert.match(d2.reason, /already denied/);
  assert.equal(asks, 1, 'rejection memory suppresses the repeat ask');
  // changed args → new signature → asks again
  await kernel.decideToolCall(ctx({ toolName: 'write', toolCallId: 'tc-3', args: { path: '.pai/plan.md', content: 'y' } }));
  assert.equal(asks, 2);
});

test('shell redirect into an instruction file escalates a benign command to ask', async () => {
  const { audit, policy, predictions } = fixture();
  const asked = [];
  const kernel = new GovernanceKernel({
    audit, policy, predictions,
    commandArgs: { shell: 'command' },
    commandClassifier: async (src) => ({
      units: [{ raw: 'echo pwned' }], parseError: null,
      risk: 'benign',
      writeTargets: /AGENTS\.md/.test(src) ? ['AGENTS.md'] : ['out.txt'],
    }),
    ask: async (pending) => { asked.push(pending.rule); return 'deny'; },
  });
  const d = await kernel.decideToolCall(ctx({ toolName: 'shell', args: { command: 'echo pwned > AGENTS.md' } }));
  assert.equal(d.block, true);
  assert.deepEqual(asked, ['instruction_file']);
  // ordinary redirect stays on the benign path — no card
  const ok = await kernel.decideToolCall(ctx({ toolName: 'shell', args: { command: 'echo hi > out.txt' } }));
  assert.equal(ok, undefined);
  assert.equal(asked.length, 1);
});

test('command allowlist gets rule+parsed: instruction-file asks are never prefix-softened', async () => {
  const { audit, policy, predictions } = fixture();
  const seen = [];
  const kernel = new GovernanceKernel({
    audit, policy, predictions,
    commandArgs: { shell: 'command' },
    commandClassifier: async () => ({
      units: [{ raw: 'echo x' }], parseError: null,
      risk: 'benign', writeTargets: ['CLAUDE.md'],
    }),
    // adapter-side policy: refuse softening for instruction_file rule
    commandAllowlist: (ctx, meta) => meta?.rule !== 'instruction_file' && String(ctx.args?.command ?? '').startsWith('echo'),
    ask: async () => 'deny',
  });
  const d = await kernel.decideToolCall(ctx({ toolName: 'shell', args: { command: 'echo x > CLAUDE.md' } }));
  assert.equal(d.block, true, 'instruction-file write must reach the operator even when echo is allowlisted');
});

test('command allowlist receives parsed units for per-unit matching', async () => {
  const { audit, policy, predictions } = fixture({ riskActions: { mutating: 'ask' } });
  let metaSeen = null;
  const kernel = new GovernanceKernel({
    audit, policy, predictions,
    commandArgs: { shell: 'command' },
    commandClassifier: async () => ({
      units: [{ raw: 'cp a b' }, { raw: 'rm -rf x' }], parseError: null,
      risk: 'mutating', hasUnknown: false,
    }),
    commandAllowlist: (ctx, meta) => { metaSeen = meta; return false; },
    ask: async () => 'deny',
  });
  await kernel.decideToolCall(ctx({ toolName: 'shell', args: { command: 'cp a b && rm -rf x' } }));
  assert.equal(metaSeen.rule, 'risk_mutating');
  assert.equal(metaSeen.parsed.units.length, 2);
});

test('in-card edited command: operator edit lands on ctx.args before admission', async () => {
  const { audit, policy, predictions } = fixture({ riskActions: { destructive: 'ask' } });
  const kernel = new GovernanceKernel({
    audit, policy, predictions,
    commandArgs: { shell: 'command' },
    commandClassifier: async () => ({ units: [{ raw: 'rm -rf a' }], parseError: null, risk: 'destructive' }),
    ask: async () => ({ answer: 'allow', edited: { command: 'rm -rf ./build/out' } }),
  });
  const c = ctx({ toolName: 'shell', args: { command: 'rm -rf a' } });
  const r = await kernel.decideToolCall(c);
  assert.equal(r, undefined, 'edited allow admits');
  assert.equal(c.args.command, 'rm -rf ./build/out', 'edited text replaced the executed arg');
});
