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

/** Command risk classes that write to the workspace — these need the mutex. */
const MUTATING_RISK = new Set(['mutating', 'destructive', 'exec', 'unknown']);

export class JobExecutor {
  /**
   * @param {import('../../host/src/core/jobs.js').JobStore} store
   * @param {string} jobsDir  <instance>/jobs — checkpoints + envelopes live here
   * @param {object} [deps]   {audit, runId, writeLease, classifier, budget} —
   *        writeLease + classifier close the foreground×background write race:
   *        a job whose command can mutate must hold the workspace write lease,
   *        and a second mutating job is refused while one is held.
   *        budget: child usage (PAI_USAGE) is billed into the spawning
   *        session's budget scope — delegated work cannot evade the parent cap.
   */
  constructor(store, jobsDir, { audit = null, runId = null, writeLease = null, classifier = null, budget = null } = {}) {
    this.store = store;
    this.jobsDir = jobsDir;
    this.audit = audit;
    this.runId = runId; // parent run identity — all job usage attributes here
    this.writeLease = writeLease;
    this.classifier = classifier;
    this.budget = budget;
    this.running = new Map(); // jobId → live child process (in-proc attempts only)
    mkdirSync(jobsDir, { recursive: true });
  }

  /**
   * User-facing detail projection: the DB record carries refs, the operator
   * wants the actual command and output — resolve checkpoint/result files.
   */
  describe(jobId) {
    const job = this.store.getJob(jobId);
    if (!job) return null;
    const attempts = this.store.getAttempts(jobId);
    const cur = attempts.find((a) => a.attempt_id === job.current_attempt_id) ?? attempts.at(-1) ?? null;
    let command = null; let outputTail = null; let exitCode = cur?.exit_code ?? null; let signal = null;
    const cpPath = cur?.checkpoint_ref ?? job.checkpoint_ref;
    if (cpPath && existsSync(cpPath)) {
      try {
        const cp = JSON.parse(readFileSync(cpPath, 'utf-8'));
        if (typeof cp.input_identity === 'string') command = cp.input_identity.replace(/^sha256:/, '');
      } catch { /* unreadable checkpoint → leave null */ }
    }
    const resPath = cur?.result_envelope_ref;
    if (resPath && existsSync(resPath)) {
      try {
        const r = JSON.parse(readFileSync(resPath, 'utf-8'));
        outputTail = r.output_tail ?? null;
        exitCode = r.exit_code ?? exitCode;
        signal = r.signal ?? null;
      } catch { /* unreadable envelope → leave null */ }
    }
    return {
      job, attempts: attempts.length, lease: this.store.getLease(jobId),
      command, output_tail: outputTail, exit_code: exitCode, signal,
      running: this.running.has(jobId),
      events: this.store.getEvents(jobId).slice(-10),
    };
  }

  /**
   * Operator cancel: flag the record (store authority) and kill the live
   * worker if this process spawned it. Workers from a dead parent are not
   * ours to kill — recovery decides their fate.
   */
  cancel(jobId, reason = 'user_cancellation') {
    const child = this.running.get(jobId);
    const killable = Boolean(child && child.exitCode == null && !child.killed);
    if (killable) child.kill();
    this.store.cancelJob(jobId, reason);
    this.audit?.write({ kind: 'JOB_CANCEL_REQUESTED', data: { job_id: jobId, reason, killed: killable, parent_run_id: this.runId } });
    return { cancelled: true, killed: killable };
  }

  /**
   * Convert a long-running shell command into a durable job and spawn it.
   * Returns {job_id, attempt_id} — caller blocks the sync call with this info —
   * or {refused:true, reason} when a mutating job can't take the workspace
   * write lease (another mutating job is running). Fail-closed on classify
   * errors: an unparseable mutating-capable command is treated as mutating.
   */
  async spawnCommandJob({ command, workdir, jobType = 'shell_command', authorizedRoot, budgetScope = null, budgetCommitted = false }) {
    let mutating = false;
    if (this.classifier) {
      try {
        const parsed = await this.classifier(command);
        mutating = MUTATING_RISK.has(parsed.risk) || parsed.hasUnknown === true || Boolean(parsed.parseError);
      } catch {
        mutating = true; // classifier failed on a job command → treat as mutating
      }
    }
    const job = this.store.createJob({ jobType, authorizedRoot: authorizedRoot ?? workdir, createdBy: 'pi-executor' });
    if (mutating && this.writeLease) {
      const acq = this.writeLease.acquire(`job:${job.job_id}`, { command: command.slice(0, 200) });
      if (!acq.ok) {
        const reason = `workspace write lease held by '${acq.heldBy.holder}' — mutating durable jobs run one at a time; retry when it finishes or the lease expires`;
        this.store.failJob(job.job_id, reason);
        this.audit?.write({ kind: 'JOB_REFUSED', data: { job_id: job.job_id, reason, heldBy: acq.heldBy.holder, parent_run_id: this.runId } });
        return { refused: true, reason, job_id: job.job_id };
      }
    }
    const { attempt_id } = this.store.startAttempt({
      jobId: job.job_id,
      writerId: `pi_exec_${process.pid}`,
      workerType: 'child_process',
      workerIdentity: {}, // filled after spawn with real pid
      workspaceRef: workdir,
    });
    this.executeAttempt(job.job_id, attempt_id, { command, workdir, mutating, budgetScope, budgetCommitted });
    return { job_id: job.job_id, attempt_id };
  }

  /** Run one attempt: spawn → checkpoint → heartbeat → exit → result envelope. */
  executeAttempt(jobId, attemptId, { command, workdir, resume = false, mutating = false, budgetScope = null, budgetCommitted = false }) {
    const checkpointPath = join(this.jobsDir, `${attemptId}.checkpoint.json`);
    const leaseHolder = `job:${jobId}`;
    const resultPath = join(this.jobsDir, `${attemptId}.result.json`);
    const job = this.store.getJob(jobId);
    // shell:true — Node quotes for cmd.exe/sh correctly; the tracked worker
    // pid is the shell, which waits on its children
    const child = spawn(command, { cwd: workdir, windowsHide: true, shell: true });
    this.running.set(jobId, child);

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
      mutating, // recovery needs to know whether this attempt held the write lease
      budget_scope: budgetScope, // child usage bills to the spawning scope
      budget_committed: budgetCommitted, // true = slice pre-charged to parent at admission; exit must not double-bill
    }, null, 2));
    this.store.recordCheckpoint(jobId, attemptId, checkpointPath);

    // worker identity now knows the real pid
    this.store.db.prepare('UPDATE attempts SET worker_identity = ? WHERE attempt_id = ?')
      .run(JSON.stringify({ pid: child.pid, host: 'local', resumed: resume }), attemptId);

    // heartbeat: renew the job lease AND the workspace write lease while the
    // worker lives — both die with the worker (expiry or dead pid)
    const heartbeat = setInterval(() => {
      const lease = this.store.getLease(jobId);
      if (!lease) return;
      try { this.store.renewLease(jobId, lease.lease_id); } catch { /* lost lease — process exits anyway */ }
      if (mutating) this.writeLease?.renew(leaseHolder);
    }, Math.max(5_000, this.store.defaultTtl * 333));
    heartbeat.unref();

    let out = '';
    child.stdout?.on('data', (d) => { out += d; if (out.length > 8192) out = out.slice(-8192); });
    child.stderr?.on('data', (d) => { out += d; if (out.length > 8192) out = out.slice(-8192); });

    child.on('exit', (code, signal) => {
      this.running.delete(jobId);
      clearInterval(heartbeat);
      if (mutating) this.writeLease?.release(leaseHolder);
      // If the store is closed (host shutting down) the exit is recorded by
      // the NEXT boot's recoveryTick — durable semantics, not a swallowed error.
      try {
        const state = code === 0 ? 'EXITED_0' : signal ? 'KILLED' : 'EXITED_ERROR';
        this.store.updateWorkerState(attemptId, state, code);
        // Usage attribution: a delegated worker may report its real token/cost
        // usage by printing `PAI_USAGE {json}` on stdout; whatever it reports is
        // recorded under parent_run_id so delegated work bills to the parent
        // run (Hermes pattern). Absent the marker, usage stays null — honest.
        const usageMatch = out.match(/PAI_USAGE (\{[^\n]*\})/);
        let usage = null;
        try { usage = usageMatch ? JSON.parse(usageMatch[1]) : null; } catch { usage = null; }
        // child spend bills into the spawning session's budget scope — a
        // delegated/subagent job cannot evade the parent's cap. No scope at
        // spawn (detached/recovered origin) bills under its own job scope.
        // budget_committed attempts were pre-charged the whole slice at
        // admission — billing again here would double-count the same spend.
        if (usage && this.budget && !budgetCommitted) {
          try {
            // countCall defaults true: the worker is a separate process, its
            // requests never pass our fetch gate — the usage envelope is the
            // only place its calls can be counted (documented undercount: one
            // envelope may cover multiple internal provider requests)
            this.budget.record({ scope: budgetScope ?? `job:${jobId}`, source: `job:${jobId}`, usage });
          } catch { /* ledger failure must not corrupt job bookkeeping */ }
        }
        writeFileSync(resultPath, JSON.stringify({
          attempt_id: attemptId, job_id: jobId,
          exit_code: code, signal,
          output_tail: out,
          usage,
          parent_run_id: this.runId, // usage attribution: child work bills to parent
          finished_at: new Date().toISOString(),
        }, null, 2));
        this.store.recordResult(jobId, attemptId, resultPath);
        this.store.releaseLease(jobId, this.store.getLease(jobId)?.lease_id);
        if (code === 0) this.store.completeJob(jobId);
        else this.store.failJob(jobId, `exit ${code ?? signal}`);
        this.audit?.write({
          kind: 'JOB_FINISHED',
          data: { job_id: jobId, attempt_id: attemptId, exit_code: code, usage, parent_run_id: this.runId },
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
        // resume = respawn the command under the new attempt. A recovered job
        // conservatively re-takes the workspace write lease — if another
        // mutating job holds it, this attempt stays parked rather than racing.
        const cmd = typeof checkpoint.input_identity === 'string'
          ? checkpoint.input_identity.replace(/^sha256:/, '') : null;
        if (!cmd) return;
        const leaseHolder = `job:${job.job_id}`;
        if (this.writeLease) {
          const acq = this.writeLease.acquire(leaseHolder, { attemptId, resumed: true });
          if (!acq.ok) {
            this.audit?.write({
              kind: 'JOB_PARKED',
              data: { job_id: job.job_id, attempt_id: attemptId, reason: `workspace write lease held by '${acq.heldBy.holder}'`, parent_run_id: this.runId },
            });
            return;
          }
        }
        this.executeAttempt(job.job_id, attemptId, {
          command: cmd,
          workdir: workdir ?? job.authorized_root,
          resume: true,
          mutating: true,
          budgetScope: checkpoint?.budget_scope ?? null,
          budgetCommitted: checkpoint?.budget_committed === true,
        });
        this.audit?.write({
          kind: 'JOB_RECOVERED',
          data: { job_id: job.job_id, attempt_id: attemptId, parent_run_id: this.runId },
        });
      },
      // Crash sentinel: the Pi/host parent died but the worker shell lives.
      // Its workspace lease record names `job:<id>` and carries the WORKER pid
      // (still alive) — so the lease is live but its TTL will expire without
      // renewal. Adopt it: renew while the orphan lives, release when it dies.
      // If the lease was already taken by another holder, the orphan writes
      // unguarded — fail closed: kill it and park the job for review.
      onAlive: (job, attempt) => {
        if (!this.writeLease) return;
        const holder = `job:${job.job_id}`;
        let workerPid = null;
        try { workerPid = JSON.parse(attempt.worker_identity)?.pid ?? null; } catch { /* fallthrough */ }
        // was this job mutating? the checkpoint remembers (missing field on
        // pre-lease-era jobs → conservative: treat as mutating)
        let mutating = true;
        try {
          const cp = job.checkpoint_ref && existsSync(job.checkpoint_ref)
            ? readCheckpoint(job.checkpoint_ref) : null;
          if (cp && cp.mutating === false) mutating = false;
        } catch { /* keep conservative default */ }
        if (!mutating) return;

        const cur = this.writeLease.held();
        if (!cur || cur.holder !== holder) {
          // lease lost or stolen while the orphan still writes — kill it
          try { if (workerPid) process.kill(workerPid); } catch { /* already gone */ }
          this.audit?.write({
            kind: 'JOB_ORPHAN_KILLED',
            data: { job_id: job.job_id, reason: 'workspace lease lost while orphan worker alive — killed to prevent unguarded writes', stolenBy: cur?.holder ?? null, parent_run_id: this.runId },
          });
          return;
        }
        // adopt: renew on a watchdog until the worker exits, then release
        this.writeLease.renew(holder);
        const watchdog = setInterval(() => {
          let alive = false;
          try { if (workerPid) { process.kill(workerPid, 0); alive = true; } } catch (e) { alive = e.code === 'EPERM'; }
          if (!alive) {
            clearInterval(watchdog);
            this.writeLease.release(holder);
            return;
          }
          this.writeLease.renew(holder);
        }, Math.max(5_000, Math.floor(this.writeLease.ttlMs / 3)));
        watchdog.unref();
        this.audit?.write({
          kind: 'JOB_LEASE_ADOPTED',
          data: { job_id: job.job_id, worker_pid: workerPid, parent_run_id: this.runId },
        });
      },
    });
  }
}
