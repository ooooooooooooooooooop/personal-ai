/**
 * ScheduleStore — durable task schedule, JSON file under the instance root.
 *
 * Semantics (OpenClaw cron + durable-job ancestry):
 *  - entries persist across restarts; a missed fire is caught up ONCE at the
 *    next boot (never replayed N times — a week of downtime is not N runs)
 *  - kinds: 'once' (run_at timestamp) and 'interval' (every_seconds ≥ floor)
 *  - firing is the pump's job (body-side executor); this store only owns
 *    truth: due computation, nextRunAt advancement, enable/disable, removal
 *  - fired entries keep a lastFiredAt + lastJobId receipt so the audit view
 *    can answer "did the 3am job actually run"
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const MIN_INTERVAL_SECONDS = 60;
export const MAX_SCHEDULES = 50;

export class ScheduleStore {
  /**
   * @param {string} instanceRoot
   * @param {() => number} [now]  injectable clock (ms) for tests
   */
  constructor(instanceRoot, now = () => Date.now()) {
    this.file = join(instanceRoot, 'schedules.json');
    this.now = now;
    mkdirSync(instanceRoot, { recursive: true });
  }

  #load() {
    if (!existsSync(this.file)) return [];
    try {
      const d = JSON.parse(readFileSync(this.file, 'utf-8'));
      return Array.isArray(d.schedules) ? d.schedules : [];
    } catch {
      return []; // corrupt schedule file = empty, never crash the pump
    }
  }

  #save(schedules) {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ schedules }, null, 2));
    renameSync(tmp, this.file); // atomic replace — a crash never halves the file
  }

  list() {
    return this.#load();
  }

  /**
   * @param {object} spec {command, run_at? (ms epoch|ISO), every_seconds?}
   * run_at in the past → fires on the next tick (catch-up once semantics).
   */
  add({ command, run_at = null, every_seconds = null, label = null }) {
    const cmd = String(command ?? '').trim();
    if (!cmd) throw new Error('schedule requires a non-empty command');
    const interval = every_seconds != null ? Math.floor(Number(every_seconds)) : null;
    if (interval != null && (!Number.isFinite(interval) || interval < MIN_INTERVAL_SECONDS)) {
      throw new Error(`every_seconds must be ≥ ${MIN_INTERVAL_SECONDS}`);
    }
    let nextRunAt;
    if (interval != null) {
      nextRunAt = this.now() + interval * 1000;
    } else {
      const t = typeof run_at === 'number' ? run_at : Date.parse(String(run_at ?? ''));
      if (!Number.isFinite(t)) throw new Error('run_at must be an epoch ms or ISO timestamp');
      nextRunAt = t;
    }
    const schedules = this.#load();
    if (schedules.filter((s) => s.enabled !== false).length >= MAX_SCHEDULES) {
      throw new Error(`schedule cap reached (${MAX_SCHEDULES})`);
    }
    const rec = {
      id: `sch-${randomUUID().slice(0, 8)}`,
      command: cmd,
      label: label != null ? String(label).slice(0, 200) : null,
      kind: interval != null ? 'interval' : 'once',
      every_seconds: interval,
      nextRunAt,
      enabled: true,
      createdAt: new Date(this.now()).toISOString(),
      lastFiredAt: null,
      lastJobId: null,
    };
    this.#save([...schedules, rec]);
    return rec;
  }

  remove(id) {
    const before = this.#load();
    const after = before.filter((s) => s.id !== id);
    if (after.length === before.length) return { ok: false, error: `no schedule '${id}'` };
    this.#save(after);
    return { ok: true };
  }

  /** Entries due at or before now (enabled only). Oldest first. */
  due() {
    const t = this.now();
    return this.#load()
      .filter((s) => s.enabled !== false && s.nextRunAt <= t)
      .sort((a, b) => a.nextRunAt - b.nextRunAt);
  }

  /**
   * Record a firing: 'once' disables itself; 'interval' advances nextRunAt to
   * the next slot strictly after now (missed slots collapse to one fire).
   */
  markFired(id, jobId = null) {
    const schedules = this.#load();
    const rec = schedules.find((s) => s.id === id);
    if (!rec) return { ok: false, error: `no schedule '${id}'` };
    rec.lastFiredAt = new Date(this.now()).toISOString();
    rec.lastJobId = jobId;
    if (rec.kind === 'once') {
      rec.enabled = false;
    } else {
      rec.nextRunAt = this.now() + rec.every_seconds * 1000;
    }
    this.#save(schedules);
    return { ok: true };
  }
}
