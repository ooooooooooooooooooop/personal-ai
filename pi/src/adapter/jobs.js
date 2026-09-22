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
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets } from '../../../host/src/core/secrets.js';
import { SandboxProvider, SandboxUnavailableError } from '../../../host/src/core/sandbox.js';

/**
 * Crash-safe artifact write: tmp + rename (same discipline as host
 * prediction.js #persist). Checkpoints, result envelopes, and queue specs are
 * read back by recovery/restart/pump code whose only torn-write defence is
 * "degrade to REVIEW_REQUIRED / fail the job" — a single unlucky crash window
 * must not cost a job its resumability or fail a queued job that never ran.
 */
function writeJsonAtomic(path, obj) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}

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
   *        sandbox: SandboxProvider — wraps the spawned command (none|wsl);
   *        covers the durable-job surface only — foreground tool calls execute
   *        inside the body's own process and are NOT sandboxed by v1.
   */
  constructor(store, jobsDir, { audit = null, runId = null, writeLease = null, classifier = null, budget = null, sandbox = null, onJobFinished = null, sandboxExcludes = null, preflightCommand = null, envOverlay = null } = {}) {
    this.store = store;
    this.jobsDir = jobsDir;
    this.audit = audit;
    this.runId = runId; // parent run identity — all job usage attributes here
    this.writeLease = writeLease;
    this.classifier = classifier;
    this.budget = budget;
    this.sandbox = sandbox;
    this.onJobFinished = onJobFinished; // M14: scheduled-job completion delivery
    // M80 sandbox exclusions — () => string[] of command prefixes that bypass
    // the AMBIENT sandbox only (an explicit per-job sandbox request stands).
    this.sandboxExcludes = sandboxExcludes;
    // M90-R2: restart re-runs CURRENT hard policy on the persisted replay
    // spec — (spec) => Promise<decision|undefined>; .block refuses.
    this.preflightCommand = preflightCommand;
    // M121: () => plain-object session env overlay — consulted per spawn so
    // env_set edits reach the next child without rebuilding the executor.
    this.envOverlay = envOverlay;
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
    let restartSpec = null;
    const cpPath = cur?.checkpoint_ref ?? job.checkpoint_ref;
    if (cpPath && existsSync(cpPath)) {
      try {
        const cp = JSON.parse(readFileSync(cpPath, 'utf-8'));
        if (typeof cp.input_identity === 'string') command = cp.input_identity.replace(/^sha256:/, '');
        restartSpec = cp.restart_spec ?? null;
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
      restart_spec: restartSpec,
      running: this.running.has(jobId),
      // dependency chains: what this job waits on / what cleared it
      depends_on: this.store.dependencyState(job),
      queued: !job.current_attempt_id && this.store.depsOf(job).length > 0,
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
    if (killable) {
      // shell:true means the tracked pid is the cmd.exe wrapper — killing it
      // alone orphans the real command. taskkill /T takes the whole tree.
      if (process.platform === 'win32') {
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
        catch { child.kill(); }
      } else child.kill();
    }
    this.store.cancelJob(jobId, reason);
    this.audit?.write({ kind: 'JOB_CANCEL_REQUESTED', data: { job_id: jobId, reason, killed: killable, parent_run_id: this.runId } });
    // a cancelled dep cascades to its queued dependents
    this.#pumpDependents().catch(() => { /* best-effort */ });
    return { cancelled: true, killed: killable };
  }

  /**
   * M90/M92 restart: re-spawn a TERMINAL job's command as a fresh job. The
   * new attempt is a new job_id (lineage is in audit, not state reuse) —
   * resurrecting a terminal row would falsify its history.
   */
  async restart(jobId) {
    const detail = this.describe(jobId);
    if (!detail) return { refused: true, reason: `job '${jobId}' not found` };
    const state = detail.job.job_state;
    if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(state)) {
      return { refused: true, reason: `job '${jobId}' is ${state} — only terminal jobs restart` };
    }
    if (!detail.restart_spec) {
      return { refused: true, reason: `job '${jobId}' has no restart spec — its execution contract (worktree/sandbox/timeout/budget) cannot be faithfully rebuilt; spawn a fresh job instead` };
    }
    const spec = detail.restart_spec;
    if (spec.budget_committed) {
      // a pre-charged delegation slice cannot be re-admitted by restart —
      // re-running it would reuse the old child cap without a fresh parent
      // reservation. The operator must delegate again.
      return { refused: true, reason: `job '${jobId}' ran on a committed budget slice — restart cannot re-admit it; delegate again` };
    }
    // M90-R2: restart replays a PERSISTED contract — it must clear today's
    // hard policy, not the policy that admitted the original run (policy may
    // have tightened since). The gate sees the WHOLE replay spec, not just
    // the command: protected-root scanning recurses into sandbox.target /
    // workdir, and operator pre_tool hooks receive the full arg set — same
    // governance input a fresh job_spawn call would carry. The operator's
    // restart click is the ask-level approval; deny/terminate/drift/
    // unparseable refuse outright.
    const gate = await this.preflightCommand?.(spec);
    if (gate?.block) {
      this.audit?.write({ kind: 'JOB_RESTART_REFUSED', data: { job_id: jobId, rule: gate.rule, reason: gate.reason, parent_run_id: this.runId } });
      return { refused: true, reason: `restart refused by current policy (${gate.rule}): ${gate.reason}` };
    }
    const r = await this.spawnCommandJob({
      command: spec.command,
      workdir: spec.workdir,          // base dir — a fresh worktree is built when spec.worktree
      jobType: spec.job_type ?? detail.job.job_type,
      authorizedRoot: spec.authorized_root ?? spec.workdir,
      timeoutMs: spec.timeout_ms ?? null,
      worktree: spec.worktree === true,
      sandbox: spec.sandbox ?? null,
      budgetScope: spec.budget_scope ?? null,
    });
    if (!r.refused) {
      this.audit?.write({ kind: 'JOB_RESTARTED', data: { from_job: jobId, to_job: r.job_id, command: spec.command.slice(0, 200), parent_run_id: this.runId } });
    }
    return r;
  }

  /** M90/M92 delete: terminal jobs only; removes the DB rows + artifacts. */
  remove(jobId) {
    const detail = this.describe(jobId);
    if (!detail) return { ok: false, error: `job '${jobId}' not found` };
    const r = this.store.deleteJob(jobId);
    if (!r.ok) return r;
    // artifacts (checkpoint/result envelopes) live in jobsDir under the
    // attempt prefix — sweep them so delete is real, not a dangling file set
    const removedFiles = [];
    try {
      for (const f of readdirSync(this.jobsDir)) {
        if (f.startsWith(`${jobId}_att_`) || f.startsWith(`${jobId}.`)) {
          try { rmSync(join(this.jobsDir, f), { force: true }); removedFiles.push(f); } catch { /* locked — record anyway */ }
        }
      }
    } catch { /* jobsDir unreadable */ }
    this.audit?.write({ kind: 'JOB_DELETED', data: { job_id: jobId, artifacts: removedFiles.length, parent_run_id: this.runId } });
    return { ok: true, job_id: jobId, artifacts_removed: removedFiles.length };
  }

  /**
   * Convert a long-running shell command into a durable job and spawn it.
   * Returns {job_id, attempt_id} — caller blocks the sync call with this info —
   * or {refused:true, reason} when a mutating job can't take the workspace
   * write lease (another mutating job is running). Fail-closed on classify
   * errors: an unparseable mutating-capable command is treated as mutating.
   *
   * dependsOn: array of job_ids that must ALL reach COMPLETED before this job
   * starts. Unsatisfied deps → the job is created as a durable QUEUED record
   * ({job_id, queued:true, waiting_on}) plus a persisted queue spec; the dep
   * pump (#pumpDependents) promotes it onto the SAME job id when the chain
   * clears, and cascade-cancels it when any dep fails. Edges point only at
   * pre-existing jobs, so the graph is a DAG by construction.
   */
  async spawnCommandJob({ command, workdir, jobType = 'shell_command', authorizedRoot, budgetScope = null, budgetCommitted = false, timeoutMs = null, worktree = false, sandbox = null, dependsOn = null }) {
    if (dependsOn != null) {
      const v = this.#validateDeps(dependsOn);
      if (v.error) return { refused: true, reason: v.error };
      if (v.unsatisfied) {
        // Queue BEFORE any side effect (no sandbox resolution, no worktree,
        // no lease) — a waiting job must hold nothing it cannot release.
        // Validate the sandbox kind now: an unknown backend must refuse at
        // admission, not queue and die at promotion days later.
        if (sandbox != null && sandbox !== false && sandbox !== 'none') {
          const kind = typeof sandbox === 'object' ? (sandbox.kind ?? 'none') : String(sandbox);
          if (!['none', 'wsl', 'docker', 'ssh'].includes(kind)) {
            return { refused: true, reason: `unknown sandbox backend '${kind}' — expected none|wsl|docker|ssh` };
          }
        }
        const job = this.store.createJob({
          jobType, authorizedRoot: authorizedRoot ?? workdir, createdBy: 'pi-executor', dependsOn: v.deps,
        });
        const spec = { command, workdir, jobType, authorizedRoot, budgetScope, budgetCommitted, timeoutMs, worktree, sandbox };
        try {
          writeJsonAtomic(this.#queueSpecPath(job.job_id), spec);
        } catch (e) {
          this.store.failJob(job.job_id, `queue spec could not be persisted: ${e.message}`);
          return { refused: true, reason: `depends_on: queue spec write failed (${e.message})`, job_id: job.job_id };
        }
        this.audit?.write({ kind: 'JOB_QUEUED_DEPS', data: { job_id: job.job_id, waiting_on: v.waitingOn, command: command.slice(0, 200), parent_run_id: this.runId } });
        return { job_id: job.job_id, attempt_id: null, queued: true, waiting_on: v.waitingOn };
      }
      // satisfied at birth — record the lineage on the row and run immediately
      return this.#launch(null, { command, workdir, jobType, authorizedRoot, budgetScope, budgetCommitted, timeoutMs, worktree, sandbox, dependsOn: v.deps });
    }
    return this.#launch(null, { command, workdir, jobType, authorizedRoot, budgetScope, budgetCommitted, timeoutMs, worktree, sandbox, dependsOn: [] });
  }

  #queueSpecPath(jobId) { return join(this.jobsDir, `${jobId}.queued.json`); }

  /**
   * Validate a dependency list against the store. Unknown deps refuse (they
   * can never complete); already-dead deps refuse at admission (fail fast
   * beats queue-then-cascade); COMPLETED deps satisfy immediately.
   */
  #validateDeps(dependsOn) {
    if (!Array.isArray(dependsOn)) return { error: 'depends_on must be an array of job ids' };
    const deps = [...new Set(dependsOn.map((d) => String(d ?? '').trim()).filter(Boolean))];
    if (!deps.length) return { deps: [], unsatisfied: false, waitingOn: [] };
    if (deps.length > 16) return { error: `depends_on: too many dependencies (${deps.length} > 16)` };
    const waitingOn = [];
    for (const d of deps) {
      const row = this.store.getJob(d);
      if (!row) return { error: `depends_on: unknown job '${d}' — a dependency that does not exist can never complete` };
      if (row.job_state === 'FAILED' || row.job_state === 'CANCELLED') {
        return { error: `depends_on: job '${d}' is ${row.job_state} — a chain on a dead job can never run` };
      }
      if (row.job_state !== 'COMPLETED') waitingOn.push(d);
    }
    return { deps, unsatisfied: waitingOn.length > 0, waitingOn };
  }

  /**
   * Dependency pump — promote queued jobs whose deps all COMPLETED, cascade-
   * cancel those with a dead dep. Called on every terminal transition this
   * process observes (exit handler, cancel), at the end of cold-start
   * recovery, and when an adopted orphan worker dies. Idempotent.
   */
  async #pumpDependents() {
    let queued;
    try { queued = this.store.listDepQueued(); } catch { return; } // store closed
    for (const job of queued) {
      const st = this.store.dependencyState(job);
      if (!st) continue;
      if (st.failed.length) {
        // cascade honestly: the dependent never ran → CANCELLED naming the
        // dead deps, never FAILED (nothing executed to fail).
        this.store.cancelJob(job.job_id, `dependency_failed:${st.failed.join(',')}`);
        try { rmSync(this.#queueSpecPath(job.job_id), { force: true }); } catch { /* sweep is best-effort */ }
        this.audit?.write({ kind: 'JOB_DEP_FAILED', data: { job_id: job.job_id, failed_deps: st.failed, parent_run_id: this.runId } });
        continue;
      }
      if (!st.satisfied) continue; // still waiting
      let spec = null;
      try {
        spec = JSON.parse(readFileSync(this.#queueSpecPath(job.job_id), 'utf-8'));
      } catch (e) {
        this.store.failJob(job.job_id, `queue spec unreadable: ${e.message}`);
        this.audit?.write({ kind: 'JOB_DEP_FAILED', data: { job_id: job.job_id, reason: 'queue_spec_unreadable', parent_run_id: this.runId } });
        continue;
      }
      this.audit?.write({ kind: 'JOB_DEP_PROMOTED', data: { job_id: job.job_id, deps: st.deps, parent_run_id: this.runId } });
      // Promotion launches on the EXISTING job record — the id the model and
      // the operator already poll — replaying the persisted spawn contract.
      const r = await this.#launch(job, spec);
      if (r?.refused && r.leaseHeld) {
        // park: keep the queue spec so a later pump (when the lease holder
        // finishes) retries — the deps stay satisfied, the slot is just busy.
        this.audit?.write({ kind: 'JOB_PARKED', data: { job_id: job.job_id, reason: r.reason, parent_run_id: this.runId } });
      } else if (r?.refused) {
        this.store.failJob(job.job_id, r.reason);
        this.audit?.write({ kind: 'JOB_DEP_FAILED', data: { job_id: job.job_id, reason: r.reason, parent_run_id: this.runId } });
        try { rmSync(this.#queueSpecPath(job.job_id), { force: true }); } catch { /* best-effort */ }
      } else {
        try { rmSync(this.#queueSpecPath(job.job_id), { force: true }); } catch { /* best-effort */ }
      }
    }
  }

  /** The launch half of spawnCommandJob — promotedJob null creates the record. */
  async #launch(promotedJob, { command, workdir, jobType = 'shell_command', authorizedRoot, budgetScope = null, budgetCommitted = false, timeoutMs = null, worktree = false, sandbox = null, dependsOn = [] }) {
    // Remote execution (P1, web-review GO): a per-job sandbox selector
    // overrides the global PAI_SANDBOX backend — 'wsl'/'docker'/'ssh' run the
    // command off the host shell entirely. Unknown kinds refuse BEFORE the
    // job record exists; an unavailable backend fails the attempt honestly.
    let sandboxProvider = this.sandbox;
    if (sandbox != null && sandbox !== false && sandbox !== 'none') {
      const kind = typeof sandbox === 'object' ? (sandbox.kind ?? 'none') : String(sandbox);
      if (!['none', 'wsl', 'docker', 'ssh'].includes(kind)) {
        return { refused: true, reason: `unknown sandbox backend '${kind}' — expected none|wsl|docker|ssh` };
      }
      // 'none' object = restart replaying an explicitly-unsandboxed contract —
      // `false` sentinel so executeAttempt does NOT fall back to a possibly-
      // changed ambient PAI_SANDBOX.
      sandboxProvider = kind === 'none' ? false : new SandboxProvider(kind, typeof sandbox === 'object' ? sandbox : {});
    } else if (sandboxProvider?.kind && sandboxProvider.kind !== 'none' && this.sandboxExcludes) {
      // M80 command-level exclusion: an operator-listed prefix (e.g. a VCS
      // binary that needs the real filesystem) runs unsandboxed — audited so
      // the bypass is visible, and an explicit per-job sandbox still wins.
      // Compound-command guard: exclusion applies only to a SINGLE simple
      // command unit — `git status && rm -rf x` must not escape the sandbox
      // just because it starts with an excluded prefix (the exact bypass the
      // upstream excludedCommands feature was bitten by).
      const prefixes = this.sandboxExcludes() ?? [];
      let simple = null;
      let clean = false;
      if (this.classifier) {
        try {
          const parsed = await this.classifier(command);
          // exclusion only when the WHOLE string is one verifiable unit:
          // no parse errors, no redirects/write-targets, no danger-env
          // prefixes — `git status > out` must stay sandboxed.
          clean = parsed && !parsed.parseError && !parsed.writeTargets?.length && !parsed.dangerEnv?.length;
          if (clean && parsed.units?.length === 1) simple = parsed.units[0];
        } catch { simple = null; clean = false; }
      }
      const allowed =
        clean && simple && simple.context === 'top' && !simple.hasExpansion &&
        !simple.hasEnvAssignment && // `GIT_SSH_COMMAND=x git …` must not ride the exclusion — env can redirect the executable itself
        // the unit's raw text must BE the whole command — any surviving shell
        // syntax (input redirect, trailing &, comments, stray separators)
        // lives outside the command node's text and fails this equality.
        simple.raw.trim() === command.trim() &&
        // prefix semantics are literal: the COMMAND STRING starts with the
        // excluded prefix — no rawName matching (that would let env-prefixed
        // invocations slip through).
        prefixes.some((p) => simple.raw.trim() === p || simple.raw.trim().startsWith(`${p} `));
      if (allowed) {
        sandboxProvider = false; // explicit-bypass sentinel — executeAttempt must not fall back to ambient
        this.audit?.write({ kind: 'SANDBOX_EXCLUDED', data: { command: command.slice(0, 200), parent_run_id: this.runId } });
      }
    }
    // M13 (Codex/Cline worktree-parallel analogue, opt-in): run the attempt in
    // a detached `git worktree` so parallel mutating jobs can't collide on the
    // real checkout. Clean worktrees are removed at exit; dirty ones are LEFT
    // in place (removing would silently delete the job's work) and the path
    // is recorded in the result envelope + audit for the operator to merge.
    let worktreePath = null;
    let worktreeFrom = null;
    const origAuthorizedRoot = authorizedRoot ?? null; // pre-worktree root — the restart contract replays THIS
    if (worktree) {
      worktreeFrom = workdir;
      worktreePath = join(this.jobsDir, 'worktrees', `wt-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`);
      const r = spawnSync('git', ['worktree', 'add', '--detach', worktreePath, 'HEAD'],
        { cwd: workdir, windowsHide: true, timeout: 30_000, encoding: 'utf-8' });
      if (r.status !== 0) {
        const reason = `git worktree add failed: ${(r.stderr || r.error?.message || 'unknown').trim().slice(0, 300)}`;
        this.audit?.write({ kind: 'JOB_WORKTREE_REFUSED', data: { reason, workdir, parent_run_id: this.runId } });
        return { refused: true, reason };
      }
      this.audit?.write({ kind: 'JOB_WORKTREE', data: { path: worktreePath, from: workdir, parent_run_id: this.runId } });
      workdir = worktreePath;
      authorizedRoot = worktreePath;
    }
    let mutating = false;
    if (this.classifier) {
      try {
        const parsed = await this.classifier(command);
        mutating = MUTATING_RISK.has(parsed.risk) || parsed.hasUnknown === true || Boolean(parsed.parseError);
      } catch {
        mutating = true; // classifier failed on a job command → treat as mutating
      }
    }
    const job = promotedJob ?? this.store.createJob({ jobType, authorizedRoot: authorizedRoot ?? workdir, createdBy: 'pi-executor', dependsOn });
    if (mutating && this.writeLease) {
      const acq = this.writeLease.acquire(`job:${job.job_id}`, { command: command.slice(0, 200) });
      if (!acq.ok) {
        const reason = `workspace write lease held by '${acq.heldBy.holder}' — mutating durable jobs run one at a time; retry when it finishes or the lease expires`;
        // a promoted (dep-queued) job PARKS instead of dying — the pump
        // retries it when the lease holder finishes; a fresh spawn refuses.
        if (promotedJob) return { refused: true, leaseHeld: true, reason, job_id: job.job_id };
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
    // M90-R1: persist the EFFECTIVE sandbox contract — a null call arg plus
    // ambient PAI_SANDBOX=docker used to record `null`, so a later restart
    // under a changed ambient config silently drifted. `false` is the
    // exclusion-bypass sentinel: record it as an explicit unsandboxed replay.
    const effectiveSandbox = sandboxProvider === false
      ? (typeof sandbox === 'object' && sandbox?.kind === 'none'
        ? { kind: 'none' }                    // explicit unsandboxed contract (restart replay)
        : { kind: 'none', bypassed_by: 'sandbox_excludes' })
      : sandboxProvider
        ? { kind: sandboxProvider.kind, distro: sandboxProvider.distro ?? null, image: sandboxProvider.image ?? null, target: sandboxProvider.target ?? null, dir: sandboxProvider.dir ?? null, key: sandboxProvider.key ?? null }
        : { kind: 'none' };
    this.executeAttempt(job.job_id, attempt_id, { command, workdir, mutating, budgetScope, budgetCommitted, timeoutMs, worktreePath, worktreeFrom, sandboxProvider, jobType, sandboxSpec: effectiveSandbox, authorizedRoot: origAuthorizedRoot });
    return { job_id: job.job_id, attempt_id };
  }

  /** Run one attempt: spawn → checkpoint → heartbeat → exit → result envelope. */
  executeAttempt(jobId, attemptId, { command, workdir, resume = false, mutating = false, budgetScope = null, budgetCommitted = false, timeoutMs = null, worktreePath = null, worktreeFrom = null, sandboxProvider = null, jobType = null, sandboxSpec = null, restartSpecCarry = null, authorizedRoot = null }) {
    const checkpointPath = join(this.jobsDir, `${attemptId}.checkpoint.json`);
    const leaseHolder = `job:${jobId}`;
    const resultPath = join(this.jobsDir, `${attemptId}.result.json`);
    const job = this.store.getJob(jobId);
    // sandbox provider decides the real spawn shape — 'none' preserves the
    // historical shell:true path; 'wsl' spawns wsl.exe argv-style (no cmd.exe
    // quoting of the user command). Unavailable backend = fail-closed throw.
    const provider = sandboxProvider === false ? null : (sandboxProvider ?? this.sandbox);
    let spec;
    try {
      spec = (provider ?? { spawnSpec: (c, w) => ({ file: c, args: [], shell: true, cwd: w }) })
        .spawnSpec(command, workdir);
    } catch (e) {
      // Unavailable backend (no docker daemon, no ssh binary, bad target) —
      // the job fails honestly BEFORE any process exists.
      const reason = e instanceof SandboxUnavailableError ? e.message : `sandbox spec failed: ${e.message}`;
      try { this.store.updateWorkerState(attemptId, 'EXITED_ERROR', -1); } catch { /* store closed */ }
      this.store.failJob(jobId, reason);
      this.audit?.write({ kind: 'JOB_SANDBOX_REFUSED', data: { job_id: jobId, attempt_id: attemptId, reason, parent_run_id: this.runId } });
      return null;
    }
    // M121 session env overlay: merges over the operator env at spawn time —
    // later env_set edits reach the next job without a rebuild. Injection
    // keys were refused at set-time inside SessionEnv itself.
    const envOverlay = this.envOverlay?.() ?? {};
    const spawnOpts = { cwd: spec.cwd, windowsHide: true, env: { ...process.env, ...envOverlay } };
    const child = spec.shell
      ? spawn(spec.file, { ...spawnOpts, shell: true })
      : spawn(spec.file, spec.args, spawnOpts);
    if (provider?.kind && provider.kind !== 'none') {
      this.audit?.write({ kind: 'JOB_SANDBOXED', data: { job_id: jobId, attempt_id: attemptId, provider: provider.kind, container: spec.containerName ?? null } });
    }
    this.running.set(jobId, child);

    // machine checkpoint — the resumability contract (atomic: recovery has no
    // fallback for a torn checkpoint — it would escalate a healthy job to
    // REVIEW_REQUIRED instead of resuming it)
    writeJsonAtomic(checkpointPath, {
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
      // M90: the faithful re-spawn contract. restart() replays THIS, not the
      // post-worktree authorized_root — so a worktree job rebuilds a fresh
      // detached checkout off the ORIGINAL base dir, and delegated jobs carry
      // their budget provenance (budget_committed refuses restart outright).
      // Resumed attempts carry the ORIGINAL spec forward, not the resumed
      // context (workdir is already the worktree path here).
      restart_spec: restartSpecCarry ?? {
        command,
        workdir: worktreeFrom ?? workdir,
        authorized_root: authorizedRoot,
        job_type: jobType ?? job?.job_type ?? 'shell_command',
        timeout_ms: timeoutMs,
        worktree: Boolean(worktreePath),
        sandbox: sandboxSpec,
        budget_scope: budgetScope,
        budget_committed: budgetCommitted,
      },
    });
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

    // Kiro max_plan_duration analogue — a wall-clock ceiling on the attempt.
    // The exit handler records 'timeout' as the failure reason so audits
    // distinguish a deadline kill from a genuine nonzero exit.
    let timedOut = false;
    let timeoutTimer = null;
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        if (spec.containerName) {
          // named disposable container — force-remove kills the whole tree
          // inside it, which taskkill on the client pid cannot reach
          try { spawnSync('docker', ['rm', '-f', spec.containerName], { windowsHide: true, timeout: 10_000 }); } catch { /* best-effort */ }
        }
        if (process.platform === 'win32') {
          try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
          catch { child.kill(); }
        } else child.kill('SIGTERM');
        if (spec.remote) {
          // honest limit: killing the local ssh client does NOT kill the
          // remote process — the orphan is recorded, not hidden
          this.audit?.write({ kind: 'JOB_REMOTE_ORPHAN', data: { job_id: jobId, attempt_id: attemptId, target: provider?.target ?? null } });
        }
      }, timeoutMs);
      timeoutTimer.unref();
    }

    child.on('exit', (code, signal) => {
      clearTimeout(timeoutTimer);
      this.running.delete(jobId);
      clearInterval(heartbeat);
      // backgrounded grandchildren (nohup/&) inherit our stdio pipes — the
      // shell exit is the job boundary. Give the final flush a beat, then
      // drop our ends instead of holding FDs open until some detached
      // process decides to die.
      child.stdin?.destroy();
      const release = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, 250);
      release.unref();
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
        // Worktree teardown (M13): clean worktrees are removed; dirty ones
        // stay on disk — their path goes into the result + audit so the
        // operator can merge or discard explicitly.
        let worktreeKept = null;
        if (worktreePath) {
          try {
            const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: worktreePath, windowsHide: true, timeout: 15_000, encoding: 'utf-8' });
            if (dirty.status === 0 && !dirty.stdout.trim()) {
              spawnSync('git', ['worktree', 'remove', worktreePath], { cwd: worktreeFrom ?? this.jobsDir, windowsHide: true, timeout: 15_000 });
            } else worktreeKept = worktreePath;
          } catch { worktreeKept = worktreePath; }
          if (worktreeKept) {
            this.audit?.write({ kind: 'JOB_WORKTREE_KEPT', data: { job_id: jobId, attempt_id: attemptId, path: worktreeKept, parent_run_id: this.runId } });
          }
        }
        writeJsonAtomic(resultPath, {
          attempt_id: attemptId, job_id: jobId,
          exit_code: code, signal,
          // scrub before persist (M5): child stdout/stderr may echo
          // credentials; the artifact must not become a secret store.
          output_tail: redactSecrets(out),
          usage,
          ...(worktreePath ? { worktree: { path: worktreePath, kept: Boolean(worktreeKept) } } : {}),
          ...(provider?.kind && provider.kind !== 'none' ? { sandbox: provider.kind } : {}),
          parent_run_id: this.runId, // usage attribution: child work bills to parent
          finished_at: new Date().toISOString(),
        });
        this.store.recordResult(jobId, attemptId, resultPath);
        this.store.releaseLease(jobId, this.store.getLease(jobId)?.lease_id);
        // CANCELLED is terminal — a cancelled worker's exit must NOT overwrite
        // it with FAILED/COMPLETED (the killed process exits non-zero, which
        // would otherwise flip the record the operator just cancelled).
        const cur = this.store.getJob(jobId);
        if (cur?.cancel_requested || cur?.job_state === 'CANCELLED') {
          this.audit?.write({
            kind: 'JOB_CANCEL_HELD',
            data: { job_id: jobId, attempt_id: attemptId, exit_code: code, parent_run_id: this.runId },
          });
        } else if (code === 0) this.store.completeJob(jobId);
        else this.store.failJob(jobId, timedOut ? `wall-clock timeout exceeded (${timeoutMs}ms)` : `exit ${code ?? signal}`);
        this.audit?.write({
          kind: 'JOB_FINISHED',
          data: { job_id: jobId, attempt_id: attemptId, exit_code: code, usage, parent_run_id: this.runId },
        });
        // Dependency pump: this terminal transition may unblock queued
        // dependents (or cascade-cancel them when this job died).
        this.#pumpDependents().catch(() => { /* pump failure must not corrupt exit bookkeeping */ });
        // M14 (Hermes/CodeBuddy delivery analogue): scheduled jobs have no
        // operator watching — surface their completion as a UI event instead
        // of letting the output die inside the job detail view.
        if (cur?.job_type === 'scheduled' && this.onJobFinished) {
          try {
            this.onJobFinished({ job_id: jobId, job_type: cur.job_type, exit_code: code, output_tail: redactSecrets(out.slice(-2000)) });
          } catch { /* delivery is best-effort — the job record is truth */ }
        }
      } catch (e) {
        if (!/not open|closed/i.test(e.message)) throw e;
      }
    });
    return child;
  }

  /** Cold-start recovery: sweep unfinished jobs, respawn dead workers. */
  recover({ workdir } = {}) {
    const actions = this.store.recoveryTick({
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
            // UNWIND the phantom attempt: recoveryTick already ran startAttempt
            // for this resume, recording OUR OWN pid as the placeholder worker
            // identity. Left standing, the next sweep probes that pid (alive —
            // it's us), takes the onAlive orphan path, sees the lease held by
            // another job, and KILLS OUR OWN PROCESS. Mark the attempt dead and
            // hand the job back to CHECKPOINTED so the next sweep retries the
            // resume once the lease holder finishes.
            try {
              this.store.db.prepare('UPDATE attempts SET worker_identity = ? WHERE attempt_id = ?')
                .run('{}', attemptId);
              this.store.updateWorkerState(attemptId, 'EXITED_ERROR', -1);
              if (job.checkpoint_ref) this.store.recordCheckpoint(job.job_id, attemptId, job.checkpoint_ref);
            } catch { /* store closed — next boot's sweep retries anyway */ }
            this.audit?.write({
              kind: 'JOB_PARKED',
              data: { job_id: job.job_id, attempt_id: attemptId, reason: `workspace write lease held by '${acq.heldBy.holder}'`, parent_run_id: this.runId },
            });
            return;
          }
        }
        // Resume under the ORIGINAL execution contract: a docker/wsl/ssh job
        // that crashes and recovers must not silently drop to the host shell,
        // and a timed job must not lose its wall-clock ceiling. Both ride the
        // restart_spec persisted at first launch (legacy checkpoints without
        // one fall back to ambient — historical behavior).
        const rs = checkpoint?.restart_spec ?? null;
        let resumedProvider = null;
        const sb = rs?.sandbox;
        if (sb && typeof sb === 'object' && sb.kind && sb.kind !== 'none') {
          try { resumedProvider = new SandboxProvider(sb.kind, sb); } catch { resumedProvider = null; }
        } else if (sb && typeof sb === 'object' && sb.kind === 'none') {
          resumedProvider = false; // explicit unsandboxed contract — never adopt a changed ambient
        }
        this.executeAttempt(job.job_id, attemptId, {
          command: cmd,
          workdir: workdir ?? job.authorized_root,
          resume: true,
          mutating: true,
          budgetScope: checkpoint?.budget_scope ?? null,
          budgetCommitted: checkpoint?.budget_committed === true,
          timeoutMs: rs?.timeout_ms ?? null,
          sandboxProvider: resumedProvider,
          restartSpecCarry: rs,
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
        // Our own pid here is a RESPAWN PLACEHOLDER (recoveryTick stamps it
        // before the real child exists), not an orphan worker — adopting it
        // would renew a lease for a worker that doesn't exist, and the kill
        // branch below would terminate the host itself.
        if (!workerPid || workerPid === process.pid) return;
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
    // Dep pump after the sweep: deps may have completed while we were down —
    // promote what cleared, cascade-cancel what can never run.
    this.#pumpDependents().catch(() => { /* recovery pump is best-effort */ });
    return actions;
  }
}

const jobText = (t, extra = {}) => ({ content: [{ type: 'text', text: t }], ...extra });

/**
 * job_spawn — the model's durable-command surface (remote execution analogue):
 * an arbitrary shell command runs as a durable job that survives restarts,
 * optionally inside a WSL distro, a disposable Docker container, or on a
 * remote host over SSH. The command string is governance-classified exactly
 * like a bash call (same commandArgs wiring) — spawning it elsewhere is not
 * a policy bypass, it is a different execution boundary for the same rules.
 */
export function jobSpawnTool(executor, { workdir, getScope = null } = {}) {
  return {
    name: 'job_spawn', label: 'Job Spawn',
    description:
      'Run a shell command as a durable background job — survives host restarts, ' +
      'poll with job_status. Optional `sandbox` selects the execution boundary: ' +
      '"wsl" (Windows WSL distro, sandbox_distro optional), "docker" (disposable ' +
      'container with the workdir mounted at /work, sandbox_image optional), or ' +
      '"ssh" (remote host — needs sandbox_target user@host[:port], remote_dir ' +
      'required, sandbox_key optional; NO workspace sync — the remote dir must ' +
      'already contain what the command needs). The command is classified by the ' +
      'same governance rules as bash — a denied command is denied everywhere.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'shell command to run durably' },
        timeout_minutes: { type: 'number', description: 'optional wall-clock ceiling in minutes' },
        sandbox: { type: 'string', enum: ['wsl', 'docker', 'ssh'], description: 'execution boundary — omit for the host shell' },
        sandbox_distro: { type: 'string', description: 'WSL distribution name (default distro when omitted)' },
        sandbox_image: { type: 'string', description: 'docker image (default debian:bookworm-slim)' },
        sandbox_target: { type: 'string', description: 'ssh target user@host[:port]' },
        remote_dir: { type: 'string', description: 'remote working directory for ssh (default ~)' },
        sandbox_key: { type: 'string', description: 'ssh identity file path' },
        worktree: { type: 'boolean', description: 'run inside a detached git worktree (local jobs only)' },
        depends_on: {
          type: 'array', items: { type: 'string' },
          description: 'job ids that must ALL reach COMPLETED before this job starts — the job queues durably, promotes itself when the chain clears, and is cancelled if any dependency fails',
        },
      },
      required: ['command'],
    },
    promptSnippet: 'job_spawn(command, [sandbox], [depends_on]): run a command as a durable job — wsl/docker/ssh execution boundary optional, depends_on queues until those jobs COMPLETE',
    async execute(_toolCallId, params) {
      const command = String(params.command ?? '').trim();
      if (!command) return jobText('job_spawn requires a command', { isError: true });
      const timeoutMin = Number(params.timeout_minutes);
      const r = await executor.spawnCommandJob({
        command,
        workdir: workdir ?? process.cwd(),
        jobType: 'shell_command',
        budgetScope: getScope?.() ?? null,
        timeoutMs: Number.isFinite(timeoutMin) && timeoutMin > 0 ? Math.round(Math.min(timeoutMin, 24 * 60) * 60_000) : null,
        worktree: params.worktree === true,
        dependsOn: Array.isArray(params.depends_on) ? params.depends_on : null,
        sandbox: params.sandbox
          ? {
              kind: String(params.sandbox),
              image: params.sandbox_image ?? null,
              target: params.sandbox_target ?? null,
              dir: params.remote_dir ?? null,
              key: params.sandbox_key ?? null,
              distro: params.sandbox_distro ?? null,
            }
          : null,
      });
      if (r.refused) return jobText(`job_spawn refused: ${r.reason}`, { isError: true });
      if (r.queued) {
        return jobText(
          `job ${r.job_id} QUEUED — waiting on ${r.waiting_on.join(', ')} to COMPLETE. ` +
          'It starts itself when the chain clears and is cancelled if a dependency fails; poll job_status as usual.',
          { job_id: r.job_id, queued: true, waiting_on: r.waiting_on },
        );
      }
      return jobText(
        `job ${r.job_id} spawned (attempt ${r.attempt_id})` +
        `${params.sandbox ? ` under ${params.sandbox}` : ''} — ` +
        `survives restarts; poll job_status ${r.job_id} for output`,
        { job_id: r.job_id, attempt_id: r.attempt_id },
      );
    },
  };
}
