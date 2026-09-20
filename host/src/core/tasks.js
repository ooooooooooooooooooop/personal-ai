/**
 * AgentTask mailbox (F-family, Hermes/OpenClaw sessions_* reference) — a
 * durable task record binding a durable job to a two-stream mailbox:
 *
 *   tasks/<taskId>/
 *     task.json     {task_id, job_id, label, state: open|closed, parent,
 *                    created, acks: {inbox,outbox,events}}
 *     inbox.jsonl   parent→child  {seq,from,body,ts}   (bridge → child stdin)
 *     outbox.jsonl  child→parent  {seq,from,body,ts}   (child marker lines)
 *     events.jsonl  shared stream {seq,kind,data,ts}   (lifecycle + posts)
 *
 * Bidirectionality is REAL, not emulated: the delegate bridge watches
 * inbox.jsonl and forwards new rows to the child's stdin as channel `steer`
 * frames; a child emits `PAI_TASK_POST {json}` / `PAI_TASK_EVENT {json}`
 * stdout markers the bridge intercepts into outbox/events. Any subprocess —
 * pai-channel or foreign — can speak the marker protocol; none is faked.
 *
 * seq/ack: per-stream monotonically increasing line numbers; acks live in
 * task.json so a reader (model wait / UI) tracks its own cursor.
 */
import { mkdirSync, readFileSync, appendFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const STREAMS = ['inbox', 'outbox', 'events'];

export class TaskStore {
  /** @param {string} root instance root — tasks live under <root>/tasks */
  constructor(root) {
    this.dir = join(root, 'tasks');
    mkdirSync(this.dir, { recursive: true });
  }

  #taskDir(taskId) { return join(this.dir, taskId); }
  #streamPath(taskId, stream) { return join(this.#taskDir(taskId), `${stream}.jsonl`); }

  #readMeta(taskId) {
    try { return JSON.parse(readFileSync(join(this.#taskDir(taskId), 'task.json'), 'utf-8')); }
    catch { return null; }
  }

  #writeMeta(taskId, meta) {
    writeFileSync(join(this.#taskDir(taskId), 'task.json'), JSON.stringify(meta, null, 2));
  }

  create({ label = '', jobId = null, parent = null, kind = 'delegation' } = {}) {
    const taskId = `task-${randomUUID().slice(0, 12)}`;
    mkdirSync(this.#taskDir(taskId), { recursive: true });
    const meta = {
      task_id: taskId, job_id: jobId, label, kind,
      parent_task_id: parent,
      state: 'open', created: new Date().toISOString(),
      acks: { inbox: 0, outbox: 0, events: 0 },
    };
    this.#writeMeta(taskId, meta);
    this.postEvent(taskId, 'task_created', { label, job_id: jobId, parent });
    return meta;
  }

  get(taskId) {
    const meta = this.#readMeta(taskId);
    if (!meta) return null;
    for (const s of STREAMS) meta[`${s}_count`] = this.read(taskId, s).length;
    return meta;
  }

  list() {
    let ids;
    try { ids = readdirSync(this.dir); } catch { return []; }
    const rows = ids.map((id) => this.get(id)).filter(Boolean)
      .sort((a, b) => b.created.localeCompare(a.created));
    // resolve parent scope → task_id: a delegated child records its spawning
    // session scope in `parent_task_id`, then claims the mailbox by writing
    // its own run_scope into task.json (PAI_TASK_DIR). Where both records
    // live in this store, the raw scope resolves to the real parent task.
    const byScope = new Map(rows.filter((t) => t.run_scope).map((t) => [t.run_scope, t.task_id]));
    for (const t of rows) {
      const raw = t.parent_task_id;
      if (raw && byScope.has(raw)) { t.parent_scope = raw; t.parent_task_id = byScope.get(raw); }
    }
    return rows;
  }

  /** Append a row to a stream; returns the assigned seq (line number). */
  #append(taskId, stream, row) {
    const path = this.#streamPath(taskId, stream);
    const seq = existsSync(path)
      ? readFileSync(path, 'utf-8').split('\n').filter(Boolean).length + 1
      : 1;
    appendFileSync(path, `${JSON.stringify({ seq, ts: new Date().toISOString(), ...row })}\n`);
    return seq;
  }

  read(taskId, stream, since = 0) {
    const path = this.#streamPath(taskId, stream);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf-8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && r.seq > since);
  }

  ack(taskId, stream, seq) {
    const meta = this.#readMeta(taskId);
    if (!meta) return null;
    meta.acks[stream] = Math.max(meta.acks[stream] ?? 0, seq);
    this.#writeMeta(taskId, meta);
    return meta.acks[stream];
  }

  postInbox(taskId, { from = 'parent', body }) {
    const meta = this.#readMeta(taskId);
    if (!meta) return null;
    if (meta.state !== 'open') return { seq: null, refused: `task '${taskId}' is ${meta.state}` };
    return { seq: this.#append(taskId, 'inbox', { from, body: String(body ?? '') }) };
  }

  postOutbox(taskId, { from = 'child', body }) {
    if (!this.#readMeta(taskId)) return null;
    return { seq: this.#append(taskId, 'outbox', { from, body: String(body ?? '') }) };
  }

  postEvent(taskId, kind, data = {}) {
    if (!this.#readMeta(taskId)) return null;
    return { seq: this.#append(taskId, 'events', { kind, data }) };
  }

  /** Poll outbox for rows after `since`; resolves early on new data. */
  async waitOutbox(taskId, { since = 0, timeoutMs = 30_000, intervalMs = 400 } = {}) {
    const deadline = Date.now() + Math.min(timeoutMs, 120_000);
    for (;;) {
      const rows = this.read(taskId, 'outbox', since);
      const meta = this.#readMeta(taskId);
      if (rows.length || !meta || meta.state === 'closed' || Date.now() >= deadline) {
        return { rows, state: meta?.state ?? 'missing', timedOut: !rows.length && Date.now() >= deadline };
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /** Path handed to the delegate bridge — it watches inbox + writes child markers. */
  taskDir(taskId) { return this.#taskDir(taskId); }

  setState(taskId, state) {
    const meta = this.#readMeta(taskId);
    if (!meta) return null;
    meta.state = state;
    this.#writeMeta(taskId, meta);
    if (state === 'closed') this.postEvent(taskId, 'task_closed', {});
    return meta;
  }

  /** Job linkage — set once the delegation job id is issued. */
  bindJob(taskId, jobId) {
    const meta = this.#readMeta(taskId);
    if (!meta) return null;
    meta.job_id = jobId;
    this.#writeMeta(taskId, meta);
    this.postEvent(taskId, 'job_bound', { job_id: jobId });
    return meta;
  }
}
