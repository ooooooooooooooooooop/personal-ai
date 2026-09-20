import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
 *  - 'always'        → the {tool,command} pair is persisted to alwaysPath and
 *                      auto-allowed across restarts (OpenCode always-pattern)
 *  - 'deny'          → this call is refused AND the same tool:arg pair is
 *                      auto-refused for the session (deny cascade)
 *  - 'timeout'       → no answer before expiry = refused (never crash-open)
 *  - 'aborted'       → session aborted / process disposing = refused
 *
 * Answers travel as plain data; nothing here knows which body or UI exists.
 */
export class PendingAsks {
  #pending = new Map();
  #listeners = new Set();
  #sessionAllows = new Set();
  #sessionDenies = new Set(); // deny cascade — same tool:arg auto-refused this session
  #alwaysAllows = [];         // persisted {tool, command} — OpenCode always-pattern

  /**
   * @param {object} deps
   * @param {import('./audit.js').AuditWriter} [deps.audit]
   * @param {number} [deps.timeoutMs]      ask lifetime before auto-deny
   * @param {() => number} [deps.now]      injectable clock for tests
   * @param {string} [deps.alwaysPath]     <instance>/always-allow.json — durable
   *        'always' grants: {tool} or {tool, command} exact-match entries.
   */
  constructor({ audit = null, timeoutMs = 120_000, now = () => Date.now() } = {}, alwaysPath = null) {
    this.audit = audit;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.alwaysPath = alwaysPath;
    if (alwaysPath && existsSync(alwaysPath)) {
      try { this.#alwaysAllows = JSON.parse(readFileSync(alwaysPath, 'utf-8')); }
      catch { this.#alwaysAllows = []; }
    }
  }

  /** Match key for always/cascade entries: tool + exact command/path arg. */
  static #sigOf(toolName, args) {
    const a = args?.command ?? args?.path ?? null;
    return `${toolName}:${typeof a === 'string' ? a : ''}`;
  }

  #alwaysMatch(toolName, args) {
    return this.#alwaysAllows.some((e) =>
      e.tool === toolName && (e.command == null || e.command === args?.command));
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
    this.#sessionDenies.clear();
  }

  /**
   * Suspend until the operator answers, the ask expires, or the call aborts.
   * @param {object} descriptor {toolName, toolCallId, rule, summary, detail,
   *        kind?, options?}
   *        kind 'approval' (default) resolves to allow/allow_session/deny/
   *        timeout/aborted; kind 'question' resolves to the operator's chosen
   *        option label or free text — questions are never session-allowed and
   *        never recorded into sessionAllows.
   * @param {AbortSignal} [signal]
   * @returns {Promise<'allow'|'allow_session'|'deny'|'timeout'|'aborted'|string>}
   */
  ask(descriptor, signal) {
    const { toolName } = descriptor;
    const isQuestion = descriptor.kind === 'question';
    if (!isQuestion && this.#sessionAllows.has(toolName)) return Promise.resolve('allow');
    if (!isQuestion) {
      // Persisted always-pattern: {tool} or {tool,command} exact match.
      if (this.#alwaysMatch(toolName, descriptor.args)) return Promise.resolve('allow');
      // Deny cascade: the operator refused this exact tool:arg before —
      // repeating it is refused instantly instead of re-asking forever.
      const sig = PendingAsks.#sigOf(toolName, descriptor.args);
      if (this.#sessionDenies.has(sig)) {
        this.audit?.write?.({ kind: 'ASK_CASCADE_DENY', toolName, data: { rule: descriptor.rule ?? 'ask' } });
        return Promise.resolve('deny');
      }
    }
    const id = `ask-${randomUUID()}`;
    const expiresAt = this.now() + this.timeoutMs;
    return new Promise((resolve) => {
      const finish = (answer) => {
        const rec = this.#pending.get(id);
        if (!rec) return;
        this.#pending.delete(id);
        clearTimeout(rec._timer);
        signal?.removeEventListener?.('abort', rec._onAbort);
        if (answer === 'allow_session' && rec.kind !== 'question') this.#sessionAllows.add(toolName);
        if (answer === 'always' && rec.kind !== 'question') {
          // 'always' grants the PATTERN ({tool,command}), not the whole tool —
          // sessionAllows.add(toolName) here would over-grant every future arg.
          // Persist {tool} or {tool,command} — never persist from a truncated
          // payload: the card warned the payload was clipped, and an operator
          // cannot durably approve what they could not fully see.
          if (!rec.argsTruncated && this.alwaysPath) {
            const entry = { tool: toolName };
            if (typeof rec.args?.command === 'string') entry.command = rec.args.command;
            this.#alwaysAllows.push(entry);
            try {
              mkdirSync(dirname(this.alwaysPath), { recursive: true });
              writeFileSync(this.alwaysPath, JSON.stringify(this.#alwaysAllows, null, 2));
            } catch { /* persistence failure only costs durability — session grant still stands */ }
            this.audit?.write?.({ kind: 'ASK_ALWAYS_PERSIST', toolName, data: { command: entry.command != null ? entry.command.slice(0, 200) : null } });
          }
        }
        if (answer === 'deny' && rec.kind !== 'question') {
          this.#sessionDenies.add(PendingAsks.#sigOf(toolName, rec.args));
        }
        // outcome ledger — AgentStats outcome-bucketed counts (agreed/
        // rejected/timed-out) read this trail, not the transient event
        this.audit?.write?.({ kind: 'ASK_RESOLVED', toolName, data: { rule: rec.rule ?? 'ask', kind: rec.kind, answer } });
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
        kind: isQuestion ? 'question' : 'approval',
        options: isQuestion && Array.isArray(descriptor.options)
          ? descriptor.options.map((o) => ({
              label: String(o?.label ?? '').slice(0, 200),
              description: o?.description != null ? String(o.description).slice(0, 500) : null,
            })).filter((o) => o.label)
          : null,
        summary: descriptor.summary ?? '',
        detail: descriptor.detail ?? null,
        risk: descriptor.risk ?? null,
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
    if (rec.kind === 'question') {
      // question answers are the operator's own words/choice — any non-empty
      // string; the reserved refusal answers still come from timeout/abort
      if (typeof answer !== 'string' || !answer.trim()) {
        return { ok: false, error: 'question answers must be a non-empty string' };
      }
      rec._finish(answer.slice(0, 2000));
      return { ok: true };
    }
    if (!['allow', 'allow_session', 'always', 'deny'].includes(answer)) {
      return { ok: false, error: "answer must be 'allow', 'allow_session', 'always' or 'deny'" };
    }
    if (answer === 'always' && rec.argsTruncated) {
      return { ok: false, error: 'cannot persist always-approval for a truncated payload — approve per-call instead' };
    }
    rec._finish(answer);
    return { ok: true };
  }

  /**
   * Session teardown without process teardown: refuse everything open while
   * keeping listeners — a rebuilt session keeps the same UI subscriptions.
   */
  abortPending() {
    for (const rec of [...this.#pending.values()]) rec._finish('aborted');
  }

  /** Process teardown: nothing may stay suspended — refuse everything open. */
  dispose() {
    for (const rec of [...this.#pending.values()]) rec._finish('aborted');
    this.#listeners.clear();
  }
}
