/**
 * BodySupervisor — the app layer's multi-body composition root.
 *
 * Owns the instance root, registers body facts at discovery, spawns one body
 * channel process at a time, and speaks a superset of the host channel
 * protocol to the UI:
 *
 *   body_list / body_current / eligibility_preview / body_select /
 *   handoff_status / supervisor_status   → answered by the supervisor itself
 *   everything else (prompt/steer/abort/get_state/job_status/job_list/
 *   audit_tail/body_info/handoff_*)      → proxied to the live body channel
 *
 * body_select between two channel-capable bodies runs the real cold-handoff
 * machine (prepared→…→verified) whenever the session has content; an empty
 * session is a cheap cold swap. Fail-closed everywhere: ineligible bodies and
 * bodies without a channel are refused with reasons, never silently degraded.
 */
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep, isAbsolute } from 'node:path';
import { ensureInstance } from './instance.js';
import { bodyCatalog } from './bodies.js';
import { BodyRegistry } from '../../host/src/core/registry.js';
import { DomainLeaseStore } from '../../host/src/core/lease.js';
import { HandoffStore } from '../../host/src/core/handoff.js';
import { PredictionStore } from '../../host/src/core/prediction.js';
import { ObservationStore } from '../../host/src/core/observation.js';
import { loadPolicy } from '../../host/src/core/policy.js';
import { eligible } from '../../host/src/core/eligibility.js';
import { AuditWriter } from '../../host/src/core/audit.js';
import { PaiIgnore } from '../../host/src/core/paiignore.js';
import { REQUIRED_BODY_CAPABILITIES } from '../../pi/src/bootstrap/facts.js';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Zero-dep repo HEAD read: .git/HEAD → loose ref (packed-refs fallback).
 * The operator's instance can run days-old code while the repo advances —
 * version awareness is how "you are running stale code" becomes visible
 * instead of silent. Returns a short hash or null when unreadable.
 */
function readRepoCommit(repoRoot) {
  try {
    const head = readFileSync(join(repoRoot, '.git', 'HEAD'), 'utf-8').trim();
    if (!head.startsWith('ref:')) return head.slice(0, 12) || null; // detached
    const ref = head.slice(4).trim();
    const loose = join(repoRoot, '.git', ...ref.split('/'));
    if (existsSync(loose)) return readFileSync(loose, 'utf-8').trim().slice(0, 12);
    const packed = readFileSync(join(repoRoot, '.git', 'packed-refs'), 'utf-8');
    const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
    return line ? line.slice(0, 12) : null;
  } catch { return null; }
}

export class BodySupervisor {
  /* Backup ownership lives with the app lifecycle, not the OS scheduler:
   * the app probes freshness on boot and hourly while running, and runs the
   * backup itself when overdue. A scheduler registration can silently vanish
   * with nobody noticing (2026-10 review: four PersonalAI tasks were missing
   * for ~26 days); the app's own state cannot vanish while the app is the
   * thing producing the data. WHAT to back up stays in
   * scripts/durability/run_backup.py — one implementation, no drift. */
  #backupState = { status: null, running: false, lastProbe: 0 };
  #backupTimer = null;

  /* Governance checks (frequent / weekly / sync-check lanes) are owned by the
   * app lifecycle for the same reason backup is: the 2026-10 review found all
   * four PersonalAI scheduled tasks silently missing ~26 days — backup got an
   * app-side owner first, but the watchdog lanes (drift, sync classification,
   * upstream review) were equally orphaned. Without them a dead backup would
   * AGAIN have nothing that notices. WHAT each lane checks stays in
   * scripts/governance/runner_adapter.py — one implementation, no drift. */
  #govState = { status: null, running: false, lastProbe: 0 };
  #govTimer = null;
  #cogState = { running: false, lastRun: 0 };
  #cogTimer = null;

  /**
   * @param {object} o
   * @param {string} o.instanceRoot  outside any git worktree
   * @param {string} o.workdir       the body's working directory
   * @param {string} o.repoRoot      repository root
   * @param {object} [o.env]         defaults to process.env
   * @param {object} [o.catalog]     override bodyCatalog (tests inject fakes)
   * @param {Array}  [o.profile]     task profile for eligibility; defaults to
   *                                 the production REQUIRED_BODY_CAPABILITIES
   * @param {object} [o.backupCtl]   test seam: { probe, run } overrides the
   *                                 python durability scripts (same pattern
   *                                 as catalog overrides)
   */
  constructor({ instanceRoot, workdir, repoRoot, env = process.env, catalog = null, profile = null, backupCtl = null, govCtl = null, cogCtl = null, promptTimeoutMs = 600_000 }) {
    this.instanceRoot = instanceRoot;
    this.workdir = workdir;
    this.repoRoot = repoRoot;
    this.env = env;
    this.catalogOverride = catalog;
    this.profile = profile ?? REQUIRED_BODY_CAPABILITIES;
    this.backupCtl = backupCtl;
    this.govCtl = govCtl;
    this.cogCtl = cogCtl;
    // Prompt turn ceiling (test seam). 10min: a turn streams progress events
    // while it runs, so the default body timeout would falsely report a long
    // run as lost; abort is always available to the operator.
    this.promptTimeoutMs = promptTimeoutMs;
    this.listeners = new Set();
    this.active = null;
    this.switching = false;
    this.installed = {};
    this.configPath = join(instanceRoot, 'app-config.json');
    // PRD F03/A05 receipt-loss guard: prompts carry a caller-generated
    // client_msg_id; the ledger makes each id execute AT MOST ONCE and turns
    // "sent but the receipt was lost" into an explicit `uncertain` state that
    // must be reconciled (prompt_reconcile) instead of blindly resent.
    this.promptLedger = this.#loadPromptLedger();
  }

  /* ---- prompt ledger (F03/A05) -------------------------------------------
   * Entry: { clientMsgId, messageHash, preview, status, startedAt,
   *          completedAt, response?, reconciled? }
   * status: in_flight | completed | uncertain | not_delivered
   *   completed     — the body answered (a refusal is still a receipt)
   *   uncertain     — written to the channel but the receipt never came back
   *                   (timeout / body exit): may or may not have executed
   *   not_delivered — proven never to have reached a body: safe to resend
   * Persisted (bounded, last 200) so a supervisor restart still dedups. */
  #promptLedgerPath() { return join(this.instanceRoot, 'prompt-ledger.json'); }

  #loadPromptLedger() {
    const m = new Map();
    try {
      const raw = JSON.parse(readFileSync(this.#promptLedgerPath(), 'utf-8'));
      for (const e of raw.entries ?? []) {
        if (!e?.clientMsgId) continue;
        // in_flight across a process restart means the outcome is unknown:
        // the previous process died between dispatch and receipt.
        if (e.status === 'in_flight') { e.status = 'uncertain'; e.promise = null; }
        m.set(e.clientMsgId, e);
      }
    } catch { /* first run or torn file — an empty ledger is honest */ }
    return m;
  }

  #savePromptLedger() {
    try {
      const entries = [...this.promptLedger.values()]
        .map(({ promise, ...e }) => e) // promises never serialise
        .slice(-200);
      const tmp = `${this.#promptLedgerPath()}.tmp`;
      writeFileSync(tmp, JSON.stringify({ entries }, null, 1));
      renameSync(tmp, this.#promptLedgerPath()); // same-volume atomic replace
    } catch { /* ledger persistence is best-effort — dedup still works in-memory */ }
  }

  /** Persisted app-level config (workdir today). Best-effort, never fatal. */
  #loadConfig() {
    try {
      const cfg = JSON.parse(readFileSync(this.configPath, 'utf-8'));
      if (cfg.workdir && existsSync(cfg.workdir)) this.workdir = cfg.workdir;
    } catch { /* first run or corrupt config — env/default workdir stands */ }
  }

  #saveConfig() {
    try {
      let existing = {};
      try { existing = JSON.parse(readFileSync(this.configPath, 'utf-8')); } catch {}
      writeFileSync(this.configPath, JSON.stringify({ ...existing, workdir: this.workdir }, null, 2));
    } catch { /* persistence is best-effort */ }
  }

  /** Freshness probe: scripts/durability/backup_status.py (or test seam). */
  #backupProbe() {
    if (this.backupCtl?.probe) return this.backupCtl.probe();
    return new Promise((resolvePromise) => {
      const py = this.env.PAI_PYTHON ?? 'python';
      let child;
      try {
        child = spawn(py, [join(this.repoRoot, 'scripts', 'durability', 'backup_status.py')],
          { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      } catch { return resolvePromise({ ok: false, error: 'probe spawn failed' }); }
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      const killer = setTimeout(() => child.kill(), 15_000);
      child.on('error', () => { clearTimeout(killer); resolvePromise({ ok: false, error: 'probe spawn failed' }); });
      child.on('close', () => {
        clearTimeout(killer);
        try { resolvePromise(JSON.parse(out)); }
        catch { resolvePromise({ ok: false, error: 'probe output unparsable' }); }
      });
    });
  }

  /** The backup run itself: scripts/durability/run_backup.py (or test seam).
   * Output appends to <instance>/jobs/backup-auto.log; never blocks boot. */
  #backupRun() {
    if (this.backupCtl?.run) return this.backupCtl.run();
    const py = this.env.PAI_PYTHON ?? 'python';
    const logPath = join(this.paths.jobsDir, 'backup-auto.log');
    let fd;
    try { fd = openSync(logPath, 'a'); } catch { fd = null; }
    const child = spawn(py, [join(this.repoRoot, 'scripts', 'durability', 'run_backup.py')],
      { stdio: ['ignore', fd ?? 'ignore', fd ?? 'ignore'], windowsHide: true });
    if (fd !== null) child.on('close', () => { try { closeSync(fd); } catch { /* already closed */ } });
    return new Promise((r) => {
      child.on('error', () => r(1));
      child.on('close', (code) => r(code ?? 1));
    });
  }

  /** One overdue check (+run when owed). Probes are throttled to hourly
   * unless forced; concurrent ticks collapse on the running flag.
   * afterRun: the post-run re-probe only refreshes status — a failed run
   * that leaves the probe overdue must NOT re-run inside the same tick
   * (infinite retry loop); the next hourly tick is the retry. */
  async #backupTick(force = false, afterRun = false) {
    if (this.#backupState.running) return this.#backupState.status;
    if (!force && Date.now() - this.#backupState.lastProbe < 3_600_000) return this.#backupState.status;
    this.#backupState.lastProbe = Date.now();
    const st = await this.#backupProbe();
    this.#backupState.status = st;
    if (!st?.ok) {
      this.audit?.write({ kind: 'BACKUP_PROBE_FAILED', data: { error: st?.error ?? 'unknown' } });
      return st;
    }
    if (st.overdue && !afterRun) {
      this.#backupState.running = true;
      this.audit?.write({ kind: 'BACKUP_AUTO_STARTED', data: { last_ok: st.last_ok, age_hours: st.age_hours } });
      this.#emitSupervisor('backup', { phase: 'started' });
      const code = await this.#backupRun();
      this.#backupState.running = false;
      this.audit?.write({ kind: 'BACKUP_AUTO_FINISHED', data: { exit: code } });
      this.#emitSupervisor('backup', { phase: 'finished', exit: code });
      this.#backupState.lastProbe = 0; // re-probe so status reflects the run
      await this.#backupTick(true, true);
    }
    return this.#backupState.status;
  }

  /** Lane freshness probe: scripts/governance/gov_freshness.py (or test seam). */
  #govProbe() {
    if (this.govCtl?.probe) return this.govCtl.probe();
    return new Promise((resolvePromise) => {
      const py = this.env.PAI_PYTHON ?? 'python';
      let child;
      try {
        child = spawn(py, [join(this.repoRoot, 'scripts', 'governance', 'gov_freshness.py')],
          { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      } catch { return resolvePromise({ ok: false, error: 'probe spawn failed' }); }
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      const killer = setTimeout(() => child.kill(), 15_000);
      child.on('error', () => { clearTimeout(killer); resolvePromise({ ok: false, error: 'probe spawn failed' }); });
      child.on('close', () => {
        clearTimeout(killer);
        try { resolvePromise(JSON.parse(out)); }
        catch { resolvePromise({ ok: false, error: 'probe output unparsable' }); }
      });
    });
  }

  /** One governance lane run: runner_adapter.py <lane> (or test seam). Lanes
   * are check-only/proposal-only by design, so auto-running them is safe.
   * Output appends to <instance>/jobs/gov-<lane>-auto.log. Trigger/actor are
   * stamped app-lifecycle so provenance never claims a scheduler that is gone. */
  #govRun(lane) {
    if (this.govCtl?.run) return this.govCtl.run(lane);
    const py = this.env.PAI_PYTHON ?? 'python';
    const logPath = join(this.paths.jobsDir, `gov-${lane}-auto.log`);
    let fd;
    try { fd = openSync(logPath, 'a'); } catch { fd = null; }
    const child = spawn(py, [join(this.repoRoot, 'scripts', 'governance', 'runner_adapter.py'), lane], {
      stdio: ['ignore', fd ?? 'ignore', fd ?? 'ignore'],
      windowsHide: true,
      env: { ...this.env, PERSONAL_AI_TRIGGER: 'app-lifecycle', PERSONAL_AI_ACTOR: 'personal-ai-app' },
    });
    if (fd !== null) child.on('close', () => { try { closeSync(fd); } catch { /* already closed */ } });
    return new Promise((r) => {
      child.on('error', () => r(1));
      child.on('close', (code) => r(code ?? 1));
    });
  }

  /** One governance freshness check (+run each overdue lane, sequentially:
   * lanes all touch the same repo/ledger, parallel runs would interleave
   * evidence). Cheap lanes first so a slow weekly never delays sync-check.
   * afterRun: same no-immediate-retry guard as #backupTick. */
  async #govTick(force = false, afterRun = false) {
    if (this.#govState.running) return this.#govState.status;
    if (!force && Date.now() - this.#govState.lastProbe < 3_600_000) return this.#govState.status;
    this.#govState.lastProbe = Date.now();
    const st = await this.#govProbe();
    this.#govState.status = st;
    if (!st?.ok) {
      this.audit?.write({ kind: 'GOV_PROBE_FAILED', data: { error: st?.error ?? 'unknown' } });
      return st;
    }
    const due = afterRun ? [] : ['sync-check', 'frequent', 'weekly']
      .filter((l) => st.lanes?.[l]?.overdue);
    if (due.length) {
      this.#govState.running = true;
      for (const lane of due) {
        this.audit?.write({ kind: 'GOV_AUTO_STARTED', data: { lane, age_hours: st.lanes[lane].age_hours } });
        this.#emitSupervisor('governance', { phase: 'started', lane });
        const code = await this.#govRun(lane);
        this.audit?.write({ kind: 'GOV_AUTO_FINISHED', data: { lane, exit: code } });
        this.#emitSupervisor('governance', { phase: 'finished', lane, exit: code });
      }
      this.#govState.running = false;
      this.#govState.lastProbe = 0; // re-probe so status reflects the runs
      await this.#govTick(true, true);
    }
    return this.#govState.status;
  }

  /** Cognition cycle (PRD F06/M3 产生侧): proposals must appear without the
   * owner running a CLI. mind/wm_cycle.py distills closed episodes into
   * proposals/ — it never writes canonical (u1_accept is the only writer),
   * so scheduling it from the app lifecycle is safe. Interval-gated (30min),
   * non-reentrant, audited; test seam via cogCtl like backupCtl/govCtl. */
  #cogRun() {
    if (this.cogCtl?.run) return this.cogCtl.run();
    const py = this.env.PAI_PYTHON ?? 'python';
    const logPath = join(this.paths.jobsDir, 'cognition-auto.log');
    let fd;
    try { fd = openSync(logPath, 'a'); } catch { fd = null; }
    // --canonical 必须显式传已解析的挂载路径（实例可能挂载真实 canonical，
    // 默认 <instance>/canonical 会是另一个陈旧目录 — 见 wm_cycle --help）。
    const child = spawn(py, [join(this.repoRoot, 'mind', 'wm_cycle.py'),
      '--instance', this.instanceRoot, '--canonical', this.paths.canonicalDir], {
      stdio: ['ignore', fd ?? 'ignore', fd ?? 'ignore'],
      windowsHide: true,
      env: { ...this.env, PERSONAL_AI_TRIGGER: 'app-lifecycle', PERSONAL_AI_ACTOR: 'personal-ai-app' },
    });
    if (fd !== null) child.on('close', () => { try { closeSync(fd); } catch { /* already closed */ } });
    return new Promise((r) => {
      child.on('error', () => r(1));
      child.on('close', (code) => r(code ?? 1));
    });
  }

  async #cogTick(force = false) {
    if (this.#cogState.running) return;
    if (!force && Date.now() - this.#cogState.lastRun < 1_800_000) return;
    this.#cogState.running = true;
    this.#cogState.lastRun = Date.now();
    this.audit?.write({ kind: 'COG_AUTO_STARTED', data: { force } });
    this.#emitSupervisor('cognition', { phase: 'started' });
    const code = await this.#cogRun();
    this.#cogState.running = false;
    this.audit?.write({ kind: 'COG_AUTO_FINISHED', data: { exit: code } });
    // 提案队列可能出了新条目——通知 UI 刷新认知卡
    this.#emitSupervisor('cognition', { phase: 'finished', exit: code });
  }

  #macrosPath() { return join(this.instanceRoot, 'macros.json'); }

  /* Session pin/archive (product metadata, body-agnostic): keyed by session
   * file path so it works for pi AND dsh sessions. Decorated onto
   * session_list results — the body never sees it. */
  #sessMetaPath() { return join(this.instanceRoot, 'session-meta.json'); }

  #sessMeta() {
    try { return JSON.parse(readFileSync(this.#sessMetaPath(), 'utf-8')); }
    catch { return {}; }
  }

  #saveSessMeta(meta) {
    try { writeFileSync(this.#sessMetaPath(), JSON.stringify(meta, null, 2)); } catch { /* best-effort */ }
  }

  #setSessMeta(path, patch) {
    if (!path) return null;
    const meta = this.#sessMeta();
    meta[path] = { ...(meta[path] ?? {}), ...patch };
    this.#saveSessMeta(meta);
    this.audit.write({ kind: 'SESSION_META', data: { path, ...patch } });
    return meta[path];
  }

  /* Workspace registry (U9) — remembered project roots the operator can
   * switch between. Switching still goes through set_workdir's respawn
   * path; the registry is a persisted MRU, not a parallel session space. */
  #workspacesPath() { return join(this.instanceRoot, 'workspaces.json'); }

  #workspaces() {
    try {
      const list = JSON.parse(readFileSync(this.#workspacesPath(), 'utf-8'));
      return Array.isArray(list) ? list : [];
    } catch { return []; }
  }

  #saveWorkspaces(list) {
    try { writeFileSync(this.#workspacesPath(), JSON.stringify(list, null, 2)); } catch { /* best-effort */ }
  }

  #touchWorkspace(dir) {
    const list = this.#workspaces();
    const now = Date.now();
    const i = list.findIndex((w) => w.path === dir);
    if (i >= 0) list[i].lastUsedAt = now;
    else list.push({ path: dir, name: dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || dir, addedAt: now });
    const cur = list[i >= 0 ? i : list.length - 1];
    cur.lastUsedAt = now;
    this.#saveWorkspaces(list);
  }


  #macros() {
    try { return JSON.parse(readFileSync(this.#macrosPath(), 'utf-8')); } catch { return {}; }
  }

  #saveMacros(macros) {
    writeFileSync(this.#macrosPath(), JSON.stringify(macros, null, 2));
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #emit(msg) {
    for (const l of this.listeners) {
      try { l(msg); } catch { /* listener failure must not break the channel */ }
    }
  }

  #emitSupervisor(kind, data = {}) {
    this.#emit({ type: 'supervisor', event: { kind, ...data } });
  }

  async start() {
    this.paths = ensureInstance(this.instanceRoot);
    this.#loadConfig();
    this.registry = new BodyRegistry(this.paths);
    this.leases = new DomainLeaseStore(this.paths);
    this.handoffs = new HandoffStore(this.paths);
    this.audit = new AuditWriter(this.paths, { annotations: { actor: 'app-supervisor' } });

    this.catalog = this.catalogOverride
      ?? bodyCatalog({ repoRoot: this.repoRoot, instanceRoot: this.instanceRoot, workdir: this.workdir, env: this.env });

    // Discovery: only installed bodies enter the registry — the panel shows
    // every catalog entry, but facts are registered for real ones only.
    for (const [id, entry] of Object.entries(this.catalog)) {
      let ok = false;
      try { ok = Boolean(await entry.installed?.()); } catch { ok = false; }
      this.installed[id] = ok;
      if (ok) this.registry.register(entry.facts());
    }

    // Default body: mechanism output, not declaration. PAI_BODY can pin a
    // preference but still passes the same eligibility gate.
    const pinned = this.env.PAI_BODY;
    let chosen = null;
    if (pinned && this.catalog[pinned]) {
      const r = eligible(this.registry.get(pinned) ?? { body_id: pinned }, {
        requiredCapabilities: this.profile,
      });
      if (this.installed[pinned] && this.catalog[pinned].channel && r.eligible) chosen = pinned;
    }
    // selectBody picks by facts alone — the default must ALSO have a channel.
    if (!chosen) {
      const candidates = this.registry.list()
        .filter((b) => this.catalog[b.body_id]?.channel)
        .map((b) => ({ b, r: eligible(b, { requiredCapabilities: this.profile }) }))
        .filter((x) => x.r.eligible)
        .sort((x, y) => x.r.degraded.length - y.r.degraded.length
          || String(x.b.body_id).localeCompare(String(y.b.body_id)));
      chosen = candidates[0]?.b.body_id ?? null;
    }
    if (!chosen || !this.catalog[chosen]?.channel) {
      throw new Error(
        `no eligible channel-capable body installed (registered: ${this.registry.list().map((b) => b.body_id).join(', ') || 'none'})`,
      );
    }
    await this.spawnBody(chosen);
    this.bootCommit = readRepoCommit(this.repoRoot);
    this.audit.write({ kind: 'SUPERVISOR_STARTED', data: { body: chosen, installed: this.installed, commit: this.bootCommit } });
    // Backup is owned by the app lifecycle: probe on boot + hourly while
    // running; overdue → run. Fire-and-forget — never blocks boot.
    this.#backupTimer = setInterval(() => { this.#backupTick().catch(() => {}); }, 3_600_000);
    this.#backupTimer.unref?.();
    this.backupBoot = this.#backupTick(true).catch(() => null);
    // Governance lanes share the app-lifecycle ownership model; boot probe is
    // chained after the backup probe so a long first backup never starves it.
    this.#govTimer = setInterval(() => { this.#govTick().catch(() => {}); }, 3_600_000);
    this.#govTimer.unref?.();
    this.govBoot = this.backupBoot.then(() => this.#govTick(true)).catch(() => null);
    // Cognition cycle: chained after governance so a slow first probe never
    // starves it; 30-min cadence, first run on boot.
    this.#cogTimer = setInterval(() => { this.#cogTick().catch(() => {}); }, 1_800_000);
    this.#cogTimer.unref?.();
    this.cogBoot = this.govBoot.then(() => this.#cogTick(true)).catch(() => null);
    return this;
  }

  /** Spawn the body channel process and wire its JSONL stream. */
  async spawnBody(bodyId) {
    const entry = this.catalog[bodyId];
    if (!entry?.channel) throw new Error(`body '${bodyId}' has no channel entrypoint`);
    const spec = entry.channel({ workdir: this.workdir });
    const child = spawn(spec.command, spec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...this.env, ...(spec.env ?? {}) },
      cwd: spec.cwd ?? this.workdir,
    });
    const pending = new Map();
    const stderrTail = [];
    child.stderr.on('data', (d) => {
      stderrTail.push(String(d));
      if (stderrTail.length > 40) stderrTail.shift();
    });
    // stdin EPIPE: a write racing a body death must not throw an unhandled
    // stream error and take the supervisor down with the body.
    child.stdin.on('error', () => { /* body already gone; exit path reports it */ });
    const active = { bodyId, child, pending, seq: 0, stderrTail, info: null, dead: false, bornAt: Date.now(), expectedExit: false };
    const onExit = (code, signal) => {
      if (active.dead) return;
      active.dead = true;
      this.#recordCrash(active, code, signal);
      for (const [, p] of pending) p({ type: 'response', success: false, error: 'body process exited' });
      pending.clear();
      this.#emitSupervisor('body_exited', {
        body: bodyId,
        exitCode: code,
        signal,
        expected: Boolean(active.expectedExit),
      });
      this.#maybeRespawn(active);
    };
    // Spawn failure (ENOENT/EACCES): an unhandled 'error' event THROWS and
    // crashes the whole supervisor — and 'exit' may never follow, so drive
    // the same exit path from here.
    child.on('error', (e) => {
      stderrTail.push(`spawn error: ${e.message}\n`);
      onExit(-1, null);
    });
    child.on('exit', (code, signal) => onExit(code, signal));
    const rl = createInterface({ input: child.stdout, terminal: false });
    rl.on('line', (line) => {
      const t = line.trim();
      if (!t) return;
      let rec;
      try { rec = JSON.parse(t); } catch {
        this.#emit({ type: 'raw', body: bodyId, line: t });
        return;
      }
      if (rec.type === 'response' && rec.id !== undefined && pending.has(rec.id)) {
        pending.get(rec.id)(rec);
        pending.delete(rec.id);
        return;
      }
      this.#emit(rec);
    });
    this.active = active;
    // Ready probe: body_info answers once the channel is serving — also the
    // run/session identity the supervisor needs for lease claims later.
    const info = await this.sendToBody({ type: 'body_info' }, 45_000);
    if (!info.success) {
      // The body's own stderr usually carries the real reason (lease conflict,
      // missing dependency, config error) — 'body process exited' alone is a
      // dead end for the operator. Always append the tail.
      const tail = stderrTail.join('').trim().slice(-400);
      throw new Error(`body '${bodyId}' channel did not come up: ${info.error ?? 'no response'}${tail ? `\n${tail}` : ''}`);
    }
    active.info = info.data;
    this.#emitSupervisor('body_started', { body: bodyId, runId: info.data?.runId });
  }

  /**
   * Crash forensics: a body exit without evidence makes root-cause analysis
   * impossible by construction — the stderr tail lives only in this process's
   * memory and dies with the event loop. Every exit is audited; an
   * UNEXPECTED exit additionally drops a full report (exit code, signal,
   * uptime, in-flight command count, stderr tail) into <instance>/crashes/
   * so the next session can see WHY the body died, not just that it did.
   */
  #recordCrash(active, code, signal) {
    const record = {
      at: new Date().toISOString(),
      body: active.bodyId,
      pid: active.child.pid ?? null,
      exitCode: code,
      signal,
      expected: active.expectedExit,
      uptimeMs: Date.now() - active.bornAt,
      inFlightCommands: active.pending.size,
      stderrTail: active.stderrTail.join('').trim().slice(-4000),
    };
    try {
      this.audit.write({
        kind: 'BODY_EXITED',
        data: { ...record, stderrTail: record.stderrTail.slice(-800) },
      });
    } catch { /* audit failure must not mask the exit itself */ }
    if (record.expected) return;
    try {
      const dir = join(this.instanceRoot, 'crashes');
      mkdirSync(dir, { recursive: true });
      const stamp = record.at.replace(/[:.]/g, '-');
      writeFileSync(join(dir, `${stamp}-${active.bodyId}.json`), JSON.stringify(record, null, 2));
    } catch { /* forensics must never take the supervisor down */ }
  }

  /**
   * Crash resilience: an unexpected body exit respawns the same body with
   * backoff (1s, 2s, 4s — then we stop and leave the dead-body error surface).
   * Superseded actives (a switch already replaced us) and deliberate
   * shutdowns never respawn. A body that survives 30s resets the budget.
   */
  #maybeRespawn(active) {
    if (active.expectedExit) return;
    if (this.active !== active || this.switching || this._disposing) return;
    const attempt = (Date.now() - active.bornAt > 30_000 ? 0 : active.respawnAttempt ?? 0) + 1;
    if (attempt > 3) return;
    this.#emitSupervisor('body_respawn_wait', { body: active.bodyId, attempt, inMs: attempt * 1000 });
    setTimeout(async () => {
      if (this.active !== active || this.switching || this._disposing) return;
      try {
        await this.spawnBody(active.bodyId);
        this.active.respawnAttempt = attempt;
        this.#emitSupervisor('body_respawned', { body: active.bodyId, attempt });
      } catch (e) {
        this.#emitSupervisor('body_respawn_failed', { body: active.bodyId, attempt, error: e?.message ?? String(e) });
      }
    }, attempt * 1000);
  }

  /** Graceful channel shutdown: close stdin → body disposes → lease released. */
  async gracefulShutdown() {
    const active = this.active;
    if (!active || active.dead) return;
    active.expectedExit = true; // operator-driven exit: audited, but no crash report, no respawn
    active.child.stdin.end();
    const exited = await Promise.race([
      new Promise((r) => active.child.on('exit', () => r(true))),
      sleep(5000).then(() => false),
    ]);
    if (!exited) active.child.kill();
    this.active = null;
  }

  /** Send one command to the live body channel; resolves its response. */
  sendToBody(cmd, timeoutMs = 60_000) {
    const active = this.active;
    if (!active || active.dead) {
      return Promise.resolve({ id: cmd.id, type: 'response', command: cmd.type, success: false, error: 'no live body' });
    }
    const cid = `c${++active.seq}`;
    const line = JSON.stringify({ ...cmd, id: cid });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        active.pending.delete(cid);
        resolve({ id: cmd.id, type: 'response', command: cmd.type, success: false, error: 'body command timed out' });
      }, timeoutMs);
      active.pending.set(cid, (rec) => {
        clearTimeout(timer);
        resolve({ ...rec, id: cmd.id });
      });
      active.child.stdin.write(`${line}\n`);
    });
  }

  bodyList() {
    return Object.values(this.catalog).map((e) => {
      const facts = this.installed[e.id] ? this.registry.get(e.id) : null;
      const elig = facts
        ? eligible(facts, { requiredCapabilities: this.profile })
        : { eligible: false, degraded: [], failClosed: [{ invariant: 'installed', reason: e.installHint ?? 'not installed' }] };
      return {
        body_id: e.id,
        label: e.label ?? e.id,
        installed: this.installed[e.id],
        has_channel: Boolean(e.channel),
        current: this.active?.bodyId === e.id,
        facts,
        eligibility: elig,
        install_hint: e.installHint ?? null,
      };
    });
  }

  /** body_select — the user-facing verb. Cold swap or full handoff. */
  async selectBodyCmd(bodyId) {
    const entry = this.catalog[bodyId];
    if (!entry) return { ok: false, error: `unknown body '${bodyId}'` };
    if (this.switching) return { ok: false, error: 'a body switch is already in progress' };
    if (this.active?.bodyId === bodyId && !this.active.dead) {
      return { ok: true, body: bodyId, already: true };
    }
    if (!this.installed[bodyId]) {
      return { ok: false, error: `body '${bodyId}' is not installed`, hint: entry.installHint };
    }
    const facts = this.registry.get(bodyId);
    const elig = eligible(facts, { requiredCapabilities: this.profile });
    if (!elig.eligible) {
      return { ok: false, error: 'fail-closed: body cannot hold required invariants', failClosed: elig.failClosed, degraded: elig.degraded };
    }
    if (!entry.channel) {
      return { ok: false, error: `body '${bodyId}' has no session channel`, hint: 'it can still receive handoff/task effects; a session channel is not implemented yet' };
    }

    this.switching = true;
    this.#emitSupervisor('select_start', { to: bodyId });
    try {
      const state = await this.sendToBody({ type: 'get_state' }, 15_000);
      const hasSession = (state?.data?.messageCount ?? 0) > 0;
      if (!hasSession) {
        const from = this.active?.bodyId ?? null;
        await this.gracefulShutdown();
        await this.spawnBody(bodyId);
        this.audit.write({ kind: 'BODY_SWITCHED', data: { mode: 'cold', from, to: bodyId } });
        this.#emitSupervisor('select_done', { to: bodyId, mode: 'cold' });
        return { ok: true, body: bodyId, mode: 'cold' };
      }
      return await this.#hotSwitch(bodyId);
    } catch (e) {
      this.#emitSupervisor('select_failed', { to: bodyId, error: e?.message ?? String(e) });
      return { ok: false, error: e?.message ?? String(e) };
    } finally {
      this.switching = false;
    }
  }

  /** The seven-phase cold handoff, driven for real against live stores. */
  async #hotSwitch(to) {
    const from = this.active.bodyId;
    const hid = `ho-${randomUUID().slice(0, 8)}`;
    const phase = (p, detail = {}) => this.#emitSupervisor('handoff_phase', { handoffId: hid, phase: p, ...detail });
    const fail = (reason) => {
      // verify({}) marks the record failed — every required gate missing is a
      // missing check, and missing checks fail closed by contract.
      try { this.handoffs.verify(hid, {}); } catch { /* record may predate checkpoint */ }
      this.audit.write({ kind: 'BODY_SWITCH_FAILED', data: { handoffId: hid, from, to, reason } });
      phase('failed', { reason });
      return { ok: false, error: reason, handoffId: hid };
    };

    this.handoffs.begin({ handoffId: hid, fromBody: from, toBody: to });
    phase('prepared');

    const prep = await this.sendToBody({ type: 'handoff_prepare' }, 30_000);
    if (!prep.success) return fail(`handoff_prepare refused: ${prep.error}`);
    this.handoffs.quiesce(hid, prep.data);
    phase('quiesced');

    const exp = await this.sendToBody({ type: 'handoff_export' }, 15_000);
    if (!exp.success) return fail(`handoff_export refused: ${exp.error}`);
    const { envelope } = this.handoffs.checkpoint(hid, exp.data);
    phase('checkpointed');

    const rel = await this.sendToBody({ type: 'handoff_release' }, 15_000);
    if (!rel.success) return fail(`handoff_release refused: ${rel.error}`);
    this.handoffs.release(hid, rel.data?.released ?? []);
    phase('released');
    await this.gracefulShutdown(); // old body gone before the new one acquires

    try {
      await this.spawnBody(to);
    } catch (e) {
      // Rollback: leave the user with a working body, not a dead shell.
      let rollback = `source body also failed: ${e?.message ?? e}`;
      try { await this.spawnBody(from); rollback = `rolled back to ${from}`; } catch { /* both down */ }
      return fail(`target body '${to}' failed to start (${e?.message ?? e}); ${rollback}`);
    }
    const info = this.active.info;
    const newOwner = `${to}:${info?.runId}`;

    const heldLeases = prep.data?.heldLeases ?? [];
    const acquired = [];
    for (const l of heldLeases) {
      // A body that holds its own writer authority (pi does at boot) has
      // already re-acquired the lease — verify the baton, don't re-claim.
      const held = this.leases.heldBy({ scope: l.scope, name: l.name });
      if (held?.status === 'active' && held.owner === newOwner && !held.stale) {
        acquired.push(held);
        continue;
      }
      const c = this.leases.claim({ scope: l.scope, name: l.name, owner: newOwner, ttlSeconds: 8 });
      if (!c.ok) return fail(`lease ${l.scope}/${l.name} not acquired: held by ${c.heldBy?.owner}`);
      acquired.push(c.lease);
    }
    this.handoffs.acquire(hid, { byBody: to, leases: acquired });
    phase('acquired', { owner: newOwner });
    this.handoffs.resume(hid);
    phase('resumed');

    // verify — all five gates recomputed against real stores
    const policy = loadPolicy(this.paths.canonicalDir);
    const predictions = new PredictionStore(this.paths.worldModelDir);
    const cursor = `sha256:${sha256(JSON.stringify(predictions.openPredictions()))}`;
    const checks = {
      policyIdentity: `sha256:${policy.checksum}` === envelope.policyIdentity,
      stateCursor: cursor === envelope.canonicalCursor
        && (envelope.openPredictions ?? []).every((id) => predictions.openPredictions().some((p) => p.id === id)),
      provenanceParent: (envelope.provenanceChain ?? []).at(-1) === envelope.source?.run
        && envelope.source?.run === prep.data?.runId,
      writerLease: heldLeases.every((l) => {
        const h = this.leases.heldBy({ scope: l.scope, name: l.name });
        return h?.status === 'active' && h.owner === newOwner && !h.stale;
      }),
      capabilityCoverage: eligible(this.registry.get(to), { requiredCapabilities: this.profile }).eligible,
    };
    const verdict = this.handoffs.verify(hid, checks);
    if (!verdict.ok) {
      this.audit.write({ kind: 'BODY_SWITCH_FAILED', data: { handoffId: hid, from, to, failures: verdict.failures } });
      phase('failed', { failures: verdict.failures });
      return { ok: false, error: `handoff verify failed: ${verdict.failures.join(', ')}`, handoffId: hid, failures: verdict.failures };
    }
    this.audit.write({ kind: 'BODY_SWITCHED', data: { mode: 'handoff', handoffId: hid, from, to } });
    phase('verified');
    return { ok: true, body: to, mode: 'handoff', handoffId: hid };
  }

  /** One merged command surface for the UI. */
  async handle(cmd) {
    const reply = (success, data, error, extra = {}) =>
      ({ id: cmd?.id, type: 'response', command: cmd?.type, success, ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}), ...extra });
    try {
      switch (cmd?.type) {
        case 'body_list':
          return reply(true, this.bodyList());
        case 'body_current':
          return reply(true, {
            body_id: this.active?.bodyId ?? null,
            runId: this.active?.info?.runId ?? null,
            sessionId: this.active?.info?.sessionId ?? null,
            switching: this.switching,
          });
        case 'eligibility_preview': {
          const task = cmd.task ?? { requiredCapabilities: this.profile };
          const results = {};
          for (const b of this.registry.list()) results[b.body_id] = eligible(b, task);
          return reply(true, results);
        }
        case 'body_select': {
          const r = await this.selectBodyCmd(String(cmd.body_id ?? ''));
          return reply(r.ok, r.ok ? r : undefined, r.ok ? undefined : r.error, r.ok ? {} : r);
        }
        case 'handoff_status': {
          if (cmd.handoff_id) return reply(true, this.handoffs.status(cmd.handoff_id));
          return reply(true, { pending: this.handoffs.pending() });
        }
        case 'backup_status': {
          const st = await this.#backupTick(Boolean(cmd.force));
          return reply(true, { ...(st ?? {}), running: this.#backupState.running });
        }
        case 'governance_status': {
          const st = await this.#govTick(Boolean(cmd.force));
          return reply(true, { ...(st ?? {}), running: this.#govState.running });
        }
        case 'supervisor_status': {
          const repoCommit = readRepoCommit(this.repoRoot);
          return reply(true, {
            instanceRoot: this.instanceRoot,
            workdir: this.workdir,
            active: this.active?.bodyId ?? null,
            switching: this.switching,
            installed: this.installed,
            version: {
              bootCommit: this.bootCommit ?? null,
              repoCommit,
              // repo moved after this process booted → running stale code
              stale: Boolean(this.bootCommit && repoCommit && repoCommit !== this.bootCommit),
            },
          });
        }
        // World-model surface (spec docs/app-world-model-loop.md §4.3 #1):
        // open predictions + recent observations are ALREADY in the instance —
        // this case is the projection, not the ledger. Read locally (Option A):
        // the data survives a dead body, and this layer is where host + body
        // may both be known. Reads go through the stores' recent()/list() —
        // never readFileSync — because their (size,mtime) fingerprint cache is
        // the budget.js-tested guard against per-poll full scans.
        case 'world_model_status': {
          const n = Math.min(Math.max(Number(cmd.limit) || 20, 1), 200);
          const preds = new PredictionStore(this.paths.worldModelDir);
          const obs = new ObservationStore(this.paths.worldModelDir);
          const open = preds.openPredictions();
          const recent = obs.recent(n);
          // §4.3 #2/#3 — the COMPILED projections, not the governed source
          // files: briefing.md is canonical_compile's 7-section output
          // (§1 residuals / §2 reliability alerts / §3 best models+falsifiers);
          // runtime-state.json is its machine twin. Both are read-only compiled
          // artifacts — absent means "canonical never compiled", surfaced
          // honestly as null rather than an empty fabrication.
          let briefing = null;
          let runtimeState = null;
          const proposals = [];
          try {
            const bp = join(this.paths.canonicalDir, 'briefing.md');
            if (existsSync(bp)) briefing = readFileSync(bp, 'utf8');
            const sp = join(this.paths.canonicalDir, 'runtime-state.json');
            if (existsSync(sp)) {
              const st = JSON.parse(readFileSync(sp, 'utf8'));
              runtimeState = {
                compiled_at: st.compiled_at ?? null,
                theory_version: st.theory_version ?? null,
                schema_version: st.schema_version ?? null,
                continuity_epoch: st.continuity_epoch ?? null,
                lineage_head: st.lineage_head ?? null,
                active_body: st.active_body ?? null,
              };
            }
            // T4 (docs/user-and-tasks.md): pending governance proposals are the
            // owner's adjudication queue. Small bounded dir — read directly;
            // a torn/foreign file is skipped, never fatal.
            const pdir = join(this.paths.canonicalDir, 'proposals');
            if (existsSync(pdir)) {
              for (const f of readdirSync(pdir)) {
                if (!f.endsWith('.json')) continue;
                try {
                  const p = JSON.parse(readFileSync(join(pdir, f), 'utf8'));
                  proposals.push({
                    file: f, kind: p.kind ?? null, status: p.status ?? null,
                    timestamp: p.timestamp ?? null,
                    title: p.payload?.candidate?.proposition ?? p.payload?.kind ?? f,
                    confidence: p.payload?.candidate?.confidence ?? null,
                    level: p.payload?.candidate?.abstraction_level ?? null,
                    // PRD F06: 每条提案必须能回答"适用哪些情形、什么证据会使它失效"
                    scope: p.payload?.candidate?.scope ?? null,
                    falsifier: p.payload?.candidate?.falsifier ?? null,
                    // F06 分级可核实（A08）：裁决时间 + 落定的 model id，
                    // stage 在下方与编译投影对照后判定
                    decisionTs: p.decision?.ts ?? null,
                    appliedModel: p.decision?.applied_model ?? null,
                  });
                } catch { /* torn write — skip */ }
              }
              proposals.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
              // F06 后续使用证据环（A08）：提案 → 裁决 → 写入 → 编译 → 后续使用。
              // 编译投影在裁决之后生成且简报含该模型 id = 后续会话将读到它。
              for (const p of proposals) {
                if (p.status === 'rejected') { p.stage = 'rejected'; continue; }
                if (p.status === 'proposed') { p.stage = 'pending'; continue; }
                if ((p.status === 'accepted' || p.status === 'provisional') && p.appliedModel) {
                  const compiledAfter = runtimeState?.compiled_at && p.decisionTs
                    && Date.parse(runtimeState.compiled_at) >= Date.parse(p.decisionTs);
                  p.stage = (compiledAfter && briefing && briefing.includes(p.appliedModel)) ? 'compiled' : 'written';
                } else p.stage = 'unknown';
              }
            }
          } catch { /* compiled artifacts absent or torn — report what exists */ }
          // PRD F06「本周新增」分面：候选（proposals/ 时间戳）· 生效（u1_accept
          // 的真实写入记录 history/model-updates.jsonl）· 修订（同 model_id
          // 的重复 U1_APPLY）· 否决。生效数以写入账本为准，不以提案状态冒充。
          let weekly = null;
          try {
            const cutoff = Date.now() - 7 * 86400_000;
            const within = (ts) => { const t = Date.parse(ts ?? ''); return Number.isFinite(t) && t >= cutoff; };
            const appliedLog = join(this.paths.canonicalDir, 'history', 'model-updates.jsonl');
            const appliedIds = new Set();
            let applied = 0; let revised = 0;
            if (existsSync(appliedLog)) {
              // Bounded tail read: the log is append-only and unbounded; the
              // weekly window never needs more than the recent tail.
              const stat = statSync(appliedLog);
              let text;
              if (stat.size > 512 * 1024) {
                const fd = openSync(appliedLog, 'r');
                try {
                  const buf = Buffer.alloc(512 * 1024);
                  readSync(fd, buf, 0, buf.length, stat.size - buf.length);
                  text = buf.toString('utf-8');
                  text = text.slice(text.indexOf('\n') + 1); // drop the torn first line
                } finally { closeSync(fd); }
              } else {
                text = readFileSync(appliedLog, 'utf-8');
              }
              const entries = text.split('\n').filter(Boolean)
                .map((l) => { try { return JSON.parse(l); } catch { return null; } })
                .filter((e) => e?.kind === 'U1_APPLY');
              for (const e of entries) {
                if (within(e.ts)) {
                  applied += 1;
                  if (appliedIds.has(e.model_id)) revised += 1;
                }
                appliedIds.add(e.model_id);
              }
            }
            weekly = {
              proposed: proposals.filter((p) => within(p.timestamp) && p.status === 'proposed').length,
              rejected: proposals.filter((p) => within(p.timestamp) && p.status === 'rejected').length,
              applied,
              revised,
              compiledAt: runtimeState?.compiled_at ?? null,
            };
          } catch { weekly = null; /* honest absence over a fabricated zero */ }
          return reply(true, {
            openPredictions: open.map((p) => ({
              id: p.id, claim: p.claim ?? null, irreversible: Boolean(p.irreversible), at: p.at ?? null,
            })),
            observations: recent.map((o) => ({
              id: o.id, kind: o.kind, subject: o.subject, actor: o.actor ?? null, at: o.at ?? null,
            })),
            briefing,
            runtimeState,
            proposals,
            weekly,
            counts: { openPredictions: open.length, observationsReturned: recent.length },
          });
        }
        // PRD F06 纠正已生效认知：主人从认知页对一条现行模型「提出修正」。
        // 这里创建的是提案（canonical/proposals/ 是治理收件箱，distiller 也
        // 写这里），不是 canonical 状态本身——终审仍走 proposal_decide →
        // u1_accept，同 candidate_id 的 MODEL_PROPOSAL 采纳后覆盖式修订
        // current.yaml（自动留回滚备份）。UI 与 app 都不直接写认知状态。
        case 'proposal_correct': {
          const modelId = String(cmd.model_id ?? '');
          if (!/^[A-Za-z0-9][\w.-]{0,63}$/.test(modelId)) {
            return reply(false, undefined, 'proposal_correct: invalid model_id');
          }
          const proposition = String(cmd.proposition ?? '').trim();
          if (!proposition || proposition.length > 2000) {
            return reply(false, undefined, 'proposal_correct: proposition required (≤2000 chars)');
          }
          const reason = String(cmd.reason ?? '').slice(0, 500);
          const proposalsDir = join(this.paths.canonicalDir, 'proposals');
          mkdirSync(proposalsDir, { recursive: true });
          const file = `${new Date().toISOString().slice(0, 10)}-model-proposal-owner-correct-${modelId}-${randomUUID().slice(0, 8)}.json`;
          const doc = {
            schema_version: '1.2',
            kind: 'MODEL_PROPOSAL',
            timestamp: new Date().toISOString(),
            status: 'proposed',
            payload: {
              candidate: {
                candidate_id: modelId,
                proposition,
                confidence: 'low',
                abstraction_level: null,
                scope: null,
                falsifier: cmd.falsifier ? String(cmd.falsifier).slice(0, 500) : null,
                supporting: { evidence_refs: ['owner-correction'], episode_refs: [] },
                promoted_from: null,
              },
            },
            provenance: { actor: 'owner-app', kind: 'owner_correction', reason },
          };
          writeFileSync(join(proposalsDir, file), JSON.stringify(doc, null, 2));
          this.audit.write({ kind: 'PROPOSAL_CREATED', data: { file, modelId, actor: 'owner-app' } });
          return reply(true, { file, modelId });
        }
        // T4 (docs/user-and-tasks.md): the owner adjudicates a pending proposal
        // from the UI. The app NEVER writes canonical itself — it shells out to
        // mind/u1_accept.py, the sole governed writer (kind whitelist, rollback
        // backup, provisional state). reject is sidecar-only per the tool.
        case 'proposal_decide': {
          const file = String(cmd.file ?? '');
          if (!/^[\w.-]+\.json$/.test(file)) return reply(false, undefined, 'proposal_decide: invalid proposal file name');
          const decision = String(cmd.decision ?? '');
          if (!['accept', 'provisional', 'reject'].includes(decision)) {
            return reply(false, undefined, `proposal_decide: invalid decision '${decision}'`);
          }
          if (!existsSync(join(this.paths.canonicalDir, 'proposals', file))) {
            return reply(false, undefined, `proposal not found: ${file}`);
          }
          const py = this.env.PAI_PYTHON ?? 'python';
          const out = await new Promise((res) => {
            const child = spawn(py, [join(this.repoRoot, 'mind', 'u1_accept.py'),
              '--canonical', this.paths.canonicalDir, '--proposal', file,
              '--decision', decision, '--reason', String(cmd.reason ?? ''),
              '--authority', 'owner-app'], { env: this.env });
            let stdout = ''; let stderr = '';
            child.stdout.on('data', (d) => { stdout += d; });
            child.stderr.on('data', (d) => { stderr += d; });
            child.on('error', (e) => res({ rc: -1, stdout, stderr: String(e) }));
            child.on('close', (rc) => res({ rc, stdout, stderr }));
          });
          if (out.rc !== 0) {
            return reply(false, undefined,
              `u1_accept ${decision} failed: ${(out.stderr || out.stdout).trim().slice(-300)}`);
          }
          this.audit.write({ kind: 'PROPOSAL_DECIDED', data: { file, decision, authority: 'owner-app' } });
          // F06 证据环的闭环动作：采纳/暂存后立即重编译简报（wm_cycle 幂等
          // 且非重入），不等 30 分钟调度——裁决到"后续会话可用"的时延归零。
          if (decision !== 'reject') this.#cogTick(true).catch(() => {});
          return reply(true, { file, decision });
        }
        // 主人在认知卡点"立即提炼"——手动触发一次 wm_cycle（同自动调度路径）
        case 'cognition_run': {
          await this.#cogTick(true);
          return reply(true, { ran: true });
        }
        case 'set_workdir': {
          const dir = String(cmd.path ?? cmd.workdir ?? '').trim();
          if (!dir) return reply(false, undefined, 'set_workdir requires {path}');
          if (!existsSync(dir)) return reply(false, undefined, `directory not found: ${dir}`);
          if (dir === this.workdir) return reply(true, { workdir: dir, already: true });
          this.workdir = dir;
          this.#saveConfig();
          this.#touchWorkspace(dir);
          this.audit.write({ kind: 'WORKDIR_CHANGED', data: { workdir: dir } });
          this.#emitSupervisor('workdir_changed', { workdir: dir });
          // Respawn the live body on the new workdir — sessions/tools bind cwd.
          const bodyId = this.active?.bodyId;
          if (bodyId && !this.active.dead) {
            await this.gracefulShutdown();
            await this.spawnBody(bodyId);
          }
          return reply(true, { workdir: dir });
        }
        case 'workspace_list': {
          return reply(true, {
            active: this.workdir,
            workspaces: this.#workspaces()
              .map((w) => ({ ...w, exists: existsSync(w.path), active: w.path === this.workdir }))
              .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)),
          });
        }
        case 'workspace_add': {
          const dir = String(cmd.path ?? '').trim();
          if (!dir) return reply(false, undefined, 'workspace_add requires {path}');
          if (!existsSync(dir) || !statSync(dir).isDirectory()) return reply(false, undefined, `not a directory: ${dir}`);
          this.#touchWorkspace(dir);
          return reply(true, { workspaces: this.#workspaces() });
        }
        case 'workspace_remove': {
          const dir = String(cmd.path ?? '').trim();
          if (dir === this.workdir) return reply(false, undefined, 'cannot remove the active workspace — switch away first');
          this.#saveWorkspaces(this.#workspaces().filter((w) => w.path !== dir));
          return reply(true, { workspaces: this.#workspaces() });
        }
        case 'files_list': {
          // @-reference picker: bounded recursive walk of the workdir.
          // .paiignore entries are pruned — excluded names never reach the picker.
          const ignore = new PaiIgnore(this.workdir);
          const prefix = String(cmd.prefix ?? '').toLowerCase();
          const out = [];
          const skip = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', '.taskflow']);
          const walk = (dir, rel) => {
            if (out.length >= 500) return;
            let ents;
            try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of ents) {
              if (out.length >= 500) return;
              // Dotfiles stay hidden from the picker — except .pai, the
              // project's own config tree: /recipe, /plans and @.pai mentions
              // all resolve through this listing.
              if (e.name.startsWith('.') && e.name !== '.pai') continue;
              const r = rel ? `${rel}/${e.name}` : e.name;
              if (ignore.isIgnored(join(this.workdir, r))) continue;
              if (e.isDirectory()) { if (!skip.has(e.name)) walk(join(dir, e.name), r); }
              else out.push(r);
            }
          };
          walk(this.workdir, '');
          const files = prefix ? out.filter((f) => f.toLowerCase().includes(prefix)) : out;
          return reply(true, { files: files.slice(0, 200), total: out.length });
        }
        case 'file_read': {
          // @-attachment resolution: read a file under the workdir so the
          // composer can inline its content into the outgoing prompt.
          // Boundary is checked on REAL paths — a symlink inside the workdir
          // must not be able to point outside it.
          //
          // Order matters: realpath FIRST, existence second. `existsSync` follows
          // symlinks, so probing it on an unresolvable link returns false and we
          // would return `not found` while never running the containment check —
          // i.e. the boundary test would silently not apply to exactly the case
          // it exists for. Resolve first, and treat a resolution failure as a
          // boundary violation rather than a benign miss.
          const rel = String(cmd.path ?? '');
          const abs = resolve(this.workdir, rel);
          let realAbs;
          try {
            realAbs = realpathSync(abs);
          } catch {
            return reply(false, undefined, 'path escapes workdir');
          }
          const wd = realpathSync(this.workdir);
          const inside = process.platform === 'win32'
            ? realAbs.toLowerCase().startsWith(wd.toLowerCase() + sep)
            : realAbs.startsWith(wd + sep);
          if (!inside) return reply(false, undefined, 'path escapes workdir');
          const st = statSync(realAbs);
          if (!st.isFile()) return reply(false, undefined, `not a file: ${rel}`);
          if (new PaiIgnore(this.workdir).isIgnored(abs)) {
            return reply(false, undefined, `'${rel}' is excluded by .paiignore`);
          }
          if (st.size > 512 * 1024) return reply(false, undefined, `file too large for inline attach (>512KB): ${rel}`);
          return reply(true, { path: rel, content: readFileSync(realAbs, 'utf-8'), bytes: st.size });
        }
        case 'session_pin': {
          const m = this.#setSessMeta(String(cmd.path ?? ''), { pinned: cmd.pinned !== false });
          return m ? reply(true, { meta: m }) : reply(false, undefined, 'session_pin requires {path}');
        }
        case 'session_archive': {
          const m = this.#setSessMeta(String(cmd.path ?? ''), { archived: cmd.archived !== false });
          return m ? reply(true, { meta: m }) : reply(false, undefined, 'session_archive requires {path}');
        }
        case 'session_set_project': {
          const p = String(cmd.path ?? cmd.id ?? '');
          const cwd = String(cmd.cwd ?? cmd.workdir ?? '').trim();
          if (!p) return reply(false, undefined, 'session_set_project requires {path}');
          const m = this.#setSessMeta(p, { cwd });
          if (cmd.id && String(cmd.id) !== p) {
            this.#setSessMeta(String(cmd.id), { cwd });
          }
          return m ? reply(true, { meta: m }) : reply(false, undefined, 'session_set_project failed');
        }
        // ZCode auto-archive candidates, one-click form: archive every
        // unpinned, unarchived session idle longer than {days} (default 14).
        // Reversible via unarchive — sweep never deletes.
        case 'session_sweep': {
          const days = Number(cmd.days) > 0 ? Number(cmd.days) : 14;
          const cutoff = Date.now() - days * 86400_000;
          const r = await this.sendToBody({ type: 'session_list' });
          if (!r.success || !Array.isArray(r.data)) return r;
          const meta = this.#sessMeta();
          const swept = [];
          for (const s of r.data) {
            if (meta[s.path]?.pinned || meta[s.path]?.archived) continue;
            const idle = Date.parse(s.modified ?? s.created ?? '');
            if (Number.isFinite(idle) && idle < cutoff) {
              this.#setSessMeta(s.path, { archived: true });
              swept.push(s.path);
            }
          }
          return reply(true, { swept: swept.length, paths: swept, days });
        }
        // ZCode archived-bulk-delete analogue: permanently delete every
        // archived, unpinned session. Irreversible — the caller (UI) confirms.
        case 'session_purge': {
          const r = await this.sendToBody({ type: 'session_list' });
          if (!r.success || !Array.isArray(r.data)) return r;
          const meta = this.#sessMeta();
          const purged = [];
          const failed = [];
          for (const s of r.data) {
            const m = meta[s.path];
            if (!m?.archived || m?.pinned) continue;
            const d = await this.sendToBody({ type: 'session_delete', path: s.path });
            if (d.success) { purged.push(s.path); delete meta[s.path]; }
            else failed.push(s.path);
          }
          if (purged.length) this.#saveSessMeta(meta);
          return reply(true, { purged: purged.length, paths: purged, failed });
        }
        case 'session_delete': {
          if (!cmd.path) return reply(false, undefined, 'session_delete requires {path}');
          // If the target file doesn't exist on disk (e.g. newly created empty session with 0 messages),
          // deleting it is an idempotent success — remove metadata and switch away if active.
          if (!existsSync(cmd.path)) {
            const meta = this.#sessMeta();
            if (meta[cmd.path]) {
              delete meta[cmd.path];
              this.#saveSessMeta(meta);
            }
            if (this.lastSessionFile && (this.lastSessionFile === cmd.path || resolve(this.lastSessionFile) === resolve(cmd.path))) {
              this.lastSessionFile = null;
            }
            return reply(true, { deleted: false, reason: 'file_not_found' });
          }
          // If the target session is currently active in the body, switch away to a new session first
          // so the body's remove() does not throw 'cannot delete the active session'
          if (this.lastSessionFile && (this.lastSessionFile === cmd.path || resolve(this.lastSessionFile) === resolve(cmd.path))) {
            const nw = await this.sendToBody({ type: 'session_new' });
            if (nw.success && nw.data) {
              const f = nw.data.session?.file ?? nw.data.file;
              if (f) this.lastSessionFile = f;
            }
          }
          const r = await this.sendToBody(cmd);
          if (r.success) {
            const meta = this.#sessMeta();
            if (meta[cmd.path]) {
              delete meta[cmd.path];
              this.#saveSessMeta(meta);
            }
          }
          return r;
        }
        case 'session_list': {
          const r = await this.sendToBody(cmd);
          if (r.success && Array.isArray(r.data)) {
            const meta = this.#sessMeta();
            r.data = r.data.map((s) => ({
              ...s,
              ...((meta[s.path] ?? meta[s.id]) ?? {}),
            }));
          }
          return r;
        }
        case 'macro_list':
          return reply(true, { macros: this.#macros() });
        case 'macro_save': {
          const name = String(cmd.name ?? '').trim();
          const text = String(cmd.text ?? '');
          if (!/^[a-zA-Z][\w-]{0,31}$/.test(name)) return reply(false, undefined, 'macro name: letters/digits/-_, starts with a letter, ≤32 chars');
          if (!text.trim()) return reply(false, undefined, 'macro_save requires {text}');
          const macros = this.#macros();
          macros[name] = text;
          this.#saveMacros(macros);
          this.audit.write({ kind: 'MACRO_SAVED', data: { name } });
          return reply(true, { name, count: Object.keys(macros).length });
        }
        case 'macro_delete': {
          const name = String(cmd.name ?? '');
          const macros = this.#macros();
          if (!(name in macros)) return reply(false, undefined, `no macro '${name}'`);
          delete macros[name];
          this.#saveMacros(macros);
          this.audit.write({ kind: 'MACRO_DELETED', data: { name } });
          return reply(true, { deleted: name });
        }
        // PRD F03/A05 — prompt idempotency + receipt-loss reconciliation.
        // The UI stamps every prompt with a client_msg_id; this case is the
        // choke point that guarantees one id executes at most once, and turns
        // a lost receipt into an explicit `uncertain` state the owner must
        // reconcile (prompt_reconcile) instead of blindly resending.
        case 'prompt': {
          // Same guard the default branch applies: never dispatch mid-switch.
          if (this.switching) return reply(false, undefined, 'body switch in progress — try again after it completes');
          const clientMsgId = (typeof cmd.client_msg_id === 'string' && /^[\w-]{8,64}$/.test(cmd.client_msg_id))
            ? cmd.client_msg_id : null;
          if (!clientMsgId) return this.sendToBody(cmd, this.promptTimeoutMs); // legacy callers
          const prior = this.promptLedger.get(clientMsgId);
          if (prior) {
            if (prior.status === 'in_flight' && prior.promise) {
              const r = await prior.promise; // attach — never re-executed
              return { ...r, id: cmd.id, deduplicated: true };
            }
            if (prior.status === 'completed') {
              return { ...(prior.response ?? { success: true }), id: cmd.id, type: 'response', command: 'prompt', deduplicated: true };
            }
            if (prior.status === 'uncertain') {
              return reply(false, { clientMsgId, outcome: 'uncertain' },
                '回执丢失：这条消息可能已送达——先「核对」，不要盲目重发',
                { code: 'OUTCOME_UNCERTAIN' });
            }
            // not_delivered: reconcile (or a dead channel at dispatch) proved
            // the body never saw it — fall through and execute again.
          }
          // Content-level safety net: a UI reload mints a NEW client_msg_id,
          // so id-dedup alone cannot catch "the owner retyped/resent the same
          // message after a lost receipt". A recent uncertain entry with the
          // SAME message hash is treated as the same logical send — reconcile
          // the original id instead of executing a possible duplicate.
          const messageHash = sha256(String(cmd.message ?? ''));
          const twin = [...this.promptLedger.values()].find((e) =>
            e.status === 'uncertain' && e.messageHash === messageHash
            && Date.now() - Date.parse(e.startedAt) < 30 * 60_000);
          if (twin) {
            return reply(false, { clientMsgId: twin.clientMsgId, outcome: 'uncertain' },
              '回执丢失：一条内容相同的消息可能已送达——先「核对」，不要盲目重发',
              { code: 'OUTCOME_UNCERTAIN' });
          }
          const message = String(cmd.message ?? '');
          const entry = {
            clientMsgId,
            messageHash,
            // 留存原文（≤4000 字符）使跨重启的"核对→安全重发"成为可能；
            // 会话 JSONL 本就保存全文，这里不引入新的暴露面。
            message: message.slice(0, 4000),
            messageTruncated: message.length > 4000,
            preview: message.slice(0, 80),
            sessionFile: this.lastSessionFile ?? null, // 核对时校验会话未切换
            status: 'in_flight',
            startedAt: new Date().toISOString(),
            completedAt: null,
            response: null,
            promise: null,
          };
          this.promptLedger.set(clientMsgId, entry);
          this.#savePromptLedger();
          this.audit?.write?.({ kind: 'PROMPT_DISPATCH', data: { clientMsgId, messageHash: entry.messageHash } });
          const exec = this.sendToBody(cmd, this.promptTimeoutMs);
          entry.promise = exec;
          const r = await exec;
          entry.promise = null;
          entry.completedAt = new Date().toISOString();
          if (r.success) {
            entry.status = 'completed';
            entry.response = { success: true, data: r.data };
          } else if (r.error === 'no live body') {
            // Refused BEFORE anything touched stdin — definitively not executed.
            entry.status = 'not_delivered';
          } else if (r.error === 'body command timed out' || r.error === 'body process exited') {
            // Written to the channel; the receipt never came back.
            entry.status = 'uncertain';
          } else {
            // The body ANSWERED with a refusal — that answer IS the receipt.
            entry.status = 'completed';
            entry.response = { success: false, error: r.error };
          }
          this.#savePromptLedger();
          if (entry.status === 'uncertain') {
            this.audit?.write?.({ kind: 'PROMPT_OUTCOME_UNCERTAIN', data: { clientMsgId, transportError: r.error } });
            return reply(false, { clientMsgId, outcome: 'uncertain' },
              `回执丢失：消息已发出但结果未确认（${r.error}）——先「核对」，不要盲目重发`,
              { code: 'OUTCOME_UNCERTAIN' });
          }
          return r;
        }
        // A05 核对: did an `uncertain` prompt actually land in the session?
        // Compares the ledger's message hash against the live session history;
        // honest about the unverifiable case instead of guessing.
        case 'prompt_reconcile': {
          const clientMsgId = String(cmd.client_msg_id ?? '');
          const entry = this.promptLedger.get(clientMsgId);
          if (!entry) return reply(true, { clientMsgId, status: 'unknown_id' });
          if (entry.status !== 'uncertain') {
            return reply(true, { clientMsgId, status: entry.status, completedAt: entry.completedAt ?? null, reconciled: false });
          }
          if (!this.active || this.active.dead) {
            return reply(true, { clientMsgId, status: 'unverifiable',
              reason: '身体进程不在运行——无法核对它死前是否已执行；请人工确认后再决定（重发可能重复）' });
          }
          // 会话切换护栏：核对只能在"当时那个会话"里进行——换了会话，
          // 当前会话历史里查不到不构成"未送达"的证据。
          if (entry.sessionFile) {
            const st = await this.sendToBody({ type: 'get_state' }, 15_000);
            const currentFile = st?.data?.session?.file ?? null;
            if (st.success && currentFile && currentFile !== entry.sessionFile) {
              return reply(true, { clientMsgId, status: 'unverifiable',
                reason: '会话已切换——当时的消息属于另一个会话，无法在此核对；请切回原会话后再核对' });
            }
          }
          const hist = await this.sendToBody({ type: 'session_history' }, 15_000);
          if (!hist.success || !Array.isArray(hist.data)) {
            return reply(true, { clientMsgId, status: 'unverifiable', reason: hist.error ?? 'session history unavailable' });
          }
          const flatText = (m) => {
            const c = m?.text ?? m?.content ?? m?.message?.content;
            if (typeof c === 'string') return c;
            if (Array.isArray(c)) return c.map((p) => p?.text ?? '').join('\n');
            return '';
          };
          const hit = hist.data.some((m) =>
            (m?.role ?? m?.message?.role) === 'user'
            && (sha256(flatText(m)) === entry.messageHash
              || (entry.preview && flatText(m).slice(0, 80) === entry.preview)));
          entry.status = hit ? 'completed' : 'not_delivered';
          entry.reconciled = hit ? 'delivered' : 'not_delivered';
          entry.completedAt = new Date().toISOString();
          this.#savePromptLedger();
          this.audit?.write?.({ kind: 'PROMPT_RECONCILED', data: { clientMsgId, result: entry.status } });
          return reply(true, { clientMsgId, status: entry.status, reconciled: true,
            // 未送达时把留存的原文交回 UI，跨重启也能安全重发
            ...(entry.status === 'not_delivered' && entry.message ? { message: entry.message, messageTruncated: entry.messageTruncated } : {}) });
        }
        // F03 续接核对：重启后哪些 prompt 的回执从未确认（UI 启动时拉一次）
        case 'prompt_ledger_pending': {
          const pending = [...this.promptLedger.values()]
            .filter((e) => e.status === 'uncertain')
            .map(({ clientMsgId, preview, startedAt, sessionFile }) => ({ clientMsgId, preview, startedAt, sessionFile }));
          return reply(true, { pending });
        }
        default: {
          if (this.switching && [
            'steer', 'abort',
            'session_new', 'session_switch', 'session_rename',
            'model_set', 'thinking_set', 'auth_set_key', 'auth_clear',
          ].includes(cmd?.type)) {
            return reply(false, undefined, 'body switch in progress — try again after it completes');
          }
          // Turn-scoped commands block until the run ends — the default 60s
          // body timeout would falsely report "timed out" on any long turn
          // while the run is actually still going. Progress streams via
          // events; abort is always available. 10min is the ceiling.
          // ('prompt' is handled by its own ledger case above, which uses
          // this.promptTimeoutMs for the same reason.)
          if (cmd?.type === 'session_switch') {
            const raw = String(cmd.path ?? cmd.id ?? '').trim();
            if (raw) {
              const sessDir = join(this.instanceRoot, 'sessions');
              if (!isAbsolute(raw)) {
                const candidate = join(sessDir, raw.endsWith('.jsonl') ? raw : `${raw}.jsonl`);
                if (existsSync(candidate)) {
                  cmd.path = candidate;
                } else {
                  try {
                    const files = readdirSync(sessDir);
                    const matched = files.find((f) => f.includes(raw));
                    if (matched) cmd.path = join(sessDir, matched);
                  } catch {}
                }
              }
            }
          }

          const SLOW = new Set(['steer', 'session_compact']);
          const r = await this.sendToBody(cmd, SLOW.has(cmd?.type) ? 600_000 : 60_000);
          // Workdir is supervisor-owned state — the body's get_state doesn't
          // know it, so inject it for statusline/settings consumers.
          if (cmd?.type === 'get_state' && r.success && r.data && typeof r.data === 'object') {
            r.data.workdir = this.workdir;
          }
          // Track the live session file: prompt ledger entries stamp it at
          // dispatch so reconcile can detect a session switch (F03 护栏).
          if (r.success && r.data && typeof r.data === 'object') {
            const f = r.data.session?.file ?? r.data.file;
            if ((cmd?.type === 'get_state' || cmd?.type === 'session_switch' || cmd?.type === 'session_new') && f) {
              this.lastSessionFile = f;
            }
            if (cmd?.type === 'session_new') {
              if (f && !r.data.path) r.data.path = f;
              const bindCwd = String(cmd.cwd ?? cmd.workdir ?? this.workdir ?? '').trim();
              if (bindCwd) {
                if (f) this.#setSessMeta(f, { cwd: bindCwd });
                if (r.data.id) this.#setSessMeta(r.data.id, { cwd: bindCwd });
              }
            }
          }
          return r;
        }
      }
    } catch (e) {
      return reply(false, undefined, e?.message ?? String(e));
    }
  }

  async dispose() {
    this._disposing = true;
    if (this.#backupTimer) { clearInterval(this.#backupTimer); this.#backupTimer = null; }
    if (this.#govTimer) { clearInterval(this.#govTimer); this.#govTimer = null; }
    if (this.#cogTimer) { clearInterval(this.#cogTimer); this.#cogTimer = null; }
    await this.gracefulShutdown();
    this.leases?.close();
    this.listeners.clear();
  }
}
