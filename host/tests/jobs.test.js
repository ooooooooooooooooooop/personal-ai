/**
 * M4 host-side durable job state machine — JobStore (node:sqlite port of
 * scripts/jobs/). Probes are injected; the store itself is harness-neutral.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JobStore, JobState, LeaseDeniedError } from '../src/core/jobs.js';

const store = () => new JobStore(join(mkdtempSync(join(tmpdir(), 'pai-jobs-')), 'jobs.db'));
const validCkpt = (jobId, attemptId, root = '/tmp') => ({
  checkpoint_version: 1, job_id: jobId, attempt_id: attemptId,
  input_identity: 'sha256:cmd', authorized_root: root, algorithm_version: '1.0.0',
});

test('createJob → startAttempt acquires the single-writer lease atomically', () => {
  const s = store();
  const job = s.createJob({ jobType: 'shell_command' });
  assert.equal(job.job_state, JobState.PENDING);
  const { attempt_id, lease } = s.startAttempt({
    jobId: job.job_id, writerId: 'w1', workerType: 'child_process', workerIdentity: { pid: 1 },
  });
  assert.equal(s.getJob(job.job_id).job_state, JobState.RUNNING);
  assert.equal(s.getJob(job.job_id).current_attempt_id, attempt_id);
  // second writer denied while lease is live
  assert.throws(
    () => s.startAttempt({ jobId: job.job_id, writerId: 'w2', workerType: 'x', workerIdentity: {} }),
    LeaseDeniedError,
  );
  // lease renew + release lifecycle
  s.renewLease(job.job_id, lease.lease_id);
  assert.ok(s.releaseLease(job.job_id, lease.lease_id));
});

test('completed jobs refuse new attempts; events form an audit trail', () => {
  const s = store();
  const job = s.createJob({ jobType: 't' });
  const { attempt_id } = s.startAttempt({ jobId: job.job_id, writerId: 'w', workerType: 'p', workerIdentity: {} });
  s.recordCheckpoint(job.job_id, attempt_id, '/tmp/ck.json');
  assert.equal(s.getJob(job.job_id).job_state, JobState.CHECKPOINTED);
  s.updateWorkerState(attempt_id, 'EXITED_0', 0);
  s.completeJob(job.job_id);
  assert.throws(() => s.startAttempt({ jobId: job.job_id, writerId: 'w', workerType: 'p', workerIdentity: {} }));
  const types = s.getEvents(job.job_id).map((e) => e.event_type);
  assert.ok(types.includes('JOB_CREATED') && types.includes('LEASE_ACQUIRED')
    && types.includes('CHECKPOINT_WRITTEN') && types.includes('WORKER_EXITED')
    && types.includes('JOB_COMPLETED'));
});

test('orchestration end never auto-fails the job — invariant', () => {
  const s = store();
  const job = s.createJob({ jobType: 't' });
  s.startAttempt({ jobId: job.job_id, writerId: 'w', workerType: 'p', workerIdentity: {} });
  s.updateOrchestrationState(job.job_id, 'ENDED_ROUND_LIMIT');
  assert.equal(s.getJob(job.job_id).job_state, JobState.RUNNING); // still alive
});

test('recoveryTick: alive worker → NO_ACTION, never a duplicate', () => {
  const s = store();
  const job = s.createJob({ jobType: 't' });
  s.startAttempt({ jobId: job.job_id, writerId: 'w', workerType: 'p', workerIdentity: { pid: 4242 } });
  const actions = s.recoveryTick({ isWorkerAlive: () => true, validateCheckpoint: () => ({ valid: true }) });
  assert.equal(actions[0].action_type, 'NO_ACTION');
  assert.equal(s.getAttempts(job.job_id).length, 1); // no duplicate attempt
});

test('recoveryTick: dead worker + valid checkpoint → RESUME_ATTEMPT', () => {
  const s = store();
  const dir = mkdtempSync(join(tmpdir(), 'pai-ck-'));
  const ckPath = join(dir, 'ck.json');
  const job = s.createJob({ jobType: 't' });
  const { attempt_id } = s.startAttempt({ jobId: job.job_id, writerId: 'w', workerType: 'p', workerIdentity: { pid: 1 } });
  writeFileSync(ckPath, JSON.stringify(validCkpt(job.job_id, attempt_id)));
  s.recordCheckpoint(job.job_id, attempt_id, ckPath);

  const respawned = [];
  const actions = s.recoveryTick({
    isWorkerAlive: () => false, // worker dead
    validateCheckpoint: () => ({ valid: true }),
    readCheckpoint: () => validCkpt(job.job_id, attempt_id),
    onRespawn: (j, newAttempt) => respawned.push(newAttempt),
  });
  assert.equal(actions[0].action_type, 'RESUME_ATTEMPT');
  assert.equal(s.getAttempts(job.job_id).length, 2); // attempt N+1
  assert.equal(respawned.length, 1);
  assert.equal(s.getJob(job.job_id).job_state, JobState.CHECKPOINTED);
});

test('recoveryTick: M103 bounded recovery — budget exhausted → REVIEW_REQUIRED, no infinite respawn', () => {
  const s = store();
  const dir = mkdtempSync(join(tmpdir(), 'pai-ck-'));
  const ckPath = join(dir, 'ck.json');
  const job = s.createJob({ jobType: 't' });
  const { attempt_id } = s.startAttempt({ jobId: job.job_id, writerId: 'w', workerType: 'p', workerIdentity: { pid: 1 } });
  writeFileSync(ckPath, JSON.stringify(validCkpt(job.job_id, attempt_id)));
  s.recordCheckpoint(job.job_id, attempt_id, ckPath);
  const tick = () => s.recoveryTick({
    isWorkerAlive: () => false,
    validateCheckpoint: () => ({ valid: true }),
    readCheckpoint: () => validCkpt(job.job_id, attempt_id),
    maxRecoveries: 3,
  });
  // a valid checkpoint may respawn at most maxRecoveries times across reboots
  assert.equal(tick()[0].action_type, 'RESUME_ATTEMPT');
  assert.equal(tick()[0].action_type, 'RESUME_ATTEMPT');
  assert.equal(tick()[0].action_type, 'RESUME_ATTEMPT');
  const fourth = tick()[0];
  assert.equal(fourth.action_type, 'REVIEW_REQUIRED');
  const j = s.getJob(job.job_id);
  assert.equal(j.job_state, JobState.WAITING_EVENT);
  assert.equal(j.validation_state, 'REVIEW_REQUIRED');
  assert.equal(j.recovery_count, 3);
  assert.equal(s.getAttempts(job.job_id).length, 4); // original + 3 recoveries — no 4th attempt
});

test('recoveryTick: dead worker + invalid checkpoint → WAITING_EVENT + REVIEW_REQUIRED, no blind restart', () => {
  const s = store();
  const job = s.createJob({ jobType: 't' });
  s.startAttempt({ jobId: job.job_id, writerId: 'w', workerType: 'p', workerIdentity: { pid: 1 } });
  const actions = s.recoveryTick({
    isWorkerAlive: () => false,
    validateCheckpoint: () => ({ valid: false, reason: 'corrupted' }),
    readCheckpoint: () => null,
  });
  assert.equal(actions[0].action_type, 'REVIEW_REQUIRED');
  const j = s.getJob(job.job_id);
  assert.equal(j.job_state, JobState.WAITING_EVENT);
  assert.equal(j.validation_state, 'REVIEW_REQUIRED');
  assert.equal(s.getAttempts(job.job_id).length, 1); // never blindly restarted
});

test('deleteJob: terminal-only hard delete removes all rows; live jobs refuse', () => {
  const s = store();
  const job = s.createJob({ jobType: 't' });
  s.startAttempt({ jobId: job.job_id, writerId: 'w', workerType: 'p', workerIdentity: { pid: 1 } });
  // live job refuses
  const live = s.deleteJob(job.job_id);
  assert.equal(live.ok, false);
  assert.match(live.error, /RUNNING|cancel/i);
  s.completeJob(job.job_id);
  const r = s.deleteJob(job.job_id);
  assert.equal(r.ok, true);
  assert.equal(s.getJob(job.job_id), null);
  assert.equal(s.getAttempts(job.job_id).length, 0);
  assert.equal(s.getEvents(job.job_id).length, 0);
  assert.equal(s.getLease(job.job_id), null);
  assert.equal(s.deleteJob('job-nope').ok, false);
});

test('multi-process posture: two handles on one file interleave writes without BUSY', () => {
  // Delegate children open the SAME instance store as the parent (the bridge
  // passes --instance through). Without WAL + busy_timeout a sibling's write
  // during an open read/write transaction fails instantly with SQLITE_BUSY.
  const p = join(mkdtempSync(join(tmpdir(), 'pai-jobs-mp-')), 'jobs.db');
  const a = new JobStore(p);
  const b = new JobStore(p); // second connection, same file — same lock path as a child process
  const ja = a.createJob({ jobType: 'parent' });
  const jb = b.createJob({ jobType: 'child' });
  // cross-visibility after each writer commits (WAL readers see siblings)
  assert.equal(a.getJob(jb.job_id)?.job_type, 'child');
  assert.equal(b.getJob(ja.job_id)?.job_type, 'parent');
  // interleaved state transitions from both handles
  a.startAttempt({ jobId: ja.job_id, writerId: 'wa', workerType: 'p', workerIdentity: { pid: 1 } });
  b.completeJob(jb.job_id);
  a.completeJob(ja.job_id);
  assert.equal(b.getJob(ja.job_id)?.job_state, 'COMPLETED');
  a.close(); b.close();
});

test('M5 parity: event payloads are secret-scrubbed before landing in the durable ledger', () => {
  const s = store();
  const key = `sk-${'a'.repeat(24)}`;
  const j = s.createJob({ jobType: 't' });
  s.failJob(j.job_id, `stderr leaked ${key}`);
  const evs = s.getEvents(j.job_id);
  const failed = evs.find((e) => e.event_type === 'JOB_FAILED');
  assert.ok(!failed.payload_json.includes(key), 'secret-shaped span must not reach the events table');
  assert.match(failed.payload_json, /\[REDACTED:openai_key\]/);
  s.close();
});
