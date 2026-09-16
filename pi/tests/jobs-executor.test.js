/**
 * M4 exit gate — the kill drill: spawn a durable job, KILL the worker process,
 * cold-start a new executor over the same db, recoveryTick must RESUME it
 * under a new attempt. Plus long-command classifier + delegate tool surface.
 */
import { mkdtempSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JobStore } from '../../host/src/core/jobs.js';
import { JobExecutor, isLongRunningCommand, isWorkerAlive, validateCheckpoint } from '../src/adapter/jobs.js';
import { delegateTool, jobStatusTool } from '../src/adapter/delegate.js';

const rig = (dir) => {
  const store = new JobStore(join(dir, 'durable_jobs.db'));
  const executor = new JobExecutor(store, join(dir, 'jobs'));
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

test('job completes end-to-end: fast command runs to COMPLETED with result envelope', { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-jobok-'));
  const { store, executor } = rig(dir);
  const { job_id } = executor.spawnCommandJob({
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

test('B7: delegated worker usage is recorded under parent_run_id', { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-b7-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  const { AuditWriter } = await import('../../host/src/core/audit.js');
  const audit = new AuditWriter({ auditDir: join(dir, 'audit') });
  const store = new JobStore(join(dir, 'durable_jobs.db'));
  const executor = new JobExecutor(store, join(dir, 'jobs'), { audit, runId: 'parent-run-1' });

  // fake delegate worker: reports its token/cost usage on stdout
  const { job_id, attempt_id } = executor.spawnCommandJob({
    command: `node -e "console.log('PAI_USAGE '+JSON.stringify({input:1200,output:80,cost:0.0042}))"`,
    workdir: tmpdir(),
    jobType: 'delegation',
  });
  await new Promise((r) => setTimeout(r, 1500));

  const attempt = store.getAttempts(job_id)[0];
  const envelope = JSON.parse(readFileSync(attempt.result_envelope_ref, 'utf-8'));
  assert.equal(envelope.parent_run_id, 'parent-run-1');
  assert.deepEqual(envelope.usage, { input: 1200, output: 80, cost: 0.0042 });

  const ledger = readFileSync(join(dir, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf-8');
  const finished = ledger.trim().split('\n').map(JSON.parse).find((e) => e.kind === 'JOB_FINISHED');
  assert.equal(finished.data.parent_run_id, 'parent-run-1');
  assert.deepEqual(finished.data.usage, { input: 1200, output: 80, cost: 0.0042 });
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
