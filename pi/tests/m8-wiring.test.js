/**
 * M8 acceptance-gap closure: ToolSurface + FileOpsGuard must be wired into the
 * REAL production decide chain (makeDecide), not just exist as modules.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDecide } from '../src/bootstrap/decide.js';
import { FileOpsGuard } from '../src/adapter/fileops.js';
import { ToolSurface } from '../src/adapter/surface.js';
import { AuditWriter } from '../../host/src/core/audit.js';

function rig({ kernelDecision = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pai-m8-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  const audit = new AuditWriter({ auditDir: join(dir, 'audit') });
  const fileOps = new FileOpsGuard(dir);
  const denyCalls = [];
  const surface = { deny: (n) => denyCalls.push(n) };
  const core = {
    audit,
    kernel: { decideToolCall: async () => kernelDecision },
  };
  const decide = makeDecide({ core, executor: null, fileOps, getSurface: () => surface, workdir: dir });
  return { dir, audit, fileOps, denyCalls, decide };
}

const opsLog = (dir) =>
  existsSync(join(dir, 'fileops.jsonl'))
    ? readFileSync(join(dir, 'fileops.jsonl'), 'utf-8').trim().split('\n').map(JSON.parse)
    : [];

test('admitted write produces a pre-execution backup receipt (production decide)', async () => {
  const { dir, decide } = rig();
  const target = join(dir, 'notes.txt');
  writeFileSync(target, 'original bytes');

  const result = await decide({ toolCall: { name: 'write' }, args: { path: target, content: 'x' } });
  assert.equal(result, undefined); // admitted — tool executes after backup

  const ops = opsLog(dir);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, 'backup');
  assert.equal(ops[0].target, target);
  assert.ok(existsSync(ops[0].backup));
  assert.equal(readFileSync(ops[0].backup, 'utf-8'), 'original bytes');
});

test('delete call is recycled, not destroyed, with a receipt', async () => {
  const { dir, decide } = rig();
  const target = join(dir, 'doomed.txt');
  writeFileSync(target, 'precious');

  const result = await decide({ toolCall: { name: 'delete' }, args: { path: target } });
  assert.equal(result.block, true);
  assert.match(result.reason, /recycle/);
  assert.ok(!existsSync(target)); // moved, not deleted
  const op = opsLog(dir).at(-1);
  assert.equal(op.op, 'delete');
  assert.ok(existsSync(op.recycledTo));
  assert.equal(readFileSync(op.recycledTo, 'utf-8'), 'precious');
});

test('terminate-level denial hides the tool via surface.deny', async () => {
  const { denyCalls, decide } = rig({ kernelDecision: { block: true, terminate: true, reason: 'x' } });
  const result = await decide({ toolCall: { name: 'bash' }, args: { command: 'rm -rf /' } });
  assert.equal(result.terminate, true);
  assert.deepEqual(denyCalls, ['bash']);
});

test('plain block does NOT hide the tool', async () => {
  const { denyCalls, decide } = rig({ kernelDecision: { block: true, reason: 'nope' } });
  await decide({ toolCall: { name: 'bash' }, args: { command: 'ls' } });
  assert.deepEqual(denyCalls, []);
});

test('audit ledger carries FILEOP events for the real chain', async () => {
  const { dir, decide } = rig();
  const target = join(dir, 'a.txt');
  writeFileSync(target, 'v1');
  await decide({ toolCall: { name: 'edit' }, args: { path: target, oldText: 'v1', newText: 'v2' } });
  const ledger = readFileSync(
    join(dir, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf-8');
  assert.ok(ledger.includes('FILEOP_BACKUP'));
});

test('workspace write lease: foreground mutation refused while a job holds it', async () => {
  const { WorkspaceWriteLease } = await import('../src/adapter/writelease.js');
  const dir = mkdtempSync(join(tmpdir(), 'pai-m8-lease-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  const audit = new AuditWriter({ auditDir: join(dir, 'audit') });
  const fileOps = new FileOpsGuard(dir);
  const writeLease = new WorkspaceWriteLease(join(dir, 'lease.json'));
  const core = { audit, kernel: { decideToolCall: async () => null } }; // kernel admits
  const decide = makeDecide({ core, executor: null, fileOps, getSurface: () => null, workdir: dir, writeLease });

  writeLease.acquire('job:build-1');
  const target = join(dir, 'f.txt');
  writeFileSync(target, 'v');
  const r = await decide({ toolCall: { name: 'write' }, args: { path: target, content: 'x' } });
  assert.equal(r.block, true);
  assert.equal(r.rule, 'workspace_lease');
  assert.match(r.reason, /build-1/);

  writeLease.release('job:build-1');
  const r2 = await decide({ toolCall: { name: 'write' }, args: { path: target, content: 'x' } });
  assert.equal(r2, undefined); // free again
});

test('workspace write lease: mutating shell command refused while held; benign passes', async () => {
  const { WorkspaceWriteLease } = await import('../src/adapter/writelease.js');
  const { parseShellCommand } = await import('../src/adapter/command-parse.js');
  const dir = mkdtempSync(join(tmpdir(), 'pai-m8-lease2-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  const audit = new AuditWriter({ auditDir: join(dir, 'audit') });
  const fileOps = new FileOpsGuard(dir);
  const writeLease = new WorkspaceWriteLease(join(dir, 'lease.json'));
  const core = { audit, kernel: { decideToolCall: async () => null } };
  const decide = makeDecide({ core, executor: null, fileOps, getSurface: () => null, workdir: dir, writeLease, classifier: parseShellCommand });

  writeLease.acquire('job:watch-1');
  const denied = await decide({ toolCall: { name: 'bash' }, args: { command: 'echo hi > out.txt' } });
  assert.equal(denied?.block, true);
  assert.equal(denied?.rule, 'workspace_lease');
  const denied2 = await decide({ toolCall: { name: 'bash' }, args: { command: 'npm run build' } });
  assert.equal(denied2?.rule, 'workspace_lease'); // classified mutating
  const allowed = await decide({ toolCall: { name: 'bash' }, args: { command: 'ls -la' } });
  assert.equal(allowed, undefined); // read-only command unaffected by the lease
});

test('mutating durable job refuses while the lease is held', async () => {
  const { WorkspaceWriteLease } = await import('../src/adapter/writelease.js');
  const { JobExecutor } = await import('../src/adapter/jobs.js');
  const { JobStore } = await import('../../host/src/core/jobs.js');
  const dir = mkdtempSync(join(tmpdir(), 'pai-m8-job-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  const audit = new AuditWriter({ auditDir: join(dir, 'audit') });
  const store = new JobStore(join(dir, 'durable_jobs.db'));
  const writeLease = new WorkspaceWriteLease(join(dir, 'lease.json'));
  writeLease.acquire('job:other');
  const executor = new JobExecutor(store, join(dir, 'jobs'), {
    audit, writeLease,
    classifier: async () => ({ risk: 'mutating', hasUnknown: false, parseError: null, units: [] }),
  });
  const r = await executor.spawnCommandJob({ command: 'npm run build', workdir: dir });
  assert.equal(r.refused, true);
  assert.match(r.reason, /other/);
  assert.equal(store.getJob(r.job_id).job_state, 'FAILED');
  store.close();
});

test('loop detector blocks an identical call repeated past threshold', async () => {
  const { LoopDetector } = await import('../../host/src/core/loopwatch.js');
  const { dir, decide } = rig();
  // re-rig with the detector wired like production bootstrap does
  const audit = new AuditWriter({ auditDir: join(dir, 'audit') });
  const fileOps = new FileOpsGuard(dir);
  const core = { audit, kernel: { decideToolCall: async () => null } };
  const decide2 = makeDecide({ core, executor: null, fileOps, getSurface: () => null, workdir: dir, loopwatch: new LoopDetector({ warnAt: 2, blockAt: 4 }) });

  const call = () => decide2({ toolCall: { name: 'bash' }, args: { command: 'grep x' } });
  await call(); await call(); await call();
  const r = await call(); // 4th identical → block
  assert.equal(r.block, true);
  assert.equal(r.rule, 'loop_detect');
  assert.match(r.reason, /identically 4 times/);
});

test('loop escalation goes to the operator; allow lets the call through', async () => {
  const { LoopDetector } = await import('../../host/src/core/loopwatch.js');
  const dir = mkdtempSync(join(tmpdir(), 'pai-m8-loop-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  const audit = new AuditWriter({ auditDir: join(dir, 'audit') });
  const fileOps = new FileOpsGuard(dir);
  const core = { audit, kernel: { decideToolCall: async () => null } };
  const asked = [];
  const asks = { ask: async (pending) => { asked.push(pending); return 'allow'; } };
  const decide = makeDecide({ core, executor: null, fileOps, getSurface: () => null, workdir: dir, loopwatch: new LoopDetector({ warnAt: 2, blockAt: 3, escalateAfter: 1 }), asks });

  const call = () => decide({ toolCall: { name: 'read' }, args: { path: 'a' } });
  await call(); await call();
  assert.equal((await call()).block, true); // 3rd → block
  const r = await call();                    // retried → escalate to operator
  assert.equal(asked.length, 1);
  assert.equal(asked[0].rule, 'loop_detect');
  assert.equal(r, undefined);                // operator allowed → admitted
});

test('loop escalation denied by operator stays blocked; no asks channel fails closed', async () => {
  const { LoopDetector } = await import('../../host/src/core/loopwatch.js');
  const dir = mkdtempSync(join(tmpdir(), 'pai-m8-loop2-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  const audit = new AuditWriter({ auditDir: join(dir, 'audit') });
  const fileOps = new FileOpsGuard(dir);
  const core = { audit, kernel: { decideToolCall: async () => null } };

  // operator denies
  const asks = { ask: async () => 'deny' };
  const d1 = makeDecide({ core, executor: null, fileOps, getSurface: () => null, workdir: dir, loopwatch: new LoopDetector({ warnAt: 2, blockAt: 3, escalateAfter: 1 }), asks });
  const call1 = () => d1({ toolCall: { name: 'read' }, args: { path: 'b' } });
  await call1(); await call1(); await call1(); // block
  const denied = await call1();
  assert.equal(denied.block, true);
  assert.match(denied.reason, /operator \(deny\)/);

  // no responder at all → escalate fails closed as a block, never an admit
  const d2 = makeDecide({ core, executor: null, fileOps, getSurface: () => null, workdir: dir, loopwatch: new LoopDetector({ warnAt: 2, blockAt: 3, escalateAfter: 1 }) });
  const call2 = () => d2({ toolCall: { name: 'read' }, args: { path: 'c' } });
  await call2(); await call2(); await call2();
  const r = await call2();
  assert.equal(r.block, true);
  assert.match(r.reason, /fail-closed/);
});

test('job_status polling never trips the loop detector', async () => {
  const { LoopDetector } = await import('../../host/src/core/loopwatch.js');
  const dir = mkdtempSync(join(tmpdir(), 'pai-m8-loop3-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  const audit = new AuditWriter({ auditDir: join(dir, 'audit') });
  const fileOps = new FileOpsGuard(dir);
  const core = { audit, kernel: { decideToolCall: async () => null } };
  const decide = makeDecide({ core, executor: null, fileOps, getSurface: () => null, workdir: dir, loopwatch: new LoopDetector({ warnAt: 2, blockAt: 3 }) });
  for (let i = 0; i < 8; i++) {
    assert.equal(await decide({ toolCall: { name: 'job_status' }, args: { job_id: 'j' } }), undefined);
  }
});

test('B4: context seam re-projects LIVE open predictions (not a snapshot)', async () => {
  const { PredictionStore } = await import('../../host/src/core/prediction.js');
  const { buildContextEnvelope } = await import('../../host/src/core/envelopes.js');
  const { contextEnvelopeExtension } = await import('../src/adapter/index.js');

  const dir = mkdtempSync(join(tmpdir(), 'pai-m8-ctx-'));
  const predictions = new PredictionStore(dir);
  const provider = () => buildContextEnvelope({
    briefing: 'you are the test body',
    openPredictions: predictions.openPredictions(),
  });
  const ext = contextEnvelopeExtension(provider);

  // register the 'context' handler like Pi's extension API does
  let contextHandler;
  ext.factory({ on: (name, fn) => { if (name === 'context') contextHandler = fn; } });

  // no predictions yet — briefing only
  let out = contextHandler({ messages: ['m0'] });
  assert.equal(out.messages.length, 2);
  assert.ok(!out.messages[1].content[0].text.includes('<open-predictions>'));

  // open a prediction — the NEXT context event must carry its claim text.
  // This is the post-compaction re-injection path: the provider is re-read
  // per turn, so whatever survived survives compaction.
  predictions.open({ claim: 'user prefers tabs over spaces', horizon: 'session' });
  out = contextHandler({ messages: ['m0', 'm1'] });
  const rendered = out.messages.at(-1).content[0].text;
  assert.ok(rendered.includes('<open-predictions>'));
  assert.ok(rendered.includes('user prefers tabs over spaces'));
  assert.ok(rendered.includes('horizon: session'));

  // close it — it must disappear from the live projection
  const p = predictions.openPredictions()[0];
  predictions.close(p.id, 'observed in settings', 'confirmed');
  out = contextHandler({ messages: ['m0', 'm1', 'm2'] });
  assert.ok(!out.messages.at(-1).content[0].text.includes('<open-predictions>'));
});
