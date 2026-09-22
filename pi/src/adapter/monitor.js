/**
 * Event-driven monitor wake (CodeBuddy Monitor / OpenHands ambient analogue):
 * the scheduler polls; a monitor WATCHES — fs.watch on an operator-declared
 * path fires a governed prompt through the same promptSink as goal ticks
 * (budget admission, audit, governance per tool call). Busy sessions refuse
 * and the event is dropped — monitors are notifications, not queues.
 *
 * Entries are operator-owned (channel commands), never model-spawned — an
 * agent must not arm its own wakeup source.
 *
 * Two hardening properties over the naive watcher:
 *  - RATE CEILING: a chatty watched path (build output, a log under active
 *    append, an attacker-writable directory) would otherwise mint a full
 *    model turn every debounce window while the session sits idle. Each
 *    monitor gets a sliding-window fires-per-hour cap (default 12, per-
 *    monitor max_per_hour override, hard ceiling 120); capped fires are
 *    dropped and audited once per cap-entry, the watcher stays armed.
 *  - DURABILITY: with storePath set, specs persist to <instance>/monitors.json
 *    and re-arm at boot (restore()). A restart used to silently wipe every
 *    watch — the scheduler was durable, monitors were not; that asymmetry
 *    lied to the operator about what survives. dispose() closes watchers
 *    WITHOUT wiping the store; only operator remove() deletes the record.
 */
import { watch } from 'node:fs';
import { existsSync, statSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

const DEBOUNCE_MS = 1_500;
const WINDOW_MS = 3_600_000;
const DEFAULT_MAX_PER_HOUR = 12;
const HARD_CEILING = 120;

const clampCap = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_PER_HOUR;
  return Math.min(HARD_CEILING, Math.floor(n));
};

export class MonitorRegistry {
  /**
   * @param {(msg:string)=>Promise<{ok?:boolean,refused?:string}>} promptSink
   * @param {string} [opts.storePath] <instance>/monitors.json — when set,
   *        add/remove persist and restore() re-arms at boot
   */
  constructor({ promptSink, audit = null, now = () => Date.now(), storePath = null, debounceMs = DEBOUNCE_MS }) {
    this.promptSink = promptSink;
    this.audit = audit;
    this.now = now;
    this.storePath = storePath;
    this.debounceMs = debounceMs; // injectable for tests; production keeps 1.5s
    this.monitors = new Map(); // id → {id, path, prompt, maxPerHour, watcher, firedAt[], fires, capped, createdAt}
    this.seq = 0;
  }

  #persist() {
    if (!this.storePath) return;
    const doc = {
      version: 1,
      monitors: [...this.monitors.values()].map((r) => ({
        id: r.id, path: r.path, prompt: r.prompt, maxPerHour: r.maxPerHour, createdAt: r.createdAt,
      })),
    };
    const tmp = `${this.storePath}.tmp-${process.pid}`; // pid-suffixed: two live writers sharing the bare `.tmp` race (batch-7/8 class)
    try {
      writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
      renameSync(tmp, this.storePath);
    } catch { /* persistence is best-effort — the live watchers still work */ }
  }

  /** Re-arm monitors from the store. Missing paths are skipped + audited,
   *  and — critically — LEFT IN the store: an unmounted drive at boot must
   *  not silently delete the operator's watch; it re-arms when the path is
   *  back. restore() therefore never persists. */
  restore() {
    if (!this.storePath || !existsSync(this.storePath)) return { restored: 0, skipped: 0 };
    let doc;
    try { doc = JSON.parse(readFileSync(this.storePath, 'utf-8')); }
    catch (e) {
      this.audit?.write({ kind: 'MONITOR_RESTORE_FAILED', data: { error: String(e?.message ?? e).slice(0, 120) } });
      return { restored: 0, skipped: 0, error: 'store unreadable' };
    }
    let restored = 0; let skipped = 0;
    for (const m of Array.isArray(doc?.monitors) ? doc.monitors : []) {
      if (!m?.path || !m?.prompt) { skipped += 1; continue; }
      const r = this.add({ path: m.path, prompt: m.prompt, maxPerHour: m.maxPerHour, id: m.id, persist: false });
      if (r.error) skipped += 1; else restored += 1;
    }
    this.audit?.write({ kind: 'MONITOR_RESTORED', data: { restored, skipped } });
    return { restored, skipped };
  }

  /** @returns {{id:string}|{error:string}} */
  add({ path, prompt, maxPerHour = null, id = null, persist = true }) {
    const abs = resolve(String(path ?? ''));
    if (!existsSync(abs)) return { error: `watch path not found: ${abs}` };
    if (!String(prompt ?? '').trim()) return { error: 'monitor requires a prompt' };
    const mid = id && !this.monitors.has(id) ? String(id) : `mon-${++this.seq}-${this.now().toString(36)}`;
    let isDir;
    try { isDir = statSync(abs).isDirectory(); }
    catch { return { error: `watch path vanished between check and stat: ${abs}` }; } // existsSync→statSync TOCTOU
    const rec = {
      id: mid, path: abs, prompt: String(prompt).trim().slice(0, 2000),
      maxPerHour: clampCap(maxPerHour),
      dir: isDir,
      watcher: null, firedAt: [], fires: 0, capped: false, _timer: null,
      createdAt: this.now(),
    };
    const onEvent = () => {
      clearTimeout(rec._timer);
      rec._timer = setTimeout(() => { this.#fire(rec); }, this.debounceMs);
      rec._timer.unref?.();
    };
    try {
      rec.watcher = watch(abs, onEvent);
    } catch (e) {
      return { error: `watch failed: ${e.message}` };
    }
    this.monitors.set(mid, rec);
    if (persist) this.#persist();
    this.audit?.write({ kind: 'MONITOR_ADDED', data: { id: mid, path: abs, maxPerHour: rec.maxPerHour } });
    return { id: mid };
  }

  async #fire(rec) {
    const now = this.now();
    // sliding-window ceiling — prune, then gate
    rec.firedAt = rec.firedAt.filter((t) => now - t < WINDOW_MS);
    if (rec.firedAt.length >= rec.maxPerHour) {
      if (!rec.capped) {
        rec.capped = true;
        this.audit?.write({ kind: 'MONITOR_RATE_CAPPED', data: { id: rec.id, path: rec.path, maxPerHour: rec.maxPerHour } });
      }
      return; // dropped, not queued — the watcher stays armed for next window
    }
    rec.capped = false;
    rec.firedAt.push(now);
    rec.fires += 1;
    this.audit?.write({ kind: 'MONITOR_FIRED', data: { id: rec.id, path: rec.path, fires: rec.fires } });
    try {
      const r = await this.promptSink(`[monitor:${rec.id}] watched path changed: ${rec.path}\n${rec.prompt}`);
      if (r?.refused) this.audit?.write({ kind: 'MONITOR_FIRE_REFUSED', data: { id: rec.id, reason: r.refused } });
    } catch (e) {
      this.audit?.write({ kind: 'MONITOR_FIRE_ERROR', data: { id: rec.id, error: String(e?.message ?? e).slice(0, 200) } });
    }
  }

  remove(id) {
    const rec = this.monitors.get(id);
    if (!rec) return { error: `no monitor '${id}'` };
    clearTimeout(rec._timer);
    rec.watcher?.close();
    this.monitors.delete(id);
    this.#persist();
    this.audit?.write({ kind: 'MONITOR_REMOVED', data: { id } });
    return { removed: id };
  }

  list() {
    return [...this.monitors.values()].map(({ watcher, _timer, firedAt, capped, ...r }) => ({
      ...r,
      firesLastHour: firedAt.filter((t) => this.now() - t < WINDOW_MS).length,
      capped: capped,
    }));
  }

  /** Shutdown: close watchers, keep the store — next boot re-arms them. */
  dispose({ wipe = false } = {}) {
    for (const rec of this.monitors.values()) {
      clearTimeout(rec._timer);
      rec.watcher?.close();
    }
    this.monitors.clear();
    if (wipe && this.storePath) {
      try { writeFileSync(this.storePath, JSON.stringify({ version: 1, monitors: [] }) + '\n'); } catch { /* */ }
    }
  }
}
