/**
 * Pi-side durable job executor — the body that actually runs attempts.
 *
 * host JobStore is the state machine (harness-neutral, zero-dep); THIS module
 * supplies what the store deliberately doesn't know: process spawning, PID
 * liveness, heartbeat lease renewal, machine-checkpoint IO, result envelopes.
 *
 * Long-command job-ification (Devin/Crush pattern): a shell command the
 * classifier flags as long-running is converted into a durable job — the sync
 * tool call is blocked with an actionable reason naming the spawned job id,
 * and the job continues across process restarts via recoveryTick.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** PID liveness probe — the injected worker-alive check for recoveryTick. */
export function isWorkerAlive(identity) {
  const pid = identity?.pid;
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but not ours
  }
}

export function readCheckpoint(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/** Machine-checkpoint validity — shape + algorithm version, mirrors Python. */
export function validateCheckpoint(cp) {
  if (!cp || typeof cp !== 'object') return { valid: false, reason: 'not an object' };
  if (cp.algorithm_version !== '1.0.0') return { valid: false, reason: `algorithm_version ${cp.algorithm_version}` };
  if (!cp.job_id || !cp.attempt_id) return { valid: false, reason: 'missing job/attempt identity' };
  if (!cp.authorized_root) return { valid: false, reason: 'missing authorized_root' };
  return { valid: true };
}

/** Commands that should never run synchronously — convert to durable jobs. */
const LONG_RUN = /(^|\s)(npm\s+(run\s+)?(dev|start|serve|watch)|vite|next\s+dev|pytest\s+--watch|tail\s+-f|watch\s|serve\b|docker\s+run(?!.*--rm)|sleep\s+\d{3,})/i;

export function isLongRunningCommand(command) {
  return typeof command === 'string' && LONG_RUN.test(command);
}

export class JobExecutor {
  /**
   * @param {import('../../host/src/core/jobs.js').JobStore} store
   * @param {string} jobsDir  <instance>/jobs — checkpoints + envelopes live here
   * @param {object} [deps]   {audit, runId} for provenance attribution
   */
  constructor(store, jobsDir, { audit = null, runId = null } = {}) {
    this.store = store;
    this.jobsDir = jobsDir;
    this.audit = audit;
    this.runId = runId; // parent run identity — all job usage attributes here
    mkdirSync(jobsDir, { recursive: true });
  }

  /**
   * Convert a long-running shell command into a durable job and spawn it.
   * Returns {job_id, attempt_id} — caller blocks the sync call with this info.
   */
  spawnCommandJob({ command, workdir, jobType = 'shell_command', authorizedRoot }) {
    const job = this.store.createJob({ jobType, authorizedRoot: authorizedRoot ?? workdir, createdBy: 'pi-executor' });
    const { attempt_id } = this.store.startAttempt({
      jobId: job.job_id,
      writerId: `pi_exec_${process.pid}`,
      workerType: 'child_process',
      workerIdentity: {}, // filled after spawn with real pid
      workspaceRef: workdir,
    });
    this.executeAttempt(job.job_id, attempt_id, { command, workdir });
    return { job_id: job.job_id, attempt_id };
  }

  /** Run one attempt: spawn → checkpoint → heartbeat → exit → result envelope. */
  executeAttempt(jobId, attemptId, { command, workdir, resume = false }) {
    const checkpointPath = join(this.jobsDir, `${attemptId}.checkpoint.json`);
    const resultPath = join(this.jobsDir, `${attemptId}.result.json`);
    const job = this.store.getJob(jobId);
    // shell:true — Node quotes for cmd.exe/sh correctly; the tracked worker
    // pid is the shell, which waits on its children
    const child = spawn(command, { cwd: workdir, windowsHide: true, shell: true });

    // machine checkpoint — the resumability contract
    writeFileSync(checkpointPath, JSON.stringify({
      checkpoint_version: 1,
      job_id: jobId,
      attempt_id: attemptId,
      input_identity: `sha256:${command}`,
      source_hashes: {},
      cursor: resume ? 'resumed' : 0,
      partition: 0,
      manifest_position: 0,
      output_identity: '',
      output_hashes: {},
      authorized_root: job?.authorized_root ?? workdir,
      algorithm_version: '1.0.0',
      next_operation: 'await_exit',
      created_at: new Date().toISOString(),
      pid: child.pid,
      parent_run_id: this.runId,
    }, null, 2));
    this.store.recordCheckpoint(jobId, attemptId, checkpointPath);

    // worker identity now knows the real pid
    this.store.db.prepare('UPDATE attempts SET worker_identity = ? WHERE attempt_id = ?')
      .run(JSON.stringify({ pid: child.pid, host: 'local', resumed: resume }), attemptId);

    // heartbeat: renew the lease while the worker lives
    const heartbeat = setInterval(() => {
      const lease = this.store.getLease(jobId);
      if (!lease) return;
      try { this.store.renewLease(jobId, lease.lease_id); } catch { /* lost lease — process exits anyway */ }
    }, Math.max(5_000, this.store.defaultTtl * 333));
    heartbeat.unref();

    let out = '';
    child.stdout?.on('data', (d) => { out += d; if (out.length > 8192) out = out.slice(-8192); });
    child.stderr?.on('data', (d) => { out += d; if (out.length > 8192) out = out.slice(-8192); });

    child.on('exit', (code, signal) => {
      clearInterval(heartbeat);
      // If the store is closed (host shutting down) the exit is recorded by
      // the NEXT boot's recoveryTick — durable semantics, not a swallowed error.
      try {
        const state = code === 0 ? 'EXITED_0' : signal ? 'KILLED' : 'EXITED_ERROR';
        this.store.updateWorkerState(attemptId, state, code);
        writeFileSync(resultPath, JSON.stringify({
          attempt_id: attemptId, job_id: jobId,
          exit_code: code, signal,
          output_tail: out,
          parent_run_id: this.runId, // usage attribution: child work bills to parent
          finished_at: new Date().toISOString(),
        }, null, 2));
        this.store.recordResult(jobId, attemptId, resultPath);
        this.store.releaseLease(jobId, this.store.getLease(jobId)?.lease_id);
        if (code === 0) this.store.completeJob(jobId);
        else this.store.failJob(jobId, `exit ${code ?? signal}`);
        this.audit?.write({
          kind: 'JOB_FINISHED',
          data: { job_id: jobId, attempt_id: attemptId, exit_code: code, parent_run_id: this.runId },
        });
      } catch (e) {
        if (!/not open|closed/i.test(e.message)) throw e;
      }
    });
    return child;
  }

  /** Cold-start recovery: sweep unfinished jobs, respawn dead workers. */
  recover({ workdir } = {}) {
    return this.store.recoveryTick({
      isWorkerAlive,
      validateCheckpoint,
      readCheckpoint: (p) => (existsSync(p) ? readCheckpoint(p) : null),
      onRespawn: (job, attemptId, checkpoint) => {
        // resume = respawn the command under the new attempt
        const cmd = typeof checkpoint.input_identity === 'string'
          ? checkpoint.input_identity.replace(/^sha256:/, '') : null;
        if (cmd) {
          this.executeAttempt(job.job_id, attemptId, { command: cmd, workdir: workdir ?? job.authorized_root, resume: true });
        }
        this.audit?.write({
          kind: 'JOB_RECOVERED',
          data: { job_id: job.job_id, attempt_id: attemptId, parent_run_id: this.runId },
        });
      },
    });
  }
}
