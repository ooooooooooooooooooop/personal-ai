/**
 * HostChannel — the harness-neutral UI/channel protocol.
 *
 * UIs and remote consumers talk to THIS, never to the body: commands arrive
 * as plain data, events leave as plain data. A body adapter supplies facades
 * ({session, jobs, audit}) — host knows the protocol surface, not who
 * implements it. This is the M6 boundary: "UI is a consumer of host, not
 * of the harness."
 *
 * Commands (JSONL-friendly, mirrors the pi --mode rpc surface by design):
 *   prompt {message}        → session.prompt
 *   steer  {message}        → session.steer
 *   abort  {}               → session.abort
 *   get_state {}            → session.getState snapshot
 *   job_status {job_id}     → durable job record
 *   audit_tail {n}          → last n host audit events (redacted already)
 *
 * Events: whatever the body's event stream emits, re-tagged as
 * {type:'event', event} plus host-side {type:'audit', event} lines.
 */
export class HostChannel {
  /**
   * @param {object} facades
   * @param {object} facades.session  {prompt,steer,abort,getState,subscribe}
   * @param {object} [facades.jobs]   JobStore-like {getJob,getAttempts,getLease}
   * @param {object} [facades.audit]  {tail(n)} → AuditEvent[]
   */
  constructor({ session, jobs = null, audit = null }) {
    if (!session) throw new Error('HostChannel requires a session facade');
    this.session = session;
    this.jobs = jobs;
    this.audit = audit;
    this.listeners = new Set();
    if (typeof session.subscribe === 'function') {
      this.unsub = session.subscribe((event) => this.#emit({ type: 'event', event }));
    }
  }

  #emit(msg) {
    for (const l of this.listeners) {
      try { l(msg); } catch { /* listener failure must not break the channel */ }
    }
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Dispatch one channel command. Always resolves a response envelope —
   * command errors are {success:false, error}, never thrown.
   */
  async handle(cmd) {
    const id = cmd?.id;
    const reply = (success, data, error) =>
      ({ id, type: 'response', command: cmd?.type, success, ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}) });
    try {
      switch (cmd?.type) {
        case 'prompt':
          await this.session.prompt(String(cmd.message ?? ''), cmd.options);
          return reply(true);
        case 'steer':
          await this.session.steer(String(cmd.message ?? ''));
          return reply(true);
        case 'abort':
          await this.session.abort();
          return reply(true);
        case 'get_state':
          return reply(true, await this.session.getState());
        case 'job_status': {
          if (!this.jobs) return reply(false, undefined, 'jobs facade unavailable');
          const job = this.jobs.getJob(cmd.job_id);
          if (!job) return reply(false, undefined, `job '${cmd.job_id}' not found`);
          return reply(true, {
            job,
            attempts: this.jobs.getAttempts(cmd.job_id).length,
            lease: this.jobs.getLease(cmd.job_id),
          });
        }
        case 'audit_tail': {
          if (!this.audit) return reply(false, undefined, 'audit facade unavailable');
          return reply(true, this.audit.tail(cmd.n ?? 20));
        }
        default:
          return reply(false, undefined, `unknown command '${cmd?.type}'`);
      }
    } catch (e) {
      return reply(false, undefined, e?.message ?? String(e));
    }
  }

  /** Emit a host-side audit event to all subscribers (called by the host). */
  emitAudit(event) {
    this.#emit({ type: 'audit', event });
  }

  dispose() {
    this.unsub?.();
    this.listeners.clear();
  }
}
