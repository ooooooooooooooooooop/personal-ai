/**
 * GoalStore — durable long-horizon goal records (coordinator family).
 *
 * A goal binds: a statement, a prompt-kind schedule (the tick), bound task
 * ids, and a scratchpad file the agent maintains across runs:
 *
 *   goals/<goalId>/
 *     goal.json      {goal_id, statement, state, schedule_id, task_ids,
 *                     created, last_tick_at, fingerprint, note}
 *     scratchpad.md  append-only working notes — the continuity surface the
 *                    tick prompt echoes back so each run resumes context
 *
 * States: open | paused | done. A paused/done goal's schedule still exists
 * but its tick is skipped at fire time (the schedule row stays honest).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync, renameSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactSecrets } from './secrets.js';

export class GoalStore {
  /** @param {string} root instance root — goals live under <root>/goals */
  constructor(root, now = () => Date.now()) {
    this.dir = join(root, 'goals');
    this.now = now;
    mkdirSync(this.dir, { recursive: true });
  }

  #goalDir(goalId) { return join(this.dir, goalId); }
  #metaPath(goalId) { return join(this.#goalDir(goalId), 'goal.json'); }
  scratchpadPath(goalId) { return join(this.#goalDir(goalId), 'scratchpad.md'); }

  #readMeta(goalId) {
    try { return JSON.parse(readFileSync(this.#metaPath(goalId), 'utf-8')); }
    catch { return null; }
  }

  #writeMeta(goalId, meta) {
    // atomic: goal.json is THE durable record of a long-horizon goal — a
    // torn write makes #readMeta return null and the goal silently vanishes
    // from list() and from its own schedule tick
    const p = this.#metaPath(goalId);
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(meta, null, 2));
    renameSync(tmp, p);
  }

  create({ statement, scheduleId = null } = {}) {
    // M5 parity: the statement is durable on-disk text echoed back into tick
    // prompts — scrub secret-shaped spans before bytes land
    const text = redactSecrets(String(statement ?? '').trim());
    if (!text) throw new Error('goal requires a non-empty statement');
    const goalId = `goal-${randomUUID().slice(0, 8)}`;
    mkdirSync(this.#goalDir(goalId), { recursive: true });
    const meta = {
      goal_id: goalId,
      statement: text.slice(0, 2000),
      state: 'open',
      schedule_id: scheduleId,
      task_ids: [],
      created: new Date(this.now()).toISOString(),
      last_tick_at: null,
      fingerprint: null,
    };
    this.#writeMeta(goalId, meta);
    appendFileSync(this.scratchpadPath(goalId), `# ${text.slice(0, 200)}\n`);
    return meta;
  }

  get(goalId) {
    const meta = this.#readMeta(goalId);
    if (!meta) return null;
    meta.scratchpad = this.scratchpadTail(goalId, 2000);
    return meta;
  }

  list() {
    let ids;
    try { ids = readdirSync(this.dir); } catch { return []; }
    return ids.map((id) => this.#readMeta(id)).filter(Boolean)
      .sort((a, b) => b.created.localeCompare(a.created));
  }

  setState(goalId, state) {
    const meta = this.#readMeta(goalId);
    if (!meta) return null;
    if (!['open', 'paused', 'done'].includes(state)) return { error: `bad state '${state}'` };
    meta.state = state;
    this.#writeMeta(goalId, meta);
    return meta;
  }

  /** Task linkage — a goal may bind many tasks over its lifetime. */
  bindTask(goalId, taskId) {
    const meta = this.#readMeta(goalId);
    if (!meta) return null;
    if (!meta.task_ids.includes(taskId)) meta.task_ids.push(taskId);
    this.#writeMeta(goalId, meta);
    return meta;
  }

  /** Schedule linkage — set once the tick schedule is issued. */
  bindSchedule(goalId, scheduleId) {
    const meta = this.#readMeta(goalId);
    if (!meta) return null;
    meta.schedule_id = scheduleId;
    this.#writeMeta(goalId, meta);
    return meta;
  }

  /** Continuity surface — append a working-note line to the scratchpad. */
  note(goalId, line) {
    const meta = this.#readMeta(goalId);
    if (!meta) return null;
    // M5 parity: the scratchpad is durable on-disk text (append-only)
    appendFileSync(this.scratchpadPath(goalId), `${redactSecrets(String(line ?? '').slice(0, 2000))}\n`);
    return meta;
  }

  /** Tail of the scratchpad for tick-prompt injection (bounded). */
  scratchpadTail(goalId, maxChars = 2000) {
    const p = this.scratchpadPath(goalId);
    if (!existsSync(p)) return '';
    const t = readFileSync(p, 'utf-8');
    return t.length > maxChars ? t.slice(-maxChars) : t;
  }

  /** Scratchpad stat — part of the monitor-skip fingerprint. */
  scratchpadStat(goalId) {
    const p = this.scratchpadPath(goalId);
    try { const s = statSync(p); return `${s.size}:${Math.floor(s.mtimeMs)}`; }
    catch { return 'none'; }
  }

  /** Record a fired tick: timestamp + the fingerprint it observed. */
  touchTick(goalId, fingerprint = null) {
    const meta = this.#readMeta(goalId);
    if (!meta) return null;
    meta.last_tick_at = new Date(this.now()).toISOString();
    meta.fingerprint = fingerprint;
    this.#writeMeta(goalId, meta);
    return meta;
  }
}
