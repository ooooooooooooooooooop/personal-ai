import { randomUUID } from 'node:crypto';

/**
 * PendingAsks — operator-in-the-loop decision surface.
 *
 * When policy maps a tool or a command risk class to the 'ask' action the
 * governance kernel suspends the call here instead of deciding alone. The
 * registry holds each pending question, emits channel events so a UI can
 * render it, and resolves the suspended call with the operator's answer.
 *
 * Semantics (all fail-closed):
 *  - 'allow'         → this call proceeds; the next one asks again
 *  - 'allow_session' → this call proceeds AND the tool is auto-allowed for
 *                      the rest of the session (resetSession clears it)
 *  - 'deny'          → this call is refused
 *  - 'timeout'       → no answer before expiry = refused (never crash-open)
 *  - 'aborted'       → session aborted / process disposing = refused
 *
 * Answers travel as plain data; nothing here knows which body or UI exists.
 */
export class PendingAsks {
  #pending = new Map();
  #listeners = new Set();
  #sessionAllows = new Set();

  /**
   * @param {object} deps
   * @param {import('./audit.js').AuditWriter} [deps.audit]
   * @param {number} [deps.timeoutMs]      ask lifetime before auto-deny
   * @param {() => number} [deps.now]      injectable clock for tests
   */
  constructor({ audit = null, timeoutMs = 120_000, now = () => Date.now() } = {}) {
    this.audit = audit;
    this.timeoutMs = timeoutMs;
    this.now = now;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event) {
    for (const l of this.#listeners) {
      try { l(event); } catch { /* listener failure must not strand the ask */ }
    }
  }

  /** Pending descriptors as plain data (no functions/timers). */
  list() {
    return [...this.#pending.values()].map(({ _finish, _timer, _onAbort, ...d }) => d);
  }

  /** Tools the operator has auto-allowed for this session. */
  sessionAllows() {
    return [...this.#sessionAllows];
  }

  /** New conversation = new trust scope. Called on session rebuild/switch. */
  resetSession() {
    this.#sessionAllows.clear();
  }

  /**
   * Suspend until the operator answers, the ask expires, or the call aborts.
   * @param {object} descriptor {toolName, toolCallId, rule, summary, detail}
   * @param {AbortSignal} [signal]
   * @returns {Promise<'allow'|'allow_session'|'deny'|'timeout'|'aborted'>}
   */
  ask(descriptor, signal) {
    const { toolName } = descriptor;
    if (this.#sessionAllows.has(toolName)) return Promise.resolve('allow');
    const id = `ask-${randomUUID()}`;
    const expiresAt = this.now() + this.timeoutMs;
    return new Promise((resolve) => {
      const finish = (answer) => {
        const rec = this.#pending.get(id);
        if (!rec) return;
        this.#pending.delete(id);
        clearTimeout(rec._timer);
        signal?.removeEventListener?.('abort', rec._onAbort);
        if (answer === 'allow_session') this.#sessionAllows.add(toolName);
        this.#emit({ type: 'governance_resolved', askId: id, toolName, answer });
        resolve(answer);
      };
      const timer = setTimeout(() => finish('timeout'), this.timeoutMs);
      timer.unref?.();
      const onAbort = () => finish('aborted');
      if (signal?.aborted) return finish('aborted');
      signal?.addEventListener?.('abort', onAbort, { once: true });
      const rec = {
        id,
        toolName,
        toolCallId: descriptor.toolCallId ?? null,
        rule: descriptor.rule ?? 'ask',
        summary: descriptor.summary ?? '',
        detail: descriptor.detail ?? null,
        args: descriptor.args ?? null,
        // WYSIWYG chain: the UI's truncation warning depends on these
        // surviving into the governance_ask event payload.
        argsTruncated: Boolean(descriptor.argsTruncated),
        argsTotalChars: descriptor.argsTotalChars ?? null,
        createdAt: new Date(this.now()).toISOString(),
        expiresAt,
        _finish: finish,
        _timer: timer,
        _onAbort: onAbort,
      };
      this.#pending.set(id, rec);
      const { _finish, _timer, _onAbort, ...plain } = rec;
      this.#emit({ type: 'governance_ask', ask: plain });
    });
  }

  /**
   * Operator answer arriving over the channel.
   * @returns {{ok:true}|{ok:false, error:string}}
   */
  resolve(id, answer) {
    const rec = this.#pending.get(id);
    if (!rec) return { ok: false, error: `no pending ask '${id}' (already resolved or expired)` };
    if (!['allow', 'allow_session', 'deny'].includes(answer)) {
      return { ok: false, error: "answer must be 'allow', 'allow_session' or 'deny'" };
    }
    rec._finish(answer);
    return { ok: true };
  }

  /** Process teardown: nothing may stay suspended — refuse everything open. */
  dispose() {
    for (const rec of [...this.#pending.values()]) rec._finish('aborted');
    this.#listeners.clear();
  }
}
