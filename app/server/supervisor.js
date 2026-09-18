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
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ensureInstance } from './instance.js';
import { bodyCatalog } from './bodies.js';
import { BodyRegistry } from '../../host/src/core/registry.js';
import { DomainLeaseStore } from '../../host/src/core/lease.js';
import { HandoffStore } from '../../host/src/core/handoff.js';
import { PredictionStore } from '../../host/src/core/prediction.js';
import { loadPolicy } from '../../host/src/core/policy.js';
import { eligible } from '../../host/src/core/eligibility.js';
import { AuditWriter } from '../../host/src/core/audit.js';
import { REQUIRED_BODY_CAPABILITIES } from '../../pi/src/bootstrap/facts.js';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BodySupervisor {
  /**
   * @param {object} o
   * @param {string} o.instanceRoot  outside any git worktree
   * @param {string} o.workdir       the body's working directory
   * @param {string} o.repoRoot      repository root
   * @param {object} [o.env]         defaults to process.env
   * @param {object} [o.catalog]     override bodyCatalog (tests inject fakes)
   * @param {Array}  [o.profile]     task profile for eligibility; defaults to
   *                                 the production REQUIRED_BODY_CAPABILITIES
   */
  constructor({ instanceRoot, workdir, repoRoot, env = process.env, catalog = null, profile = null }) {
    this.instanceRoot = instanceRoot;
    this.workdir = workdir;
    this.repoRoot = repoRoot;
    this.env = env;
    this.catalogOverride = catalog;
    this.profile = profile ?? REQUIRED_BODY_CAPABILITIES;
    this.listeners = new Set();
    this.active = null;
    this.switching = false;
    this.installed = {};
    this.configPath = join(instanceRoot, 'app-config.json');
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
      writeFileSync(this.configPath, JSON.stringify({ workdir: this.workdir }, null, 2));
    } catch { /* persistence is best-effort */ }
  }

  #macrosPath() { return join(this.instanceRoot, 'macros.json'); }

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
    this.audit.write({ kind: 'SUPERVISOR_STARTED', data: { body: chosen, installed: this.installed } });
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
    const active = { bodyId, child, pending, seq: 0, stderrTail, info: null, dead: false };
    child.on('exit', () => {
      active.dead = true;
      for (const [, p] of pending) p({ type: 'response', success: false, error: 'body process exited' });
      pending.clear();
      this.#emitSupervisor('body_exited', { body: bodyId });
    });
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
      throw new Error(`body '${bodyId}' channel did not come up: ${info.error ?? stderrTail.join('').slice(-400)}`);
    }
    active.info = info.data;
    this.#emitSupervisor('body_started', { body: bodyId, runId: info.data?.runId });
  }

  /** Graceful channel shutdown: close stdin → body disposes → lease released. */
  async gracefulShutdown() {
    const active = this.active;
    if (!active || active.dead) return;
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
    const predictions = new PredictionStore(this.paths.canonicalDir);
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
        case 'supervisor_status':
          return reply(true, {
            instanceRoot: this.instanceRoot,
            workdir: this.workdir,
            active: this.active?.bodyId ?? null,
            switching: this.switching,
            installed: this.installed,
          });
        case 'set_workdir': {
          const dir = String(cmd.path ?? '').trim();
          if (!dir) return reply(false, undefined, 'set_workdir requires {path}');
          if (!existsSync(dir)) return reply(false, undefined, `directory not found: ${dir}`);
          if (dir === this.workdir) return reply(true, { workdir: dir, already: true });
          this.workdir = dir;
          this.#saveConfig();
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
        case 'files_list': {
          // @-reference picker: bounded recursive walk of the workdir.
          const prefix = String(cmd.prefix ?? '').toLowerCase();
          const out = [];
          const skip = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', '.taskflow']);
          const walk = (dir, rel) => {
            if (out.length >= 500) return;
            let ents;
            try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of ents) {
              if (out.length >= 500) return;
              if (e.name.startsWith('.') && e.name !== '.') continue;
              const r = rel ? `${rel}/${e.name}` : e.name;
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
          const rel = String(cmd.path ?? '');
          const abs = resolve(this.workdir, rel);
          if (!existsSync(abs)) return reply(false, undefined, `not found: ${rel}`);
          const wd = realpathSync(this.workdir);
          const realAbs = realpathSync(abs);
          const inside = process.platform === 'win32'
            ? realAbs.toLowerCase().startsWith(wd.toLowerCase() + sep)
            : realAbs.startsWith(wd + sep);
          if (!inside) return reply(false, undefined, 'path escapes workdir');
          const st = statSync(abs);
          if (!st.isFile()) return reply(false, undefined, `not a file: ${rel}`);
          if (st.size > 512 * 1024) return reply(false, undefined, `file too large for inline attach (>512KB): ${rel}`);
          return reply(true, { path: rel, content: readFileSync(abs, 'utf-8'), bytes: st.size });
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
        default: {
          if (this.switching && [
            'prompt', 'steer', 'abort',
            'session_new', 'session_switch', 'session_rename',
            'model_set', 'thinking_set', 'auth_set_key', 'auth_clear',
          ].includes(cmd?.type)) {
            return reply(false, undefined, 'body switch in progress — try again after it completes');
          }
          const r = await this.sendToBody(cmd);
          // Workdir is supervisor-owned state — the body's get_state doesn't
          // know it, so inject it for statusline/settings consumers.
          if (cmd?.type === 'get_state' && r.success && r.data && typeof r.data === 'object') {
            r.data.workdir = this.workdir;
          }
          return r;
        }
      }
    } catch (e) {
      return reply(false, undefined, e?.message ?? String(e));
    }
  }

  async dispose() {
    await this.gracefulShutdown();
    this.leases?.close();
    this.listeners.clear();
  }
}
