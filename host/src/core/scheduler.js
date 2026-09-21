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
   * @param {object} spec {command?|prompt?, goal_id?, run_at? (ms epoch|ISO), every_seconds?}
   * command → fired as a durable shell job; prompt → fired into the session
   * via the prompt sink (coordinator tick). run_at in the past → fires on
   * the next tick (catch-up once semantics).
   */
  add({ command = null, prompt = null, goal_id = null, run_at = null, every_seconds = null, label = null, min_seconds = null, max_seconds = null }) {
    const cmd = String(command ?? '').trim();
    const prm = String(prompt ?? '').trim();
    if (!cmd && !prm) throw new Error('schedule requires a non-empty command or prompt');
    if (cmd && prm) throw new Error('schedule takes command OR prompt, not both');
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
    // M135 adaptive rate: min+max bound a quiet-streak backoff. Both must be
    // set and bracket the base interval — partial bounds are refused, not
    // silently ignored.
    const minS = min_seconds != null ? Math.floor(Number(min_seconds)) : null;
    const maxS = max_seconds != null ? Math.floor(Number(max_seconds)) : null;
    const adaptive = minS != null || maxS != null;
    if (adaptive) {
      if (interval == null) throw new Error('adaptive rate (min/max_seconds) requires every_seconds');
      if (minS == null || maxS == null || !(minS >= MIN_INTERVAL_SECONDS && minS <= interval && interval <= maxS)) {
        throw new Error(`adaptive rate needs min_seconds ≤ every_seconds ≤ max_seconds (min ≥ ${MIN_INTERVAL_SECONDS})`);
      }
    }
    const rec = {
      id: `sch-${randomUUID().slice(0, 8)}`,
      target: cmd ? 'command' : 'prompt',
      command: cmd || null,
      prompt: prm || null,
      goal_id: goal_id != null ? String(goal_id) : null,
      label: label != null ? String(label).slice(0, 200) : null,
      kind: interval != null ? 'interval' : 'once',
      every_seconds: interval,
      // M135: effective interval — quiet streaks stretch it toward
      // max_seconds; a real fire resets to base. null = run at base rate.
      current_seconds: null,
      quietStreak: 0,
      min_seconds: minS,
      max_seconds: maxS,
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

  /** Goose pause/unpause: enabled flag flips without losing the schedule. */
  setEnabled(id, enabled) {
    const schedules = this.#load();
    const rec = schedules.find((s) => s.id === id);
    if (!rec) return { ok: false, error: `no schedule '${id}'` };
    rec.enabled = enabled !== false;
    // re-armed intervals re-anchor from now — stale slots don't storm-fire;
    // re-enable also drops any accumulated quiet backoff (fresh start)
    if (rec.enabled && rec.kind === 'interval') {
      rec.nextRunAt = this.now() + rec.every_seconds * 1000;
      rec.current_seconds = null;
      rec.quietStreak = 0;
    }
    this.#save(schedules);
    return { ok: true, rec };
  }

  /** Goose edit: patch command/prompt/every_seconds/run_at of a live entry. */
  edit(id, { command, prompt, every_seconds, run_at, label } = {}) {
    const schedules = this.#load();
    const rec = schedules.find((s) => s.id === id);
    if (!rec) return { ok: false, error: `no schedule '${id}'` };
    if (command != null) { rec.command = String(command).trim() || null; rec.target = rec.command ? 'command' : rec.target; }
    if (prompt != null) { rec.prompt = String(prompt).trim() || null; rec.target = rec.command ? rec.target : 'prompt'; }
    if (label !== undefined) rec.label = label != null ? String(label).slice(0, 200) : null;
    const interval = every_seconds != null ? Math.floor(Number(every_seconds)) : null;
    if (every_seconds != null) {
      if (!Number.isFinite(interval) || interval < MIN_INTERVAL_SECONDS) {
        return { ok: false, error: `every_seconds must be ≥ ${MIN_INTERVAL_SECONDS}` };
      }
      rec.every_seconds = interval;
      rec.current_seconds = null; // base change resets adaptation
      rec.quietStreak = 0;
      rec.kind = 'interval';
      rec.nextRunAt = this.now() + interval * 1000;
    } else if (run_at != null) {
      const t = typeof run_at === 'number' ? run_at : Date.parse(String(run_at));
      if (!Number.isFinite(t)) return { ok: false, error: 'run_at must be an epoch ms or ISO timestamp' };
      rec.every_seconds = null;
      rec.kind = 'once';
      rec.nextRunAt = t;
    }
    if (rec.target === 'command' && !rec.command) return { ok: false, error: 'command schedule requires a command' };
    if (rec.target === 'prompt' && !rec.prompt) return { ok: false, error: 'prompt schedule requires a prompt' };
    this.#save(schedules);
    return { ok: true, rec };
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
    return this.#advance(id, (rec) => {
      rec.lastFiredAt = new Date(this.now()).toISOString();
      rec.lastJobId = jobId;
      // M135: a real fire is "world changed" evidence — drop any quiet
      // backoff so an adaptive entry returns to its base interval.
      rec.quietStreak = 0;
      rec.current_seconds = null;
    });
  }

  /**
   * Skip an overdue entry without firing (skipMissedJobs analogue): a laptop
   * that was off for days must not boot-storm every missed slot. Advances
   * nextRunAt past now exactly like a fire, minus lastFiredAt/lastJobId.
   */
  markSkipped(id) {
    return this.#advance(id, (rec) => {
      rec.lastSkippedAt = new Date(this.now()).toISOString();
    });
  }

  /**
   * M135 adaptive rate — a quiet tick (fingerprint unchanged) stretches the
   * effective interval exponentially toward max_seconds; a REAL fire resets
   * to base. The world slowing down shouldn't keep billing ticks at the
   * hot-loop rate. Only applies to adaptive entries (min/max configured).
   */
  markQuiet(id) {
    return this.#advance(id, (rec) => {
      rec.lastQuietAt = new Date(this.now()).toISOString();
      rec.quietStreak = (rec.quietStreak ?? 0) + 1;
      if (rec.min_seconds != null && rec.max_seconds != null) {
        const stretched = Math.round((rec.every_seconds ?? rec.min_seconds) * 2 ** Math.min(rec.quietStreak, 6));
        rec.current_seconds = Math.max(rec.min_seconds, Math.min(stretched, rec.max_seconds));
      }
    });
  }


  #advance(id, mutate) {
    const schedules = this.#load();
    const rec = schedules.find((s) => s.id === id);
    if (!rec) return { ok: false, error: `no schedule '${id}'` };
    mutate(rec);
    if (rec.kind === 'once') {
      rec.enabled = false;
    } else {
      rec.nextRunAt = this.now() + (rec.current_seconds ?? rec.every_seconds) * 1000;
    }
    this.#save(schedules);
    return { ok: true };
  }
}
