/**
 * Durable job state machine — JS port of scripts/jobs/ (Python durable_jobs).
 *
 * Faithful port of the validated semantics:
 *  - Nine job states; orchestration_state NEVER auto-fails job_state
 *    (a worker that outlives its round limit is still alive — invariant)
 *  - Job-scoped single-writer lease, atomic under BEGIN IMMEDIATE
 *  - recoveryTick: idempotent, zero-LLM; dead worker + valid checkpoint →
 *    RESUME_ATTEMPT; dead worker + invalid/missing checkpoint → WAITING_EVENT
 *    + REVIEW_REQUIRED (never blindly restarts from scratch)
 *  - worker liveness and checkpoint validity are INJECTED — the store is a
 *    state machine, not an OS/process expert; pi supplies the probes
 *
 * Storage: node:sqlite, same five-table schema as the Python original so a
 * migrated db remains inspectable by either implementation.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const JobState = Object.freeze({
  PENDING: 'PENDING', READY: 'READY', RUNNING: 'RUNNING',
  CHECKPOINTED: 'CHECKPOINTED', WAITING_EVENT: 'WAITING_EVENT',
  RECOVERING: 'RECOVERING', COMPLETED: 'COMPLETED',
  FAILED: 'FAILED', CANCELLED: 'CANCELLED',
});
export const WorkerState = Object.freeze({
  STARTING: 'STARTING', ALIVE: 'ALIVE', HEARTBEAT_LOST: 'HEARTBEAT_LOST',
  EXITED_0: 'EXITED_0', EXITED_ERROR: 'EXITED_ERROR', KILLED: 'KILLED',
});
const TERMINAL_WORKER = new Set([WorkerState.EXITED_0, WorkerState.EXITED_ERROR, WorkerState.KILLED]);
const nowIso = () => new Date().toISOString();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY, job_type TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  job_state TEXT NOT NULL, orchestration_state TEXT NOT NULL,
  validation_state TEXT NOT NULL, current_attempt_id TEXT,
  authorized_root TEXT NOT NULL, checkpoint_ref TEXT,
  recovery_policy TEXT NOT NULL DEFAULT 'auto_resume_on_valid_checkpoint',
  created_by TEXT NOT NULL DEFAULT 'system', cancel_requested INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, writer_id TEXT NOT NULL,
  worker_type TEXT NOT NULL, worker_identity TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT, worker_state TEXT NOT NULL,
  exit_code INTEGER, workspace_ref TEXT, result_envelope_ref TEXT, checkpoint_ref TEXT
);
CREATE TABLE IF NOT EXISTS leases (
  job_id TEXT PRIMARY KEY, lease_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
  writer_id TEXT NOT NULL, acquired_at TEXT NOT NULL,
  expires_at REAL NOT NULL, last_renewed_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL,
  attempt_id TEXT, timestamp TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS validations (
  validation_id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL,
  attempt_id TEXT, validator_id TEXT NOT NULL, required_evidence_level TEXT NOT NULL,
  observed_evidence_level TEXT NOT NULL, result TEXT NOT NULL,
  evidence_refs TEXT NOT NULL, validated_at TEXT NOT NULL
);
`;

export class LeaseDeniedError extends Error {}

export class JobStore {
  /** @param {string} dbPath <instance>/jobs/durable_jobs.db */
  constructor(dbPath, { defaultTtl = 300 } = {}) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    this.defaultTtl = defaultTtl;
  }

  #tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  #event(jobId, attemptId, type, payload) {
    this.db.prepare(
      'INSERT INTO events (job_id, attempt_id, timestamp, event_type, payload_json) VALUES (?,?,?,?,?)',
    ).run(jobId, attemptId ?? null, nowIso(), type, JSON.stringify(payload ?? {}));
  }

  createJob({ jobType, authorizedRoot = '', createdBy = 'system', recoveryPolicy } = {}) {
    const jobId = `job-${randomUUID().slice(0, 12)}`;
    const t = nowIso();
    this.#tx(() => {
      this.db.prepare(
        `INSERT INTO jobs (job_id, job_type, created_at, updated_at, job_state, orchestration_state,
         validation_state, authorized_root, recovery_policy, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(jobId, jobType, t, t, JobState.PENDING, 'RUNNING', 'NOT_STARTED',
        authorizedRoot, recoveryPolicy ?? 'auto_resume_on_valid_checkpoint', createdBy);
      this.#event(jobId, null, 'JOB_CREATED', { job_type: jobType });
    });
    return this.getJob(jobId);
  }

  getJob(jobId) {
    return this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) ?? null;
  }

  listUnfinished() {
    return this.db.prepare(
      `SELECT * FROM jobs WHERE job_state NOT IN ('COMPLETED','FAILED','CANCELLED')`,
    ).all();
  }

  /** Newest-first job list for UI/channel consumers. */
  listRecent(limit = 20) {
    return this.db.prepare(
      'SELECT * FROM jobs ORDER BY created_at DESC, job_id DESC LIMIT ?',
    ).all(limit);
  }

  getAttempts(jobId) {
    return this.db.prepare('SELECT * FROM attempts WHERE job_id = ? ORDER BY started_at').all(jobId);
  }

  getLease(jobId) {
    return this.db.prepare('SELECT * FROM leases WHERE job_id = ?').get(jobId) ?? null;
  }

  /** Atomic single-writer lease acquisition (BEGIN IMMEDIATE). */
  acquireLease(jobId, attemptId, writerId, ttl, now = Date.now() / 1000) {
    const leaseId = `lease-${randomUUID().slice(0, 12)}`;
    const expires = now + (ttl ?? this.defaultTtl);
    return this.#tx(() => {
      const row = this.getLease(jobId);
      if (row && row.expires_at > now && row.writer_id !== writerId) {
        throw new LeaseDeniedError(
          `LEASE_DENIED: active lease held by '${row.writer_id}' until ${row.expires_at}`);
      }
      this.db.prepare(
        `INSERT OR REPLACE INTO leases (job_id, lease_id, attempt_id, writer_id, acquired_at, expires_at, last_renewed_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(jobId, leaseId, attemptId, writerId, nowIso(), expires, now);
      this.#event(jobId, attemptId, 'LEASE_ACQUIRED', { lease_id: leaseId, writer_id: writerId, expires_at: expires });
      return { job_id: jobId, lease_id: leaseId, attempt_id: attemptId, writer_id: writerId, expires_at: expires };
    });
  }

  renewLease(jobId, leaseId, ttl, now = Date.now() / 1000) {
    const expires = now + (ttl ?? this.defaultTtl);
    return this.#tx(() => {
      const row = this.getLease(jobId);
      if (!row || row.lease_id !== leaseId) {
        throw new LeaseDeniedError(`cannot renew: lease '${leaseId}' not found for job '${jobId}'`);
      }
      this.db.prepare(
        'UPDATE leases SET expires_at = ?, last_renewed_at = ? WHERE job_id = ? AND lease_id = ?',
      ).run(expires, now, jobId, leaseId);
      return { ...row, expires_at: expires };
    });
  }

  releaseLease(jobId, leaseId) {
    return this.#tx(() =>
      this.db.prepare('DELETE FROM leases WHERE job_id = ? AND lease_id = ?').run(jobId, leaseId).changes > 0);
  }

  revokeLease(jobId, reason = 'recovery_revocation') {
    return this.#tx(() => {
      const row = this.getLease(jobId);
      if (!row) return false;
      this.db.prepare('DELETE FROM leases WHERE job_id = ?').run(jobId);
      this.#event(jobId, row.attempt_id, 'LEASE_EXPIRED', { lease_id: row.lease_id, reason });
      return true;
    });
  }

  /** Start attempt N+1; lease acquisition is part of the same atomic step. */
  startAttempt({ jobId, writerId, workerType, workerIdentity = {}, workspaceRef = null, ttl, now }) {
    const job = this.getJob(jobId);
    if (!job) throw new Error(`job '${jobId}' not found`);
    if (job.job_state === JobState.COMPLETED) {
      throw new Error(`cannot start attempt: job '${jobId}' is already COMPLETED`);
    }
    const { c } = this.db.prepare('SELECT COUNT(*) AS c FROM attempts WHERE job_id = ?').get(jobId);
    const attemptId = `${jobId}_att_${c + 1}`;
    const lease = this.acquireLease(jobId, attemptId, writerId, ttl, now);
    this.#tx(() => {
      this.db.prepare(
        `INSERT INTO attempts (attempt_id, job_id, writer_id, worker_type, worker_identity, started_at, worker_state, workspace_ref)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(attemptId, jobId, writerId, workerType,
        JSON.stringify(workerIdentity), nowIso(), WorkerState.ALIVE, workspaceRef);
      this.db.prepare(
        'UPDATE jobs SET job_state = ?, orchestration_state = ?, current_attempt_id = ?, updated_at = ? WHERE job_id = ?',
      ).run(JobState.RUNNING, 'RUNNING', attemptId, nowIso(), jobId);
      this.#event(jobId, attemptId, 'ATTEMPT_STARTED', { attempt_id: attemptId, writer_id: writerId });
    });
    return { attempt_id: attemptId, lease };
  }

  /** Orchestration end NEVER auto-fails the job — invariant ported verbatim. */
  updateOrchestrationState(jobId, state) {
    this.db.prepare('UPDATE jobs SET orchestration_state = ?, updated_at = ? WHERE job_id = ?')
      .run(state, nowIso(), jobId);
  }

  updateWorkerState(attemptId, state, exitCode = null) {
    this.#tx(() => {
      this.db.prepare('UPDATE attempts SET worker_state = ?, exit_code = ?, ended_at = ? WHERE attempt_id = ?')
        .run(state, exitCode, TERMINAL_WORKER.has(state) ? nowIso() : null, attemptId);
      const row = this.db.prepare('SELECT job_id FROM attempts WHERE attempt_id = ?').get(attemptId);
      if (row) this.#event(row.job_id, attemptId, 'WORKER_EXITED', { worker_state: state, exit_code: exitCode });
    });
  }

  recordCheckpoint(jobId, attemptId, checkpointRef) {
    this.#tx(() => {
      this.db.prepare('UPDATE jobs SET checkpoint_ref = ?, job_state = ?, updated_at = ? WHERE job_id = ?')
        .run(checkpointRef, JobState.CHECKPOINTED, nowIso(), jobId);
      this.db.prepare('UPDATE attempts SET checkpoint_ref = ? WHERE attempt_id = ?').run(checkpointRef, attemptId);
      this.#event(jobId, attemptId, 'CHECKPOINT_WRITTEN', { checkpoint_ref: checkpointRef });
    });
  }

  recordResult(jobId, attemptId, envelopeRef) {
    this.#tx(() => {
      this.db.prepare('UPDATE attempts SET result_envelope_ref = ? WHERE attempt_id = ?').run(envelopeRef, attemptId);
      this.#event(jobId, attemptId, 'RESULT_RECEIVED', { result_envelope_ref: envelopeRef });
    });
  }

  recordValidation({ jobId, attemptId = null, validatorId, required, observed, result, evidenceRefs = [] }) {
    this.#tx(() => {
      this.db.prepare(
        `INSERT INTO validations (job_id, attempt_id, validator_id, required_evidence_level, observed_evidence_level, result, evidence_refs, validated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(jobId, attemptId, validatorId, required, observed, result, JSON.stringify(evidenceRefs), nowIso());
      this.db.prepare('UPDATE jobs SET validation_state = ?, updated_at = ? WHERE job_id = ?')
        .run(result, nowIso(), jobId);
      this.#event(jobId, attemptId, 'VALIDATION_COMPLETED', { result });
    });
  }

  completeJob(jobId) {
    this.#tx(() => {
      this.db.prepare('UPDATE jobs SET job_state = ?, updated_at = ? WHERE job_id = ?')
        .run(JobState.COMPLETED, nowIso(), jobId);
      this.#event(jobId, null, 'JOB_COMPLETED', {});
    });
  }

  failJob(jobId, reason) {
    this.#tx(() => {
      this.db.prepare('UPDATE jobs SET job_state = ?, updated_at = ? WHERE job_id = ?')
        .run(JobState.FAILED, nowIso(), jobId);
      this.#event(jobId, null, 'JOB_FAILED', { reason });
    });
  }

  cancelJob(jobId, reason = 'user_cancellation') {
    this.#tx(() => {
      this.db.prepare('UPDATE jobs SET job_state = ?, cancel_requested = 1, updated_at = ? WHERE job_id = ?')
        .run(JobState.CANCELLED, nowIso(), jobId);
      this.#event(jobId, null, 'JOB_CANCELLED', { reason });
    });
  }

  /**
   * Hard-delete a job record and all of its rows (attempts/events/validations/
   * lease). Terminal states only — a live job's worker would orphan, so the
   * caller must cancel first. Returns false for non-terminal jobs.
   */
  deleteJob(jobId) {
    const job = this.getJob(jobId);
    if (!job) return { ok: false, error: `job '${jobId}' not found` };
    if (![JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED].includes(job.job_state)) {
      return { ok: false, error: `job '${jobId}' is ${job.job_state} — cancel it first` };
    }
    return this.#tx(() => {
      for (const t of ['attempts', 'events', 'validations', 'leases']) {
        this.db.prepare(`DELETE FROM ${t} WHERE job_id = ?`).run(jobId);
      }
      this.db.prepare('DELETE FROM jobs WHERE job_id = ?').run(jobId);
      return { ok: true, job_id: jobId };
    });
  }

  getEvents(jobId) {
    return this.db.prepare('SELECT * FROM events WHERE job_id = ? ORDER BY event_id').all(jobId);
  }

  /**
   * Idempotent recovery sweep — ported from recovery_tick.py.
   * @param {(workerIdentity:object)=>boolean} isWorkerAlive  pi supplies PID probing
   * @param {(checkpoint:object)=>{valid:boolean,reason?:string}} validateCheckpoint
   * @param {(job,attempt,checkpoint)=>void} [onRespawn]
   */
  recoveryTick({ isWorkerAlive, validateCheckpoint, onRespawn, onAlive, now, readCheckpoint }) {
    const actions = [];
    for (const job of this.listUnfinished()) {
      if (job.job_state === JobState.WAITING_EVENT) {
        actions.push({ job_id: job.job_id, action_type: 'NO_ACTION', reason: 'waiting external event/review' });
        continue;
      }
      const attempt = job.current_attempt_id
        ? this.getAttempts(job.job_id).find((a) => a.attempt_id === job.current_attempt_id)
        : null;
      let alive = false;
      if (attempt?.worker_identity) {
        try { alive = isWorkerAlive(JSON.parse(attempt.worker_identity)); } catch { alive = false; }
      }
      if (alive) {
        // The worker outlived our process — the pi side may need to adopt its
        // workspace write lease (renew while the orphan lives, release when it
        // dies) or a new writer could take an expired lease under it.
        try { onAlive?.(job, attempt); } catch { /* adoption is best-effort; lease staleness still bounds it */ }
        actions.push({ job_id: job.job_id, action_type: 'NO_ACTION', reason: 'worker healthy — never spawn a duplicate' });
        continue;
      }
      // worker dead: checkpoint decides resume vs review — never blind-restart
      let checkpoint = null; let valid = false; let reason = 'no checkpoint recorded';
      if (job.checkpoint_ref && readCheckpoint) {
        try {
          checkpoint = readCheckpoint(job.checkpoint_ref);
          const v = validateCheckpoint(checkpoint);
          valid = v.valid; reason = v.reason ?? reason;
        } catch (e) { reason = `checkpoint corrupted: ${e.message}`; }
      }
      this.revokeLease(job.job_id, valid ? 'dead_worker_recovered' : 'dead_worker_invalid_checkpoint');
      if (valid && checkpoint) {
        const { attempt_id } = this.startAttempt({
          jobId: job.job_id,
          writerId: `recovered_worker_${process.pid}`,
          workerType: attempt?.worker_type ?? 'recovered_process',
          workerIdentity: { pid: process.pid, host: 'local', resumed: true },
          workspaceRef: attempt?.workspace_ref ?? null,
          ttl: undefined,
          now,
        });
        this.recordCheckpoint(job.job_id, attempt_id, job.checkpoint_ref);
        actions.push({
          job_id: job.job_id, action_type: 'RESUME_ATTEMPT',
          reason: 'dead worker recovered from valid machine checkpoint',
          details: { previous_attempt: job.current_attempt_id, resumed_attempt: attempt_id },
        });
        onRespawn?.(job, attempt_id, checkpoint);
      } else {
        this.#tx(() => {
          this.db.prepare('UPDATE jobs SET job_state = ?, validation_state = ? WHERE job_id = ?')
            .run(JobState.WAITING_EVENT, 'REVIEW_REQUIRED', job.job_id);
        });
        actions.push({
          job_id: job.job_id, action_type: 'REVIEW_REQUIRED',
          reason: `worker dead but checkpoint cannot resume deterministically: ${reason}`,
        });
      }
    }
    return actions;
  }

  close() { this.db.close(); }
}
