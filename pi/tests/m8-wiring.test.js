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

test('U4 secret scan: credential-looking write asks the operator; deny blocks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-m8-sec-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  const audit = new AuditWriter({ auditDir: join(dir, 'audit') });
  const fileOps = new FileOpsGuard(dir);
  const core = { audit, kernel: { decideToolCall: async () => null } };
  const asked = [];
  const asks = { ask: async (p) => { asked.push(p); return 'deny'; } };
  const decide = makeDecide({ core, executor: null, fileOps, getSurface: () => null, workdir: dir, asks });
  const target = join(dir, 'cfg.env');
  const fakeKey = `sk-${'a'.repeat(24)}`; // built at runtime — literal keys must never sit in the repo (push privacy gate)
  const r = await decide({ toolCall: { name: 'write' }, args: { path: target, content: `KEY=${fakeKey}` } });
  assert.equal(r.block, true);
  assert.equal(r.rule, 'secret_scan');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].rule, 'secret_scan');
  assert.ok(!existsSync(target)); // denied write never touched disk

  // clean content passes with no ask
  const ok = await decide({ toolCall: { name: 'write' }, args: { path: join(dir, 'ok.txt'), content: 'plain text' } });
  assert.equal(ok, undefined);
  assert.equal(asked.length, 1);
});

test('U4 secret scan: no asks channel fails closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-m8-sec2-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  const audit = new AuditWriter({ auditDir: join(dir, 'audit') });
  const fileOps = new FileOpsGuard(dir);
  const core = { audit, kernel: { decideToolCall: async () => null } };
  const decide = makeDecide({ core, executor: null, fileOps, getSurface: () => null, workdir: dir });
  const r = await decide({ toolCall: { name: 'write' }, args: { path: join(dir, 'x'), content: '-----BEGIN PRIVATE KEY-----\nabc' } });
  assert.equal(r.block, true);
  assert.match(r.reason, /fail-closed/);
});

test('.paiignore blocks read AND write families on excluded paths', async () => {
  const { dir, decide } = rig();
  const { PaiIgnore } = await import('../../host/src/core/paiignore.js');
  const decideIg = makeDecide({
    core: { audit: new AuditWriter({ auditDir: join(dir, 'audit') }), kernel: { decideToolCall: async () => null } },
    executor: null, fileOps: new FileOpsGuard(dir), getSurface: () => null, workdir: dir,
    paiignore: new PaiIgnore(dir, 'secrets/\n*.pem\n'),
  });
  const blockedRead = await decideIg({ toolCall: { name: 'read' }, args: { path: join(dir, 'secrets/k.txt') } });
  assert.equal(blockedRead.block, true);
  assert.equal(blockedRead.rule, 'paiignore');
  const blockedWrite = await decideIg({ toolCall: { name: 'write' }, args: { path: join(dir, 'a.pem'), content: 'x' } });
  assert.equal(blockedWrite.block, true);
  // unaffected path passes through to admit
  const ok = await decideIg({ toolCall: { name: 'read' }, args: { path: join(dir, 'src/app.js') } });
  assert.equal(ok, undefined);
});

test('turn cap: admitted calls over the budget are refused with a readable stop reason; prompt/steer reset restores', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-m8-cap-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  const audit = new AuditWriter({ auditDir: join(dir, 'audit') });
  const fileOps = new FileOpsGuard(dir);
  const core = { audit, kernel: { decideToolCall: async () => undefined } };
  const decide = makeDecide({ core, executor: null, fileOps, getSurface: () => null, workdir: dir, maxTurnCalls: 3 });

  const call = () => decide({ toolCall: { name: 'read' }, args: { path: 'x' } });
  assert.equal(await call(), undefined);
  assert.equal(await call(), undefined);
  assert.equal(await call(), undefined);
  const capped = await call();
  assert.equal(capped.block, true);
  assert.equal(capped.rule, 'turn_cap');
  assert.match(capped.reason, /3\/3/); // model-readable: spent/budget
  decide.resetTurn(); // prompt/steer boundary via channel turns.reset()
  assert.equal(await call(), undefined);
});

test('unicode sanitization: invisible chars in strict args block; free-text strips and executes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-m8-uni-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  const audit = new AuditWriter({ auditDir: join(dir, 'audit') });
  const fileOps = new FileOpsGuard(dir);
  const kernelArgs = [];
  const core = { audit, kernel: { decideToolCall: async (c) => { kernelArgs.push(c.args); return undefined; } } };
  const decide = makeDecide({ core, executor: null, fileOps, getSurface: () => null, workdir: dir });

  // zero-width space inside a command → block (identifier/classifier spoofing)
  const b = await decide({ toolCall: { name: 'bash' }, args: { command: 'git​ status' } });
  assert.equal(b.block, true);
  assert.equal(b.rule, 'unicode_invisible');
  // bidi override inside write content → stripped, kernel sees clean text
  const ok = await decide({ toolCall: { name: 'write' }, args: { path: join(dir, 'a.txt'), content: 'he‮llo‬' } });
  assert.equal(ok, undefined);
  assert.equal(kernelArgs.at(-1).content, 'hello');
});

test('command denylist: .pai/commands.json denyPrefix blocks before kernel admit', async () => {
  const { dir, decide } = rig();
  mkdirSync(join(dir, '.pai'), { recursive: true });
  writeFileSync(join(dir, '.pai', 'commands.json'), JSON.stringify({ denyPrefixes: ['rm -rf', 'git push'] }));
  const blocked = await decide({ toolCall: { name: 'bash', id: 'c1' }, args: { command: 'rm -rf node_modules' } });
  assert.equal(blocked.block, true);
  assert.equal(blocked.rule, 'command_denylist');
  const ok = await decide({ toolCall: { name: 'bash', id: 'c2' }, args: { command: 'npm test' } });
  assert.equal(ok, undefined); // non-matching passes through to kernel admit
});

test('GATE-COMPOSITION-01: job_spawn command args face the same denyPrefix as bash', async () => {
  const { dir, decide } = rig();
  mkdirSync(join(dir, '.pai'), { recursive: true });
  writeFileSync(join(dir, '.pai', 'commands.json'), JSON.stringify({ denyPrefixes: ['rm -rf'] }));
  // a durable-job spawn must not bypass the project deny file just because
  // it is a different tool — restart already enforces it; parity demands the
  // original path enforce it too
  const blocked = await decide({ toolCall: { name: 'job_spawn', id: 'c1' }, args: { command: 'rm -rf /' } });
  assert.equal(blocked.block, true);
  assert.equal(blocked.rule, 'command_denylist');
  const ok = await decide({ toolCall: { name: 'job_spawn', id: 'c2' }, args: { command: 'npm test' } });
  assert.equal(ok, undefined);
});

test('operator pre_tool gate vetoes an admitted call (fail-closed on error)', async () => {
  const { dir, decide: base } = rig();
  void base;
  const audit = { events: [], write: (e) => audit.events.push(e) };
  const fileOps2 = new FileOpsGuard(dir);
  const core = { audit, kernel: { decideToolCall: async () => null } }; // kernel admits
  const gate = {
    calls: [],
    async fireGate(event, payload) {
      gate.calls.push({ event, tool: payload.tool });
      return payload.tool === 'bash' ? { deny: 'operator policy: no shells today' } : null;
    },
  };
  const decide = makeDecide({ core, executor: null, fileOps: fileOps2, getSurface: () => null, workdir: dir, preToolGate: gate });

  const denied = await decide({ toolCall: { name: 'bash' }, args: { command: 'echo hi' } });
  assert.equal(denied.block, true);
  assert.equal(denied.rule, 'pre_tool_hook');
  assert.match(denied.reason, /no shells today/);
  assert.ok(audit.events.some((e) => e.kind === 'HOOK_VETO'));

  const ok = await decide({ toolCall: { name: 'read' }, args: { path: join(dir, 'x.txt') } });
  assert.equal(ok, undefined); // gate allowed → admit stands
  assert.deepEqual(gate.calls.map((c) => c.tool), ['bash', 'read']);

  // broken gate fails closed
  const broken = { async fireGate() { throw new Error('gate exploded'); } };
  const decide2 = makeDecide({ core, executor: null, fileOps: fileOps2, getSurface: () => null, workdir: dir, preToolGate: broken });
  const r = await decide2({ toolCall: { name: 'read' }, args: { path: join(dir, 'x.txt') } });
  assert.equal(r.block, true);
  assert.match(r.reason, /fail-closed/);
});

test('mistake-limit stop: loopwatch.stopped refuses calls until a fresh turn resets', async () => {
  const { LoopDetector } = await import('../../host/src/core/loopwatch.js');
  const dir = mkdtempSync(join(tmpdir(), 'pai-m8-stop-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  const audit = new AuditWriter({ auditDir: join(dir, 'audit') });
  const fileOps = new FileOpsGuard(dir);
  const core = { audit, kernel: { decideToolCall: async () => null } };
  const lw = new LoopDetector({ errorLimit: 2 });
  const decide = makeDecide({ core, executor: null, fileOps, getSurface: () => null, workdir: dir, loopwatch: lw });
  // operator pressed stop after the escalation
  lw.observeResult(true); lw.observeResult(true);
  lw.stopRun();
  const refused = await decide({ toolCall: { name: 'read_file' }, args: { path: 'x' } });
  assert.equal(refused?.block, true);
  assert.match(refused.reason, /operator stopped/);
  // a fresh user turn releases the stop — the run-scoped latch clears
  decide.resetTurn();
  assert.equal(await decide({ toolCall: { name: 'read_file' }, args: { path: 'x' } }), undefined);
});

test('read outside workspace: asks once, deny latches session-wide block', async () => {
  const { dir, decide } = rig();
  const outside = join(dir, '..', 'outside.txt');
  let asks = 0;
  const decideAsk = makeDecide({
    core: { audit: new AuditWriter({ auditDir: join(dir, 'audit') }), kernel: { decideToolCall: async () => null } },
    executor: null, fileOps: new FileOpsGuard(dir), getSurface: () => null, workdir: dir,
    asks: { ask: async () => { asks += 1; return 'deny'; } },
  });
  const r1 = await decideAsk({ toolCall: { name: 'read' }, args: { path: outside } });
  assert.equal(r1?.block, true);
  assert.equal(r1.rule, 'read_outside');
  assert.equal(asks, 1);
  // deny latched — a second outside read refuses WITHOUT asking again
  const r2 = await decideAsk({ toolCall: { name: 'read' }, args: { path: join(dir, '..', 'other.txt') } });
  assert.equal(r2?.block, true);
  assert.equal(asks, 1);
  // inside reads never prompted at all
  const r3 = await decideAsk({ toolCall: { name: 'read' }, args: { path: join(dir, 'inside.txt') } });
  assert.equal(r3, undefined);
  void decide;
});

test('read outside workspace: no operator channel fails closed; allow_session stops re-asking', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-m8-ro-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  const core = { audit: new AuditWriter({ auditDir: join(dir, 'audit') }), kernel: { decideToolCall: async () => null } };
  // no asks facade → fail closed on the outside read
  const closed = makeDecide({ core, executor: null, fileOps: new FileOpsGuard(dir), getSurface: () => null, workdir: dir });
  const r = await closed({ toolCall: { name: 'read' }, args: { path: join(dir, '..', 'x.txt') } });
  assert.equal(r?.block, true);
  assert.equal(r.rule, 'read_outside');

  let asks = 0;
  const open = makeDecide({ core, executor: null, fileOps: new FileOpsGuard(dir), getSurface: () => null, workdir: dir,
    asks: { ask: async () => { asks += 1; return 'allow_session'; } } });
  assert.equal(await open({ toolCall: { name: 'read' }, args: { path: join(dir, '..', 'a.txt') } }), undefined);
  assert.equal(await open({ toolCall: { name: 'read' }, args: { path: join(dir, '..', 'b.txt') } }), undefined);
  assert.equal(asks, 1); // allow_session latches — no re-prompt
});

test('read outside workspace: relative path escapes count too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-m8-rel-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  const core = { audit: new AuditWriter({ auditDir: join(dir, 'audit') }), kernel: { decideToolCall: async () => null } };
  const d = makeDecide({ core, executor: null, fileOps: new FileOpsGuard(dir), getSurface: () => null, workdir: dir });
  const r = await d({ toolCall: { name: 'read' }, args: { path: '../sibling-secret.txt' } });
  assert.equal(r?.block, true);
  // workdir itself and descendants pass silently
  assert.equal(await d({ toolCall: { name: 'ls' }, args: { path: '.' } }), undefined);
  assert.equal(await d({ toolCall: { name: 'read' }, args: { path: 'sub/deep.txt' } }), undefined);
});

test('M105: receipts carry toolCallId; undoCall reverts exactly that call\'s mutations', async () => {
  const { dir, decide, fileOps } = rig();
  const t1 = join(dir, 'one.txt');
  const t2 = join(dir, 'two.txt');
  writeFileSync(t1, 'v1'); writeFileSync(t2, 'v2');

  // two calls — call A mutates one.txt, call B mutates two.txt
  await decide({ toolCall: { name: 'write', id: 'call-A' }, args: { path: t1, content: 'x' } });
  writeFileSync(t1, 'mutated-A'); // the "tool execution" the backup covered
  await decide({ toolCall: { name: 'write', id: 'call-B' }, args: { path: t2, content: 'x' } });
  writeFileSync(t2, 'mutated-B');

  const ops = opsLog(dir);
  assert.equal(ops[0].toolCallId, 'call-A');
  assert.equal(ops[1].toolCallId, 'call-B');

  const r = await fileOps.undoCall('call-A');
  assert.deepEqual(r.skipped, []);
  assert.equal(readFileSync(t1, 'utf-8'), 'v1');   // A reverted
  assert.equal(readFileSync(t2, 'utf-8'), 'mutated-B'); // B untouched
});

test('M105: undoFrom rewinds the anchor receipt and everything newer, oldest state wins', async () => {
  const { fileOps } = rig();
  const dir = fileOps.rootDir ?? undefined;
  const tmp = mkdtempSync(join(tmpdir(), 'pai-m8-undo-'));
  const guard = new FileOpsGuard(tmp);
  const a = join(tmp, 'a.txt');
  const b = join(tmp, 'b.txt');
  writeFileSync(a, 'a0'); writeFileSync(b, 'b0');
  const r1 = await guard.backup(a);   // anchor — state "before" is a0/b0
  writeFileSync(a, 'a1');
  await guard.backup(b);
  writeFileSync(b, 'b1');

  const r = await guard.undoFrom(r1.receiptId);
  assert.equal(r.restored.length, 2);
  assert.equal(readFileSync(a, 'utf-8'), 'a0');
  assert.equal(readFileSync(b, 'utf-8'), 'b0');
  // restores are themselves receipted — the rewind is recoverable
  assert.ok(opsLog(tmp).some((o) => o.op === 'restore'));
  void dir;
});

test('M100: terminal provider error walks the fallback chain; aborts never do', async () => {
  const { loopGovernanceExtension } = await import('../src/adapter/loop.js');
  const events = {};
  const sent = [];
  const models = {
    'openai/gpt-a': { provider: 'openai', id: 'gpt-a' },
    'anthropic/claude-b': { provider: 'anthropic', id: 'claude-b' },
  };
  const pi = {
    on: (n, fn) => { events[n] = fn; },
    setModel: async (m) => m.provider !== 'anthropic' ? true : true, // all authed
    sendUserMessage: (t) => sent.push(t),
  };
  const auditEvents = [];
  const audit = { write: (e) => auditEvents.push(e) };
  const ext = loopGovernanceExtension({
    audit, fallbacks: { chain: [{ provider: 'anthropic', model: 'claude-b' }, { provider: 'openai', model: 'gpt-a' }] },
  });
  ext.factory(pi);

  const run = async (cur, stopReason) => {
    events.agent_start();
    await events.agent_end(
      { messages: [{ role: 'assistant', stopReason, errorMessage: 'HTTP 429 rate limited' }] },
      { model: cur, modelRegistry: { find: (p, id) => models[`${p}/${id}`] }, sendUserMessage: (t) => sent.push(t) },
    );
  };

  // current model not in chain → first chain entry
  await run({ provider: 'openai', id: 'gpt-5' }, 'error');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /claude-b/);
  assert.ok(auditEvents.some((e) => e.kind === 'MODEL_FALLBACK' && e.data.to === 'anthropic/claude-b'));

  // aborted runs never fall back
  sent.length = 0;
  await run({ provider: 'anthropic', id: 'claude-b' }, 'aborted');
  assert.equal(sent.length, 0);

  // new task resets the hop budget; chain position advances past current
  await run({ provider: 'anthropic', id: 'claude-b' }, 'error');
  assert.match(sent.at(-1), /gpt-a/); // idx+1 — skips re-selecting the failed model

  // chain exhausted → audit 'exhausted', no more steers
  sent.length = 0;
  await run({ provider: 'openai', id: 'gpt-a' }, 'error');
  assert.equal(sent.length, 0);
  assert.ok(auditEvents.some((e) => e.kind === 'MODEL_FALLBACK' && e.data.exhausted));
});

test('M100 error classes: request-invariant errors skip the chain; provider faults walk it', async () => {
  const { loopGovernanceExtension, isRequestInvariantError } = await import('../src/adapter/loop.js');

  // classifier truth table
  for (const invariant of [
    'HTTP 400: invalid_request_error — messages.2: role is required',
    'Error: status code 422 from provider',
    '400 Bad Request',
    'malformed request body: trailing comma',
    'request failed validation: input_schema',
  ]) assert.ok(isRequestInvariantError(invariant), `invariant: ${invariant}`);
  for (const transient of [
    'HTTP 429 rate limited',
    'status code 500 internal server error',
    '401 unauthorized: invalid api key',   // next chain entry has its OWN credentials
    'fetch failed: ECONNRESET',
    'prompt is too long: 210000 tokens > 200000 context window', // bigger-window entry may take it
    'overloaded_error: try again later',
  ]) assert.ok(!isRequestInvariantError(transient), `walks: ${transient}`);

  // gate behavior: a 400 ends the run WITHOUT a model switch or steer
  const events = {};
  const sent = [];
  const models = { 'anthropic/claude-b': { provider: 'anthropic', id: 'claude-b' } };
  const pi = {
    on: (n, fn) => { events[n] = fn; },
    setModel: async () => true,
    sendUserMessage: (t) => sent.push(t),
  };
  const auditEvents = [];
  loopGovernanceExtension({
    audit: { write: (e) => auditEvents.push(e) },
    fallbacks: { chain: [{ provider: 'anthropic', model: 'claude-b' }] },
  }).factory(pi);

  events.agent_start();
  await events.agent_end(
    { messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'status code 400: invalid_request_error' }] },
    { model: { provider: 'openai', id: 'gpt-5' }, modelRegistry: { find: (p, id) => models[`${p}/${id}`] }, sendUserMessage: (t) => sent.push(t) },
  );
  assert.equal(sent.length, 0, 'no fallback steer for a request-invariant error');
  const skipped = auditEvents.find((e) => e.kind === 'MODEL_FALLBACK_SKIPPED');
  assert.ok(skipped, 'skip is audited');
  assert.match(skipped.data.reason, /request-invariant/);
  assert.ok(!auditEvents.some((e) => e.kind === 'MODEL_FALLBACK' && !e.data.exhausted), 'chain never walked');

  // and a transient error on the same rig still walks the chain
  events.agent_start();
  await events.agent_end(
    { messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'HTTP 429 rate limited' }] },
    { model: { provider: 'openai', id: 'gpt-5' }, modelRegistry: { find: (p, id) => models[`${p}/${id}`] }, sendUserMessage: (t) => sent.push(t) },
  );
  assert.equal(sent.length, 1, 'transient error falls back as before');
});

test('stale agent_end: a duplicated end-of-run event without a new start is dropped + audited', async () => {
  const { loopGovernanceExtension } = await import('../src/adapter/loop.js');
  const events = {};
  const sent = [];
  const pi = {
    on: (n, fn) => { events[n] = fn; },
    setModel: async () => true,
    sendUserMessage: (t) => sent.push(t),
  };
  const auditEvents = [];
  const audit = { write: (e) => auditEvents.push(e) };
  loopGovernanceExtension({
    audit, fallbacks: { chain: [{ provider: 'anthropic', model: 'claude-b' }, { provider: 'openai', model: 'gpt-a' }] },
  }).factory(pi);

  const ctx = {
    model: { provider: 'openai', id: 'gpt-5' },
    modelRegistry: { find: (p, id) => ({ provider: p, id }) },
    sendUserMessage: (t) => sent.push(t),
  };
  const errMsg = { messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'HTTP 500' }] };

  events.agent_start();
  await events.agent_end(errMsg, ctx);
  assert.equal(sent.length, 1, 'first end triggers the fallback');
  // upstream double-fire / late duplicate: no agent_start in between
  await events.agent_end(errMsg, ctx);
  assert.equal(sent.length, 1, 'stale agent_end dropped — no double fallback');
  assert.ok(auditEvents.some((e) => e.kind === 'STALE_AGENT_END' && e.data.dropped));
  // a real new run re-arms the latch
  events.agent_start();
  await events.agent_end(errMsg, ctx);
  assert.equal(sent.length, 2, 'fresh run is not silenced by the latch');
});
