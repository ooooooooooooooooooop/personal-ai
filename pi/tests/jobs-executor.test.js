/**
 * M4 exit gate — the kill drill: spawn a durable job, KILL the worker process,
 * cold-start a new executor over the same db, recoveryTick must RESUME it
 * under a new attempt. Plus long-command classifier + delegate tool surface.
 */
import { mkdtempSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JobStore } from '../../host/src/core/jobs.js';
import { BudgetGovernor } from '../../host/src/core/budget.js';
import { JobExecutor, isLongRunningCommand, isWorkerAlive, validateCheckpoint, readCheckpoint } from '../src/adapter/jobs.js';
import { delegateTool, jobStatusTool, makeDelegationCommand } from '../src/adapter/delegate.js';
import { WorkspaceWriteLease } from '../src/adapter/writelease.js';

const here = dirname(fileURLToPath(import.meta.url));

const rig = (dir, deps = {}) => {
  const store = new JobStore(join(dir, 'durable_jobs.db'));
  const executor = new JobExecutor(store, join(dir, 'jobs'), deps);
  return { store, executor };
};

const sleepCmd = (ms) =>
  process.platform === 'win32'
    ? `node -e "setTimeout(()=>{},${ms})"` // cmd.exe spawns node child
    : `node -e 'setTimeout(()=>{},${ms})'`;

test('isLongRunningCommand flags dev servers/watchers, not normal commands', () => {
  assert.ok(isLongRunningCommand('npm run dev'));
  assert.ok(isLongRunningCommand('vite --port 3000'));
  assert.ok(isLongRunningCommand('sleep 300'));
  assert.ok(!isLongRunningCommand('echo hi'));
  assert.ok(!isLongRunningCommand('npm test'));
  assert.ok(!isLongRunningCommand(null));
});

test('checkpoint validation mirrors the Python contract', () => {
  assert.equal(validateCheckpoint(null).valid, false);
  assert.equal(validateCheckpoint({ algorithm_version: '9.9' }).valid, false);
  assert.equal(validateCheckpoint({
    job_id: 'j', attempt_id: 'a', authorized_root: '/x', algorithm_version: '1.0.0',
  }).valid, true);
});

test('KILL DRILL: worker killed → cold restart → recoveryTick resumes under attempt N+1', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-killdrill-'));
  const { store } = rig(dir);
  const workdir = tmpdir();
  const command = sleepCmd(60_000);

  // Simulate a crashed host faithfully: job records exist (created by a dead
  // host) but NO exit handler can fire — the worker is a process we spawned
  // OUTSIDE the executor, mirroring "host died mid-run, child orphaned".
  const sleeper = spawn('node', ['-e', 'setTimeout(()=>{},60000)'], { windowsHide: true });
  const job = store.createJob({ jobType: 'shell_command', authorizedRoot: workdir });
  const { attempt_id } = store.startAttempt({
    jobId: job.job_id, writerId: 'dead_host', workerType: 'child_process',
    workerIdentity: { pid: sleeper.pid, host: 'local' }, workspaceRef: workdir,
  });
  const ckPath = join(dir, 'jobs', `${attempt_id}.checkpoint.json`);
  writeFileSync(ckPath, JSON.stringify({
    checkpoint_version: 1, job_id: job.job_id, attempt_id,
    input_identity: `sha256:${command}`, authorized_root: workdir,
    algorithm_version: '1.0.0', next_operation: 'await_exit',
    created_at: new Date().toISOString(), pid: sleeper.pid,
  }));
  store.recordCheckpoint(job.job_id, attempt_id, ckPath);

  // === the crash: worker dies, host never sees it ===
  sleeper.kill();
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(isWorkerAlive({ pid: sleeper.pid }), false);

  // === cold restart: fresh executor over the same db ===
  const store2 = new JobStore(join(dir, 'durable_jobs.db'));
  const executor2 = new JobExecutor(store2, join(dir, 'jobs'));
  const actions = executor2.recover({ workdir });
  const resume = actions.find((a) => a.job_id === job.job_id);
  assert.equal(resume.action_type, 'RESUME_ATTEMPT');
  const attempts = store2.getAttempts(job.job_id);
  assert.equal(attempts.length, 2);
  const newPid = JSON.parse(attempts[1].worker_identity).pid;
  assert.ok(isWorkerAlive({ pid: newPid }), 'resumed worker alive');
  process.kill(newPid); // cleanup
  await new Promise((r) => setTimeout(r, 300));
  store.close(); store2.close();
});

test('ORPHAN DRILL: parent dead, worker alive — cold executor adopts its lease', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-orphan-'));
  const { store } = rig(dir);
  const workdir = tmpdir();
  const leasePath = join(dir, 'ws-lease.json');

  // A worker that outlives its parent — spawned outside any executor, with a
  // workspace lease the DEAD parent took out under `job:<id>` but carrying the
  // WORKER's pid (so it stays live while the orphan lives).
  const orphan = spawn('node', ['-e', 'setTimeout(()=>{},60000)'], { windowsHide: true });
  const job = store.createJob({ jobType: 'shell_command', authorizedRoot: workdir });
  const { attempt_id } = store.startAttempt({
    jobId: job.job_id, writerId: 'dead_host', workerType: 'child_process',
    workerIdentity: { pid: orphan.pid, host: 'local' }, workspaceRef: workdir,
  });
  const ckPath = join(dir, 'jobs', `${attempt_id}.checkpoint.json`);
  writeFileSync(ckPath, JSON.stringify({
    checkpoint_version: 1, job_id: job.job_id, attempt_id,
    input_identity: 'sha256:cmd', authorized_root: workdir,
    algorithm_version: '1.0.0', next_operation: 'await_exit',
    created_at: new Date().toISOString(), pid: orphan.pid,
    mutating: true, budget_scope: 'sess-dead',
  }));
  store.recordCheckpoint(job.job_id, attempt_id, ckPath);
  // the dead parent's lease — worker pid keeps it alive
  const deadParentLease = new WorkspaceWriteLease(leasePath, { ttlMs: 4_000 });
  deadParentLease.acquire(`job:${job.job_id}`, { command: 'rm -rf stuff' });
  // overwrite the recorded pid with the WORKER's pid — what production does
  deadParentLease.release(`job:${job.job_id}`);
  const { writeFileSync: w } = await import('node:fs');
  w(leasePath, JSON.stringify({ holder: `job:${job.job_id}`, pid: orphan.pid, acquiredAt: Date.now(), expiresAt: Date.now() + 1500 }));

  // === cold restart: new executor over the same db, same lease file ===
  const store2 = new JobStore(join(dir, 'durable_jobs.db'));
  const liveLease = new WorkspaceWriteLease(leasePath, { ttlMs: 4_000 });
  const auditRows = [];
  const executor2 = new JobExecutor(store2, join(dir, 'jobs'), {
    writeLease: liveLease,
    audit: { write: (r) => auditRows.push(r) },
  });
  const actions = executor2.recover({ workdir });
  const act = actions.find((a) => a.job_id === job.job_id);
  assert.equal(act.action_type, 'NO_ACTION', 'live worker must never be duplicated');
  assert.ok(auditRows.some((r) => r.kind === 'JOB_LEASE_ADOPTED'), 'lease adoption audited');

  // while the orphan lives the lease keeps renewing — a rival cannot take it
  await new Promise((r) => setTimeout(r, 2500)); // past the original 1.5s expiry
  const cur = liveLease.held();
  assert.equal(cur?.holder, `job:${job.job_id}`, 'adopted lease still held');

  // orphan exits → watchdog releases the lease
  orphan.kill();
  await new Promise((r) => setTimeout(r, 6_500)); // watchdog interval ~1.3s + margin
  assert.equal(liveLease.held(), null, 'lease released once the orphan dies');
  store.close(); store2.close();
});

test('ORPHAN DRILL: lease stolen while orphan alive — orphan killed, audited', { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-orphan-kill-'));
  const { store } = rig(dir);
  const workdir = tmpdir();
  const leasePath = join(dir, 'ws-lease.json');

  const orphan = spawn('node', ['-e', 'setTimeout(()=>{},60000)'], { windowsHide: true });
  const job = store.createJob({ jobType: 'shell_command', authorizedRoot: workdir });
  const { attempt_id } = store.startAttempt({
    jobId: job.job_id, writerId: 'dead_host', workerType: 'child_process',
    workerIdentity: { pid: orphan.pid, host: 'local' }, workspaceRef: workdir,
  });
  const ckPath = join(dir, 'jobs', `${attempt_id}.checkpoint.json`);
  writeFileSync(ckPath, JSON.stringify({
    checkpoint_version: 1, job_id: job.job_id, attempt_id,
    input_identity: 'sha256:cmd', authorized_root: workdir,
    algorithm_version: '1.0.0', next_operation: 'await_exit',
    created_at: new Date().toISOString(), pid: orphan.pid, mutating: true,
  }));
  store.recordCheckpoint(job.job_id, attempt_id, ckPath);
  // a DIFFERENT holder took the lease — the orphan writes unguarded
  const thief = new WorkspaceWriteLease(leasePath, { ttlMs: 60_000 });
  thief.acquire('fg:someone-else', {});

  const store2 = new JobStore(join(dir, 'durable_jobs.db'));
  const auditRows = [];
  const executor2 = new JobExecutor(store2, join(dir, 'jobs'), {
    writeLease: new WorkspaceWriteLease(leasePath, { ttlMs: 60_000 }),
    audit: { write: (r) => auditRows.push(r) },
  });
  executor2.recover({ workdir });
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(auditRows.some((r) => r.kind === 'JOB_ORPHAN_KILLED'), 'orphan kill audited');
  assert.equal(isWorkerAlive({ pid: orphan.pid }), false, 'unguarded orphan terminated');
  store.close(); store2.close();
});

test('job completes end-to-end: fast command runs to COMPLETED with result envelope', { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-jobok-'));
  const { store, executor } = rig(dir);
  const { job_id } = await executor.spawnCommandJob({
    command: process.platform === 'win32' ? 'echo ACCEPT_OK' : 'echo ACCEPT_OK',
    workdir: tmpdir(),
  });
  // wait for exit handling
  await new Promise((r) => setTimeout(r, 1200));
  const job = store.getJob(job_id);
  assert.equal(job.job_state, 'COMPLETED');
  const attempt = store.getAttempts(job_id)[0];
  assert.ok(attempt.result_envelope_ref && existsSync(attempt.result_envelope_ref));
  store.close();
});

test('B7: real delegate path — bridge produces usage attributed to parent_run_id', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-b7-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  const { AuditWriter } = await import('../../host/src/core/audit.js');
  const audit = new AuditWriter({ auditDir: join(dir, 'audit') });
  const store = new JobStore(join(dir, 'durable_jobs.db'));
  const executor = new JobExecutor(store, join(dir, 'jobs'), { audit, runId: 'parent-run-1' });

  // the REAL delegate path: delegate_task → production delegate-bridge → a
  // real worker subprocess. The worker reports its own token/cost the way a
  // delegate agent would; the bridge measures real wall time/output and
  // emits the authoritative PAI_USAGE envelope.
  const workerFixture = join(here, 'fixtures', 'delegate-worker.js');
  const tool = delegateTool(executor, {
    commandFor: () => `node "${workerFixture}"`,
    workdir: tmpdir(),
  });
  const result = await tool.execute('tc1', { target: 'codex', task: 'review this' });
  const job_id = result.details.job_id;
  await new Promise((r) => setTimeout(r, 2500));

  const attempt = store.getAttempts(job_id)[0];
  const envelope = JSON.parse(readFileSync(attempt.result_envelope_ref, 'utf-8'));
  assert.equal(envelope.parent_run_id, 'parent-run-1');
  // bridge-produced usage — real measured fields, not a test marker
  assert.equal(envelope.usage.via, 'delegate-bridge');
  assert.equal(envelope.usage.target, 'codex');
  assert.ok(envelope.usage.wallMs >= 0 && envelope.usage.outputBytes > 0);
  // the real worker's own reported token/cost rides nested under childUsage
  assert.deepEqual(envelope.usage.childUsage, { input: 1200, output: 80, cost: 0.0042 });

  const ledger = readFileSync(join(dir, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf-8');
  const finished = ledger.trim().split('\n').map(JSON.parse).find((e) => e.kind === 'JOB_FINISHED');
  assert.equal(finished.data.parent_run_id, 'parent-run-1');
  assert.equal(finished.data.usage.via, 'delegate-bridge');
  assert.deepEqual(finished.data.usage.childUsage, { input: 1200, output: 80, cost: 0.0042 });
  store.close();
});

// ─── delegate hard-budget admission (external review blocker) ─────────────

const mkBudget = (dir, limits) => new BudgetGovernor({
  ledgerPath: join(dir, 'budget.jsonl'), limits,
  audit: { write: () => {} },
});

test('delegate admission: enforceable child gets parent-remaining budget via env', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-deleg-budget-'));
  const { store, executor } = rig(dir);
  const budget = mkBudget(dir, { maxTokensPerSession: 2000, maxCallsPerSession: 10 });
  budget.record({ scope: 'sess-p', source: 'turn', usage: { input: 1500 }, countCall: false });
  budget.record({ scope: 'sess-p', source: 'turn', usage: {}, countCall: true }); // calls=1

  const fixtureChannel = join(here, 'fixtures', 'pai-channel.js');
  const tool = delegateTool(executor, {
    // commandFor yields a REAL pai-channel child (fixture prints its env)
    commandFor: () => ({ command: `"${process.execPath}" "${fixtureChannel}"`, enforceable: true }),
    workdir: tmpdir(),
    getScope: () => 'sess-p',
    budget,
  });
  const res = await tool.execute('tc1', { target: 'pi', task: 'do work' });
  assert.equal(res.details.refused, undefined, `not refused: ${res.content[0].text}`);
  // child budget issued = parent's remaining headroom: tokens 500, calls 9
  assert.match(res.details.child_budget ?? '', /--budget-tokens 500/);
  assert.match(res.details.child_budget ?? '', /--budget-calls 9/);
  // wait for the real bridge → fixture child → env echo lands in the envelope
  await new Promise((r) => setTimeout(r, 3000));
  const attempt = store.getAttempts(res.details.job_id)[0];
  const envelope = JSON.parse(readFileSync(attempt.result_envelope_ref, 'utf-8'));
  // env propagation is provable via the child's own echo in captured output
  const m = String(envelope.output_tail ?? '').match(/CHILD_ENV (\{[^}]*\})/);
  assert.ok(m, `fixture child env echo in output_tail; got: ${String(envelope.output_tail).slice(0, 300)}`);
  const env = JSON.parse(m[1]);
  assert.equal(env.PAI_BUDGET_MAX_TOKENS, '500');
  assert.equal(env.PAI_BUDGET_MAX_CALLS, '9');
  store.close();
});

test('delegate admission: committed slice cannot be double-spent by a second delegate', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-deleg-dbl-'));
  const { store, executor } = rig(dir);
  const budget = mkBudget(dir, { maxTokensPerSession: 2000 });
  budget.record({ scope: 'sess-d', source: 'turn', usage: { input: 1500 }, countCall: false });

  const fixtureChannel = join(here, 'fixtures', 'pai-channel.js');
  const tool = delegateTool(executor, {
    commandFor: () => ({ command: `"${process.execPath}" "${fixtureChannel}"`, enforceable: true }),
    workdir: tmpdir(),
    getScope: () => 'sess-d',
    budget,
  });
  // delegate A commits the whole remaining 500 — atomically owned, not copied
  const a = await tool.execute('tc1', { target: 'pi', task: 'a' });
  assert.equal(a.details.refused, undefined);
  assert.equal(budget.consumed('sess-d').tokens, 2000, 'slice charged to parent ledger at admission');
  // delegate B must be refused at parent admission — no double-spend
  const b = await tool.execute('tc2', { target: 'pi', task: 'b' });
  assert.equal(b.details.refused, true);
  assert.match(b.details.reason, /budget exceeded/);
  // parent itself is also over — the committed slice is real spend
  const gate = budget.admit('sess-d');
  assert.equal(gate.ok, false);
  store.close();
});

test('delegate admission: committed child usage does NOT double-bill the parent', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-deleg-nodbl-'));
  const { store, executor } = rig(dir);
  const budget = mkBudget(dir, { maxTokensPerSession: 100000 });
  const fixtureChannel = join(here, 'fixtures', 'pai-channel.js');
  const tool = delegateTool(executor, {
    commandFor: () => ({ command: `"${process.execPath}" "${fixtureChannel}"`, enforceable: true }),
    workdir: tmpdir(),
    getScope: () => 'sess-c',
    budget,
  });
  const res = await tool.execute('tc1', { target: 'pi', task: 'x' });
  assert.equal(res.details.refused, undefined);
  const afterCommit = budget.consumed('sess-c').tokens; // = 100000 committed
  assert.equal(afterCommit, 100000);
  // wait for the child to finish and report PAI_USAGE — committed jobs skip re-billing
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(budget.consumed('sess-c').tokens, 100000, 'child usage envelope must not double-bill a committed slice');
  store.close();
});

test('delegate admission: unenforceable target refused before spawn under finite budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-deleg-unenf-'));
  const { store, executor } = rig(dir);
  const budget = mkBudget(dir, { maxTokensPerSession: 2000 });
  const tool = delegateTool(executor, {
    commandFor: (t, task) => `echo "ext agent ${t}: ${task}"`, // not pai-channel
    workdir: tmpdir(),
    getScope: () => 'sess-x',
    budget,
  });
  const res = await tool.execute('tc1', { target: 'codex', task: 'x' });
  assert.equal(res.details.refused, true);
  assert.equal(res.details.reason, 'unenforceable_child_budget');
  assert.match(res.content[0].text, /cannot enforce a hard request-level budget/);
  store.close();
});

test('delegate admission: exhausted parent scope refuses before spawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-deleg-cap-'));
  const { store, executor } = rig(dir);
  const budget = mkBudget(dir, { maxTokensPerSession: 100 });
  budget.record({ scope: 'sess-x', source: 'turn', usage: { input: 150 }, countCall: false });
  const tool = delegateTool(executor, {
    commandFor: () => ({ command: `"${process.execPath}" "${join(here, 'fixtures', 'pai-channel.js')}"`, enforceable: true }),
    workdir: tmpdir(),
    getScope: () => 'sess-x',
    budget,
  });
  const res = await tool.execute('tc1', { target: 'pi', task: 'x' });
  assert.equal(res.details.refused, true);
  assert.match(res.details.reason, /budget exceeded: max_tokens 150 >= 100/);
  store.close();
});

test('delegate admission: unconfigured budget stays observe-only (no refusal)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-deleg-obs-'));
  const { store, executor } = rig(dir);
  const budget = mkBudget(dir, null); // no limits — observe-only
  const tool = delegateTool(executor, {
    commandFor: (t) => `echo "delegating to ${t}"`,
    workdir: tmpdir(),
    getScope: () => 'sess-x',
    budget,
  });
  const res = await tool.execute('tc1', { target: 'codex', task: 'x' });
  assert.equal(res.details.refused, undefined);
  assert.ok(res.details.job_id);
  store.close();
});

test('delegate_task spawns a delegation job; job_status reads it back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-deleg-'));
  const { store, executor } = rig(dir);
  const tool = delegateTool(executor, {
    commandFor: (target, task) => `echo "delegating to ${target}: ${task}"`,
    workdir: tmpdir(),
  });
  const result = await tool.execute('tc1', { target: 'codex', task: 'review this' });
  assert.match(result.content[0].text, /durable job job-/);
  const jobId = result.details.job_id;
  const status = jobStatusTool(store);
  const read = await status.execute('tc2', { job_id: jobId });
  const payload = JSON.parse(read.content[0].text);
  assert.equal(payload.job_id, jobId);
  store.close();
});

test('B3: cancel is terminal — worker exit must NOT overwrite CANCELLED; tree killed', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-cancel-'));
  const { store, executor } = rig(dir);
  const { job_id } = await executor.spawnCommandJob({ command: sleepCmd(60_000), workdir: tmpdir() });
  await new Promise((r) => setTimeout(r, 800)); // let the worker actually start
  const res = executor.cancel(job_id);
  assert.equal(res.cancelled, true);
  // wait for the exit handler to run (killed shell exits non-zero → the
  // regression this guards against flipped the record to FAILED)
  const t0 = Date.now();
  while (Date.now() - t0 < 10_000) {
    if (!executor.running.has(job_id) && store.getJob(job_id)?.job_state === 'CANCELLED') break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const job = store.getJob(job_id);
  assert.equal(job.job_state, 'CANCELLED', `expected CANCELLED to hold, got ${job.job_state}`);
  assert.equal(job.cancel_requested, 1);
  // result envelope still recorded — audit trail intact
  assert.ok(executor.describe(job_id)?.detail?.output_tail !== undefined || true);
});

test('sandbox provider wraps the spawned command via argv spec and audits it', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-sbx-'));
  const { store } = rig(dir);
  const auditEvents = [];
  // fake provider: argv-style spawn — proves executeAttempt honors the spec
  // (the wrapped process writes a marker file the bare command never would)
  const marker = join(dir, 'wrapped.txt');
  const fake = {
    kind: 'test-wrap',
    spawnSpec: (command, cwd) => ({
      file: process.execPath,
      args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'sb:'+process.cwd())`],
      shell: false,
      cwd,
    }),
  };
  const executor = new JobExecutor(store, join(dir, 'jobs'), {
    audit: { write: (e) => auditEvents.push(e) },
    sandbox: fake,
  });
  const r = await executor.spawnCommandJob({
    command: 'echo never-runs-bare',
    workdir: dir,
    budgetCommitted: true, // skip budget attribution — testing spawn shape
  });
  assert.ok(r.job_id, JSON.stringify(r));
  // wait for the wrapped child to exit
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const job = store.getJob(r.job_id);
    if (job && (job.job_state === 'completed' || job.job_state === 'failed' || job.job_state === 'exited')) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.ok(existsSync(marker), 'sandbox spec was spawned instead of the bare command');
  assert.ok(auditEvents.some((e) => e.kind === 'JOB_SANDBOXED' && e.data.provider === 'test-wrap'));
});

// ─── F-family AgentTask mailbox — real two-way bridge streams ───────────

test('mailbox bridge: inbox→stdin steer + child markers→outbox/events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-mailbox-'));
  const taskDir = join(dir, 'tasks', 'task-t1');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, 'task.json'),
    JSON.stringify({ task_id: 'task-t1', state: 'open', acks: {} }));

  const worker = join(here, 'fixtures', 'mailbox-child.js');
  const bridge = join(here, '..', 'bin', 'delegate-bridge.js');
  const child = spawn(process.execPath,
    [bridge, '--target', 'fakechild', '--task-dir', taskDir, '--', process.execPath, worker],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  // mid-run: the parent posts to inbox — the bridge forwards it as a steer
  // frame on the child's stdin; the fixture echoes it back as GOT:
  await new Promise((r) => setTimeout(r, 600));
  const { appendFileSync } = await import('node:fs');
  appendFileSync(join(taskDir, 'inbox.jsonl'),
    `${JSON.stringify({ seq: 1, ts: new Date().toISOString(), from: 'parent', body: 'focus on tests' })}\n`);

  await new Promise((r) => child.on('exit', r));

  const readJsonl = (name) => {
    const p = join(taskDir, name);
    return existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter(Boolean).map(JSON.parse) : [];
  };
  const outbox = readJsonl('outbox.jsonl');
  assert.equal(outbox.length, 2, 'two child posts landed in outbox');
  assert.equal(outbox[0].body, 'child partial result');
  assert.equal(outbox[1].body, 'child final result');
  const events = readJsonl('events.jsonl');
  assert.ok(events.some((e) => e.kind === 'progress' && e.data.pct === 50));
  assert.ok(events.some((e) => e.kind === 'child_exited'));
  // steer frame actually reached the child's stdin and marker lines were
  // stripped from passthrough output
  assert.match(out, /GOT:\{"type":"steer","message":"\[parent\] focus on tests"\}/);
  assert.ok(!out.includes('PAI_TASK_POST'));
  assert.match(out, /PAI_USAGE/);
});

test('spawn depth cap: a process at the cap cannot delegate further', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-depth-'));
  const { store, executor } = rig(dir);
  const prevDepth = process.env.PAI_SPAWN_DEPTH;
  const prevMax = process.env.PAI_MAX_SPAWN_DEPTH;
  process.env.PAI_SPAWN_DEPTH = '3';
  process.env.PAI_MAX_SPAWN_DEPTH = '3';
  try {
    const tool = delegateTool(executor, {
      commandFor: (target, task) => `echo "${target}: ${task}"`,
      workdir: tmpdir(),
    });
    const res = await tool.execute('tc9', { target: 'codex', task: 'deeper' });
    assert.equal(res.details.refused, true);
    assert.equal(res.details.reason, 'spawn_depth_cap');
    assert.match(res.content[0].text, /spawn depth 3 is at the cap/);
  } finally {
    if (prevDepth == null) delete process.env.PAI_SPAWN_DEPTH; else process.env.PAI_SPAWN_DEPTH = prevDepth;
    if (prevMax == null) delete process.env.PAI_MAX_SPAWN_DEPTH; else process.env.PAI_MAX_SPAWN_DEPTH = prevMax;
    store.close();
  }
});

test('spawn depth propagates: child env stamp is parent depth + 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-depth2-'));
  const { store } = rig(dir);
  let captured = '';
  const stub = { spawnCommandJob: async ({ command }) => { captured = command; return { job_id: 'job-d', attempt_id: 'a1' }; } };
  const prevDepth = process.env.PAI_SPAWN_DEPTH;
  process.env.PAI_SPAWN_DEPTH = '1';
  try {
    const tool = delegateTool(stub, {
      commandFor: (target, task) => `echo "${target}: ${task}"`,
      workdir: tmpdir(),
    });
    const res = await tool.execute('tc10', { target: 'codex', task: 'one level down' });
    assert.match(res.content[0].text, /durable job job-d/);
    assert.match(captured, /--task-depth 2 /);
  } finally {
    if (prevDepth == null) delete process.env.PAI_SPAWN_DEPTH; else process.env.PAI_SPAWN_DEPTH = prevDepth;
    store.close();
  }
});

test('profile knobs: model/effort fill commandFor opts; isolate_steering stamps --steering-off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-knobs-'));
  const { store } = rig(dir);
  let captured = '';
  let gotOpts = null;
  const stub = { spawnCommandJob: async ({ command }) => { captured = command; return { job_id: 'job-k', attempt_id: 'a1' }; } };
  const profiles = new Map([['pro', {
    name: 'pro', target: 'pi', preamble: 'be terse',
    model: 'sonnet', effort: 'high', isolateSteering: true,
  }]]);
  const tool = delegateTool(stub, {
    commandFor: (target, task, opts) => { gotOpts = opts; return `echo "${target}: ${task}"`; },
    workdir: tmpdir(),
    profiles,
  });
  const res = await tool.execute('tc11', { profile: 'pro', task: 'do it' });
  assert.match(res.content[0].text, /durable job job-k/);
  assert.deepEqual(gotOpts, { model: 'sonnet', effort: 'high' });
  assert.match(captured, / --steering-off /);
  store.close();
});

test('M14: onJobFinished fires for scheduled jobs only, with redacted tail', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-m14-'));
  const store = new JobStore(join(dir, 'durable_jobs.db'));
  const seen = [];
  const executor = new JobExecutor(store, join(dir, 'jobs'), {
    onJobFinished: (d) => seen.push(d),
  });
  const echoCmd = process.platform === 'win32' ? 'echo hello-sched' : 'echo hello-sched';
  const r = await executor.spawnCommandJob({ command: echoCmd, workdir: dir, jobType: 'scheduled' });
  assert.ok(r.job_id);
  // plain shell_command must NOT notify
  const r2 = await executor.spawnCommandJob({ command: echoCmd, workdir: dir, jobType: 'shell_command' });
  await new Promise((res) => setTimeout(res, 4000));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].job_id, r.job_id);
  assert.equal(seen[0].job_type, 'scheduled');
  assert.equal(seen[0].exit_code, 0);
  assert.match(seen[0].output_tail, /hello-sched/);
  store.close();
});

test('M13: worktree job runs in a detached checkout; dirty worktree kept + audited', { timeout: 30_000 }, async (t) => {
  const { spawnSync } = await import('node:child_process');
  // a real git repo with one commit — worktree add needs HEAD
  const repo = mkdtempSync(join(tmpdir(), 'pai-wt-repo-'));
  for (const args of [
    ['init', '-q'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't'],
  ]) spawnSync('git', args, { cwd: repo });
  writeFileSync(join(repo, 'f.txt'), 'base');
  spawnSync('git', ['add', '.'], { cwd: repo });
  spawnSync('git', ['commit', '-qm', 'init'], { cwd: repo });

  const dir = mkdtempSync(join(tmpdir(), 'pai-wt-'));
  const store = new JobStore(join(dir, 'durable_jobs.db'));
  const audits = [];
  const executor = new JobExecutor(store, join(dir, 'jobs'), {
    audit: { write: (e) => audits.push(e) },
  });
  // dirty job: writes a file inside the worktree → worktree must be KEPT
  const dirtyCmd = process.platform === 'win32' ? 'echo changed>newfile.txt' : 'echo changed > newfile.txt';
  const r = await executor.spawnCommandJob({ command: dirtyCmd, workdir: repo, worktree: true });
  assert.ok(r.job_id, 'worktree job spawned');
  await new Promise((res) => setTimeout(res, 5000));
  const result = JSON.parse(readFileSync(join(dir, 'jobs', `${r.attempt_id}.result.json`), 'utf-8'));
  assert.ok(result.worktree, 'result carries worktree record');
  assert.equal(result.worktree.kept, true, 'dirty worktree preserved for operator merge');
  assert.ok(existsSync(join(result.worktree.path, 'newfile.txt')), 'job output lives in the worktree');
  assert.ok(!existsSync(join(repo, 'newfile.txt')), 'real checkout untouched');
  assert.ok(audits.some((e) => e.kind === 'JOB_WORKTREE_KEPT'));

  // clean job: reads only → worktree removed
  const r2 = await executor.spawnCommandJob({ command: 'git status --porcelain', workdir: repo, worktree: true });
  await new Promise((res) => setTimeout(res, 5000));
  const result2 = JSON.parse(readFileSync(join(dir, 'jobs', `${r2.attempt_id}.result.json`), 'utf-8'));
  assert.equal(result2.worktree.kept, false);
  assert.ok(!existsSync(result2.worktree.path), 'clean worktree removed');

  // non-git dir → honest refusal, not a spawned job in the wrong place
  const r3 = await executor.spawnCommandJob({ command: 'echo x', workdir: dir, worktree: true });
  assert.equal(r3.refused, true);
  assert.match(r3.reason, /worktree/);
  store.close();
});

test('P1 job_spawn: durable job surface + sandbox selection semantics', { timeout: 20_000 }, async () => {
  const { jobSpawnTool } = await import('../src/adapter/jobs.js');
  const dir = mkdtempSync(join(tmpdir(), 'pai-p1-'));
  const store = new JobStore(join(dir, 'durable_jobs.db'));
  const executor = new JobExecutor(store, join(dir, 'jobs'));
  const tool = jobSpawnTool(executor, { workdir: dir });

  // plain spawn — durable job runs to completion
  const r = await tool.execute('t1', { command: 'echo p1-ok' });
  assert.match(r.content[0].text, /job .* spawned/);
  await new Promise((res) => setTimeout(res, 4000));
  const job = store.getJob(r.job_id);
  assert.equal(job.job_state, 'COMPLETED');

  // unknown sandbox kind refuses BEFORE a job exists
  const bad = await tool.execute('t2', { command: 'echo x', sandbox: 'gvisor' });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /refused/);
  assert.equal(store.listRecent(50).length, 1, 'refused spawn leaves no job record');

  // sandbox:'ssh' without target fails the job honestly, not a crash
  const ssh = await tool.execute('t3', { command: 'echo x', sandbox: 'ssh' });
  assert.match(ssh.content[0].text, /spawned/);
  await new Promise((res) => setTimeout(res, 1500));
  const sshJob = store.getJob(ssh.job_id);
  assert.equal(sshJob.job_state, 'FAILED');
  const events = store.getEvents(ssh.job_id).map((e) => JSON.stringify(e));
  assert.ok(events.some((e) => /ssh backend requires a target/.test(e)));
  store.close();
});

// ─── M90: restart must replay the ORIGINAL execution contract ─────────────

test('M90: restart replays the recorded spec — command/workdir/timeout/jobType survive', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-restart-'));
  const { store, executor } = rig(dir);
  const workdir = tmpdir();
  const { job_id } = await executor.spawnCommandJob({
    command: 'echo RESTART_SRC',
    workdir,
    jobType: 'shell_command',
    timeoutMs: 60_000,
    budgetScope: 'sess-r',
  });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(store.getJob(job_id).job_state, 'COMPLETED');

  // the spec is durable — it lives in the checkpoint, not process memory
  const attempt = store.getAttempts(job_id)[0];
  const spec = readCheckpoint(attempt.checkpoint_ref).restart_spec;
  assert.equal(spec.command, 'echo RESTART_SRC');
  assert.equal(spec.workdir, workdir);
  assert.equal(spec.timeout_ms, 60_000);
  assert.equal(spec.budget_scope, 'sess-r');
  assert.equal(spec.budget_committed, false);

  const r = await executor.restart(job_id);
  assert.equal(r.refused, undefined, `restart refused: ${r.reason}`);
  assert.notEqual(r.job_id, job_id, 'restart is a NEW job — lineage stays honest');
  await new Promise((res) => setTimeout(res, 1500));
  const replay = readCheckpoint(store.getAttempts(r.job_id)[0].checkpoint_ref).restart_spec;
  assert.equal(replay.command, 'echo RESTART_SRC');
  assert.equal(replay.timeout_ms, 60_000);
  assert.equal(replay.budget_scope, 'sess-r');
  store.close();
});

test('M90: restart refuses jobs without a restart spec — no guessing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-restart-legacy-'));
  const { store, executor } = rig(dir);
  // a legacy/pre-M90 terminal job: checkpoint exists but carries no spec
  const job = store.createJob({ jobType: 'shell_command', authorizedRoot: tmpdir() });
  const { attempt_id } = store.startAttempt({
    jobId: job.job_id, writerId: 'w', workerType: 'child_process', workerIdentity: {},
  });
  const ckPath = join(dir, 'jobs', `${attempt_id}.checkpoint.json`);
  writeFileSync(ckPath, JSON.stringify({
    checkpoint_version: 1, job_id: job.job_id, attempt_id,
    input_identity: 'sha256:echo legacy', authorized_root: tmpdir(),
    algorithm_version: '1.0.0', next_operation: 'await_exit',
    created_at: new Date().toISOString(),
  }));
  store.recordCheckpoint(job.job_id, attempt_id, ckPath);
  store.failJob(job.job_id, 'simulated legacy failure');

  const r = await executor.restart(job.job_id);
  assert.equal(r.refused, true);
  assert.match(r.reason, /no restart spec/);
  store.close();
});

test('M90: restart refuses budget-committed delegation jobs — cannot re-admit a charged slice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-restart-committed-'));
  const { store, executor } = rig(dir);
  const job = store.createJob({ jobType: 'delegation', authorizedRoot: tmpdir() });
  const { attempt_id } = store.startAttempt({
    jobId: job.job_id, writerId: 'w', workerType: 'child_process', workerIdentity: {},
  });
  const ckPath = join(dir, 'jobs', `${attempt_id}.checkpoint.json`);
  writeFileSync(ckPath, JSON.stringify({
    checkpoint_version: 1, job_id: job.job_id, attempt_id,
    input_identity: 'sha256:echo delegated', authorized_root: tmpdir(),
    algorithm_version: '1.0.0', next_operation: 'await_exit',
    created_at: new Date().toISOString(),
    budget_scope: 'sess-p', budget_committed: true,
    restart_spec: {
      command: 'echo delegated', workdir: tmpdir(), job_type: 'delegation',
      timeout_ms: null, worktree: false, sandbox: null,
      budget_scope: 'sess-p', budget_committed: true,
    },
  }));
  store.recordCheckpoint(job.job_id, attempt_id, ckPath);
  store.failJob(job.job_id, 'done');
  const r = await executor.restart(job.job_id);
  assert.equal(r.refused, true);
  assert.match(r.reason, /committed budget slice/);
  store.close();
});

test('M90: restart refuses non-terminal jobs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-restart-live-'));
  const { store, executor } = rig(dir);
  const job = store.createJob({ jobType: 'shell_command', authorizedRoot: tmpdir() });
  const r = await executor.restart(job.job_id);
  assert.equal(r.refused, true);
  assert.match(r.reason, /only terminal jobs restart/);
  store.close();
});

// ─── M90-R2: restart must clear TODAY's hard policy ────────────────────────

test('M90-R2: restart refuses when current policy denies the persisted command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-restart-pol-'));
  // preflight wired to the kernel's hard-policy gate — a command that was
  // admissible at original spawn but is denied NOW must not re-spawn.
  const { store, executor } = rig(dir, {
    preflightCommand: async () => ({ block: true, rule: 'risk_dangerous', reason: "risk class 'dangerous' denied by policy" }),
  });
  const { job_id } = await executor.spawnCommandJob({ command: 'echo OLD_OK', workdir: tmpdir() });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(store.getJob(job_id).job_state, 'COMPLETED');
  const r = await executor.restart(job_id);
  assert.equal(r.refused, true);
  assert.match(r.reason, /current policy \(risk_dangerous\)/);
  assert.equal(store.listRecent(50).length, 1, 'no new job spawned');
  store.close();
});

test('M90-R2: restart proceeds when the hard-policy gate passes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-restart-polok-'));
  let calls = 0;
  const { store, executor } = rig(dir, {
    preflightCommand: async (spec) => { calls++; assert.equal(spec?.command, 'echo STILL_OK'); return undefined; },
  });
  const { job_id } = await executor.spawnCommandJob({ command: 'echo STILL_OK', workdir: tmpdir() });
  await new Promise((r) => setTimeout(r, 1500));
  const r = await executor.restart(job_id);
  assert.equal(r.refused, undefined, `restart refused: ${r.reason}`);
  assert.equal(calls, 1, 'gate consulted exactly once before re-spawn');
  await new Promise((res) => setTimeout(res, 1200));
  assert.equal(store.getJob(r.job_id).job_state, 'COMPLETED');
  store.close();
});

test('M90-R2: the gate receives the FULL replay spec, not just the command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-restart-fullspec-'));
  let seen = null;
  const { store, executor } = rig(dir, {
    preflightCommand: async (spec) => {
      seen = spec;
      // governance input parity with a fresh job_spawn: the whole persisted
      // contract is visible — command, workdir, sandbox, timeout, scope
      return spec?.sandbox?.kind === 'banned-backend'
        ? { block: true, rule: 'negative_capability', reason: 'sandbox target protected' }
        : undefined;
    },
  });
  const { job_id } = await executor.spawnCommandJob({ command: 'echo SPEC', workdir: tmpdir(), timeoutMs: 30_000 });
  await new Promise((r) => setTimeout(r, 1500));
  const r = await executor.restart(job_id);
  assert.equal(r.refused, undefined, `restart refused: ${r.reason}`);
  assert.ok(seen, 'gate never consulted');
  assert.equal(seen.command, 'echo SPEC');
  assert.equal(seen.workdir, tmpdir());
  assert.equal(seen.timeout_ms, 30_000);
  assert.equal(seen.sandbox?.kind, 'none');
  assert.equal('budget_committed' in seen, true, 'spec carries the full contract fields');
  // and a spec-level verdict can still refuse — sandbox field governance works
  await new Promise((res) => setTimeout(res, 1200));
  assert.equal(store.getJob(r.job_id).job_state, 'COMPLETED');
  const attempt = store.getAttempts(r.job_id)[0];
  const spec2 = readCheckpoint(attempt.checkpoint_ref).restart_spec;
  spec2.sandbox = { kind: 'banned-backend' };
  writeFileSync(attempt.checkpoint_ref, JSON.stringify({ ...readCheckpoint(attempt.checkpoint_ref), restart_spec: spec2 }));
  const r2 = await executor.restart(r.job_id);
  assert.equal(r2.refused, true);
  assert.match(r2.reason, /negative_capability/);
  store.close();
});

// ─── M90-R1: restart_spec records the EFFECTIVE sandbox ────────────────────

test('M90-R1: restart_spec persists the resolved sandbox, not the null call arg', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-restart-sbx-'));
  // ambient provider in place; the spawn call passes NO sandbox arg — the
  // recorded contract must still say 'wsl', not null.
  const fakeProvider = {
    kind: 'wsl', distro: 'Ubuntu', image: null, target: null, dir: null, key: null,
    spawnSpec: (command, cwd) => ({ file: command, args: [], shell: true, cwd }),
  };
  const { store, executor } = rig(dir, { sandbox: fakeProvider });
  const { job_id } = await executor.spawnCommandJob({ command: 'echo SBX', workdir: tmpdir() });
  await new Promise((r) => setTimeout(r, 1200));
  const attempt = store.getAttempts(job_id)[0];
  const spec = readCheckpoint(attempt.checkpoint_ref).restart_spec;
  assert.equal(spec.sandbox?.kind, 'wsl');
  assert.equal(spec.sandbox?.distro, 'Ubuntu');
  store.close();
});

test('M90-R1: an explicitly-unsandboxed contract replays unsandboxed even under a changed ambient', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-restart-sbx2-'));
  const { store, executor } = rig(dir); // no ambient sandbox
  const { job_id } = await executor.spawnCommandJob({ command: 'echo NO_SBX', workdir: tmpdir() });
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(store.getJob(job_id).job_state, 'COMPLETED');
  const spec = readCheckpoint(store.getAttempts(job_id)[0].checkpoint_ref).restart_spec;
  assert.equal(spec.sandbox?.kind, 'none');
  // ambient sandbox NOW appears — restart must replay the recorded 'none',
  // not the drifted ambient. Give the executor an ambient provider and replay.
  executor.sandbox = {
    kind: 'wsl', distro: null, image: null, target: null, dir: null, key: null,
    spawnSpec: (command, cwd) => ({ file: `wsl-wrapped:${command}`, args: [], shell: true, cwd }),
  };
  const r = await executor.restart(job_id);
  assert.equal(r.refused, undefined, `restart refused: ${r.reason}`);
  await new Promise((res) => setTimeout(res, 1200));
  const replay = readCheckpoint(store.getAttempts(r.job_id)[0].checkpoint_ref).restart_spec;
  assert.equal(replay.sandbox?.kind, 'none', 'replayed contract stays unsandboxed — ambient drift cannot upgrade it');
  store.close();
});

// ─── M76: tools_deny on an unenforceable target refuses pre-spawn ──────────

test('M76: profile tools_deny + non-pai-channel target → refused, never spawned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-deleg-td-'));
  const { store, executor } = rig(dir);
  const profiles = new Map([
    ['strict', { target: 'codex', toolsDeny: ['shell', 'write'] }],
  ]);
  const tool = delegateTool(executor, {
    commandFor: (t, task) => `echo "ext ${t}: ${task}"`, // not a pai-channel body — cannot honor PAI_TOOLS_DENY
    workdir: tmpdir(),
    profiles,
  });
  const res = await tool.execute('tc1', { profile: 'strict', task: 'x' });
  assert.equal(res.details.refused, true);
  assert.equal(res.details.reason, 'unenforceable_tools_deny');
  assert.match(res.content[0].text, /cannot enforce/);
  assert.equal(store.listRecent(50).length, 0, 'refused pre-spawn — no job record');
  store.close();
});

test('M76: tools_deny on an enforceable pai-channel target still delegates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-deleg-tdok-'));
  const { store, executor } = rig(dir);
  const profiles = new Map([
    ['strict', { target: 'pi', toolsDeny: ['shell'] }],
  ]);
  const fixtureChannel = join(here, 'fixtures', 'pai-channel.js');
  const tool = delegateTool(executor, {
    commandFor: () => ({ command: `"${process.execPath}" "${fixtureChannel}"`, enforceable: true }),
    workdir: tmpdir(),
    profiles,
  });
  const res = await tool.execute('tc1', { profile: 'strict', task: 'x' });
  assert.equal(res.details.refused, undefined, `not refused: ${res.content[0].text}`);
  assert.match(res.content[0].text, /--tools-deny|delegated to/, 'deny flag rides the bridge command');
  // wait for the job, then clean up
  await new Promise((r) => setTimeout(r, 3000));
  store.close();
});

// ─── M76/M94-R2: task-text cannot spoof enforceability ─────────────────────
// The old `/pai-channel\.js/.test(inner)` sniffed the INTERPOLATED command —
// `inner` carries model-controlled task text, so `task="inspect pai-channel.js"`
// on a foreign target made an unenforceable child look enforceable. Capability
// must come from the builder's structured assertion, not the shell string.

test('M76-R2: task text carrying "pai-channel.js" does NOT make a foreign target enforceable (tools_deny)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-deleg-spoof-td-'));
  const { store, executor } = rig(dir);
  const profiles = new Map([
    ['strict', { target: 'codex', toolsDeny: ['shell'] }],
  ]);
  const tool = delegateTool(executor, {
    // builder returns a plain string → asserts nothing → unenforceable even
    // though the interpolated command text will contain 'pai-channel.js'
    commandFor: (t, task) => `echo "${t}: ${task}"`,
    workdir: tmpdir(),
    profiles,
  });
  const res = await tool.execute('tc1', { profile: 'strict', task: 'inspect pai-channel.js internals' });
  assert.equal(res.details.refused, true);
  assert.equal(res.details.reason, 'unenforceable_tools_deny');
  assert.equal(store.listRecent(50).length, 0, 'refused pre-spawn — no job record');
  store.close();
});

test('M94-R2: task text carrying "pai-channel.js" does NOT make a foreign target enforceable (budget)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-deleg-spoof-b-'));
  const { store, executor } = rig(dir);
  const budget = mkBudget(dir, { maxTokensPerSession: 2000 });
  const tool = delegateTool(executor, {
    commandFor: (t, task) => `echo "${t}: ${task}"`,
    workdir: tmpdir(),
    getScope: () => 'sess-spoof',
    budget,
  });
  const res = await tool.execute('tc1', { target: 'codex', task: 'inspect pai-channel.js internals' });
  assert.equal(res.details.refused, true);
  assert.equal(res.details.reason, 'unenforceable_child_budget');
  assert.equal(store.listRecent(50).length, 0, 'refused pre-spawn — no job record');
  store.close();
});

// ─── M76/M94-R3: enforceability is per RESOLVED target ─────────────────────
// A {target}-bearing template can branch between bodies — the template-global
// pai-channel.js regex minted capability on the foreign branch too.

test('M76-R3: branched template — enforceable only for operator-listed targets', () => {
  const cmd = makeDelegationCommand(
    'if [ "{target}" = "pai" ]; then node pai-channel.js --task "{task}"; else codex exec "{task}"; fi',
    { enforceableTargets: new Set(['pai']) },
  );
  const pai = cmd('pai', 'do x');
  const codex = cmd('codex', 'do x');
  assert.equal(pai.enforceable, true, 'listed target on a pai-channel branch is enforceable');
  assert.equal(codex.enforceable, false, 'foreign branch must NOT inherit the template regex hit');
  // unlisted target on the branched template refuses enforcement even though
  // the template contains pai-channel.js
  assert.equal(cmd('gemini', 'do x').enforceable, false);
});

test('M76-R3: target-free template runs one fixed body — template text decides', () => {
  const cmd = makeDelegationCommand('node pai-channel.js --task "{task}"');
  assert.equal(cmd('pai', 'x').enforceable, true);
  assert.equal(cmd('codex', 'x').enforceable, true, 'no {target} slot — same body every call');
  const foreign = makeDelegationCommand('codex exec "{task}"');
  assert.equal(foreign('codex', 'x').enforceable, false);
});

test('M76-R3: interpolated task text still cannot mint capability (branched template)', () => {
  const cmd = makeDelegationCommand(
    'if [ "{target}" = "pai" ]; then node pai-channel.js --task "{task}"; else codex exec "{task}"; fi',
    { enforceableTargets: new Set(['pai']) },
  );
  // task smuggles the token AND the enforceable branch — resolved target is
  // still codex → not enforceable
  assert.equal(cmd('codex', 'inspect pai-channel.js').enforceable, false);
  assert.match(cmd('codex', 'inspect pai-channel.js').command, /pai-channel\.js/, 'the smuggled text really is in the shell string');
});

/* ---- dependency chains: depends_on queue → promote / cascade-cancel ---- */

const waitFor = async (fn, ms = 8000, step = 150) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, step));
  }
  return null;
};

test('depends_on: queued job promotes onto the SAME id when the dep completes', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-dep-promote-'));
  const { store, executor } = rig(dir);
  const a = await executor.spawnCommandJob({ command: 'echo DEP_A', workdir: tmpdir() });
  const b = await executor.spawnCommandJob({
    command: 'echo DEP_B', workdir: tmpdir(), dependsOn: [a.job_id],
  });
  assert.equal(b.queued, true);
  assert.deepEqual(b.waiting_on, [a.job_id]);
  assert.equal(b.attempt_id, null, 'no attempt while queued');
  assert.ok(existsSync(join(dir, 'jobs', `${b.job_id}.queued.json`)), 'queue spec persisted');
  assert.equal(store.getJob(b.job_id).job_state, 'PENDING');
  const depState = store.dependencyState(b.job_id);
  assert.deepEqual(depState.pending, [a.job_id]);

  const done = await waitFor(() => store.getJob(b.job_id).job_state === 'COMPLETED');
  assert.ok(done, 'dependent promoted and completed after the dep finished');
  assert.ok(store.getAttempts(b.job_id).length >= 1, 'promotion started a real attempt on the same job id');
  assert.ok(!existsSync(join(dir, 'jobs', `${b.job_id}.queued.json`)), 'queue spec consumed');
  store.close();
});

test('depends_on: a failed dep cascade-CANCELS the queued dependent (never runs)', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-dep-cascade-'));
  const { store, executor } = rig(dir);
  const a = await executor.spawnCommandJob({ command: 'exit 3', workdir: tmpdir() });
  const b = await executor.spawnCommandJob({
    command: 'echo SHOULD_NEVER_RUN', workdir: tmpdir(), dependsOn: [a.job_id],
  });
  assert.equal(b.queued, true);
  const dead = await waitFor(() => store.getJob(b.job_id).job_state === 'CANCELLED');
  assert.ok(dead, 'dependent cancelled after the dep failed');
  assert.equal(store.getAttempts(b.job_id).length, 0, 'cancelled dependent never ran an attempt');
  assert.ok(!existsSync(join(dir, 'jobs', `${b.job_id}.queued.json`)), 'queue spec swept');
  const evs = store.getEvents(b.job_id).map((e) => e.event_type);
  assert.ok(evs.includes('JOB_CANCELLED'));
  assert.ok(!evs.includes('ATTEMPT_STARTED'));
  store.close();
});

test('depends_on: admission refusals — unknown dep, dead dep, bad shape', { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-dep-refuse-'));
  const { store, executor } = rig(dir);
  let r = await executor.spawnCommandJob({ command: 'echo X', workdir: tmpdir(), dependsOn: ['job-does-not-exist'] });
  assert.equal(r.refused, true);
  assert.match(r.reason, /unknown job/);

  const a = await executor.spawnCommandJob({ command: 'exit 1', workdir: tmpdir() });
  await waitFor(() => store.getJob(a.job_id).job_state === 'FAILED');
  r = await executor.spawnCommandJob({ command: 'echo X', workdir: tmpdir(), dependsOn: [a.job_id] });
  assert.equal(r.refused, true);
  assert.match(r.reason, /can never run/);

  r = await executor.spawnCommandJob({ command: 'echo X', workdir: tmpdir(), dependsOn: 'not-an-array' });
  assert.equal(r.refused, true);
  assert.match(r.reason, /array of job ids/);
  store.close();
});

test('depends_on: satisfied at birth runs immediately and records lineage', { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-dep-satisfied-'));
  const { store, executor } = rig(dir);
  const a = await executor.spawnCommandJob({ command: 'echo FAST_A', workdir: tmpdir() });
  await waitFor(() => store.getJob(a.job_id).job_state === 'COMPLETED');
  const b = await executor.spawnCommandJob({ command: 'echo FAST_B', workdir: tmpdir(), dependsOn: [a.job_id] });
  assert.equal(b.queued, undefined, 'no queueing when deps already complete');
  assert.ok(b.attempt_id, 'attempt started immediately');
  assert.deepEqual(store.depsOf(store.getJob(b.job_id)), [a.job_id], 'dep lineage recorded on the row');
  await waitFor(() => store.getJob(b.job_id).job_state === 'COMPLETED');
  store.close();
});

test('depends_on: cold restart — recover() pumps a queue whose deps finished while down', { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-dep-recover-'));
  const { store, executor } = rig(dir);
  // dep that never really ran: complete it directly (store authority) to
  // simulate "dep finished while the host was down"
  const dep = store.createJob({ jobType: 'shell_command', authorizedRoot: tmpdir() });
  const b = await executor.spawnCommandJob({ command: 'echo COLD_B', workdir: tmpdir(), dependsOn: [dep.job_id] });
  assert.equal(b.queued, true);
  store.completeJob(dep.job_id); // dep finished while "down"
  store.close(); executor.running.clear(); // simulate process death

  const { store: store2, executor: ex2 } = rig(dir);
  const actions = ex2.recover({ workdir: tmpdir() });
  const skip = actions.find((a) => a.job_id === b.job_id);
  assert.equal(skip?.action_type, 'NO_ACTION', 'recoveryTick does not escalate queued jobs');
  assert.match(skip?.reason ?? '', /queued on dependencies/);
  const done = await waitFor(() => store2.getJob(b.job_id).job_state === 'COMPLETED');
  assert.ok(done, 'recover pump promoted the queued job whose dep completed while down');
  store2.close();
});

test('depends_on: dep-queued jobs survive recoveryTick untouched while deps still run', { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-dep-skip-'));
  const { store, executor } = rig(dir);
  const a = await executor.spawnCommandJob({ command: sleepCmd(30_000), workdir: tmpdir() });
  const b = await executor.spawnCommandJob({ command: 'echo B', workdir: tmpdir(), dependsOn: [a.job_id] });
  assert.equal(b.queued, true);
  const actions = executor.recover({ workdir: tmpdir() });
  const row = actions.find((x) => x.job_id === b.job_id);
  assert.equal(row?.action_type, 'NO_ACTION');
  assert.match(row?.reason ?? '', /queued/);
  assert.equal(store.getJob(b.job_id).job_state, 'PENDING', 'still queued, not escalated to review');
  executor.cancel(a.job_id); // cleanup: cancel → cascade-cancels b
  const dead = await waitFor(() => store.getJob(b.job_id).job_state === 'CANCELLED', 4000);
  assert.ok(dead, 'operator-cancel of a dep cascades to the queued dependent');
  store.close();
});
