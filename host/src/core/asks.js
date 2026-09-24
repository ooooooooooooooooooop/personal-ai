import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
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
  // dedup-h #2027 — session-scoped MCP server grants ("approve all tools on
  // this server"): mcp__<srv>__* tool names admit without re-asking.
  #sessionServerAllows = new Set();

  /** mcp__<server>__<tool> → server name; null for non-mcp names. */
  static #mcpServerOf(toolName) {
    if (typeof toolName !== 'string' || !toolName.startsWith('mcp__')) return null;
    const srv = toolName.split('__')[1];
    return srv || null;
  }
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

  /**
   * dedup-h #1829 subcommand scope for 'always' command grants: `cargo build
   * --release` persists the prefix `cargo build`, so the subcommand family
   * auto-allows while `cargo publish` still asks. A flag-led invocation
   * (`rm -rf x`, `bash -c …`) has no subcommand — it stays exact-match:
   * binary-wide grants are the `cargo *` over-grant this exists to avoid.
   * Env assignments (FOO=bar) shift the real binary right and are skipped.
   */
  static #commandPrefixOf(command) {
    if (typeof command !== 'string') return null;
    const tokens = command.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    const bin = tokens[i];
    const sub = tokens[i + 1];
    if (!bin || !sub || sub.startsWith('-')) return null;
    if (!/^[^\s'"$&|;<>(){}\\]+$/.test(sub)) return null;
    return `${bin} ${sub}`;
  }

  /**
   * A prefix grant may only auto-approve a SINGLE simple command — shell
   * metacharacters can hide a second payload behind the approved head
   * (`cargo build && rm -rf ~`). Compounds fall back to exact matching.
   */
  static #compoundFree(command) {
    return !/[&|;`$<>\n\r]/.test(command);
  }

  #alwaysMatch(toolName, args) {
    // scope keys mirror the deny-cascade signature (#sigOf): a grant recorded
    // against a command matches that command, a grant recorded against a path
    // matches that path, and only a grant with NEITHER is tool-wide. Before
    // this, a path-arg tool (write/edit) persisted {tool} alone — an 'always'
    // click on one file auto-approved EVERY future write.
    return this.#alwaysAllows.some((e) => {
      if (e.tool !== toolName) return false;
      if (e.path != null && e.path !== args?.path) return false;
      if (typeof e.commandPrefix === 'string') {
        const cmd = typeof args?.command === 'string' ? args.command.trim() : '';
        return PendingAsks.#compoundFree(cmd)
          && (cmd === e.commandPrefix || cmd.startsWith(`${e.commandPrefix} `));
      }
      return e.command == null || e.command === args?.command;
    });
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
    this.#sessionServerAllows.clear();
  }

  /**
   * Session-scoped grant for a tool, issued by the operator through the
   * request_permission card (not by the model — the tool only routes the
   * ask). Same trust lifetime as an 'allow_session' answer.
   */
  grantSession(toolName) {
    if (typeof toolName === 'string' && toolName) {
      this.#sessionAllows.add(toolName);
      this.audit?.write?.({ kind: 'ASK_SESSION_GRANT', toolName });
    }
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
    // Cancellation also wins over an earlier session-wide permission. An
    // already-aborted call must not create an unreachable pending Promise.
    if (signal?.aborted) return Promise.resolve('aborted');
    const { toolName } = descriptor;
    // 'form' (structured input) shares the question contract: never
    // session-allowed, never cascade-denied — it is data collection, not
    // a permission verdict.
    const kind = descriptor.kind === 'question' || descriptor.kind === 'form' ? descriptor.kind : 'approval';
    const isQuestion = kind !== 'approval';
    if (!isQuestion && this.#sessionAllows.has(toolName)) return Promise.resolve('allow');
    // #2027 — server-wide session grant: a tool on an operator-approved
    // MCP server admits without re-asking (same lifetime as allow_session).
    const mcpSrv = PendingAsks.#mcpServerOf(toolName);
    if (!isQuestion && mcpSrv && this.#sessionServerAllows.has(mcpSrv)) return Promise.resolve('allow');
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
        // object answers carry {answer, edited} — edited approval grants
        // persist the EDITED command, not the model's original payload.
        // kind 'form' resolves to a values OBJECT — it is data, not an
        // {answer,edited} envelope: audit the field keys, resolve the object.
        const isFormAnswer = rec.kind === 'form' && answer && typeof answer === 'object' && !Array.isArray(answer);
        const ans = isFormAnswer ? `answered:${Object.keys(answer).join(',')}` : (answer && typeof answer === 'object' ? answer.answer : answer);
        const edited = !isFormAnswer && answer && typeof answer === 'object' ? answer.edited : null;
        if (ans === 'allow_session' && rec.kind !== 'question' && rec.kind !== 'form') this.#sessionAllows.add(toolName);
        // #2027 — 'allow_server': session-scoped grant for the WHOLE
        // mcp__<srv>__* namespace; resolves as 'allow' to the caller while
        // the audit/event trail keeps the honest answer name.
        const srvGrant = ans === 'allow_server' ? PendingAsks.#mcpServerOf(rec.toolName) : null;
        if (srvGrant) this.#sessionServerAllows.add(srvGrant);
        if (ans === 'always' && rec.kind !== 'question' && rec.kind !== 'form') {
          // 'always' grants the PATTERN ({tool,command}), not the whole tool —
          // sessionAllows.add(toolName) here would over-grant every future arg.
          // Persist {tool} or {tool,command} — never persist from a truncated
          // payload: the card warned the payload was clipped, and an operator
          // cannot durably approve what they could not fully see.
          if (!rec.argsTruncated && this.alwaysPath) {
            const entry = { tool: toolName };
            const persistedCmd = edited?.command ?? rec.args?.command;
            const persistedPath = edited?.path ?? rec.args?.path;
            if (typeof persistedCmd === 'string') {
              // #1829: subcommand-scoped grants persist the PREFIX (`cargo
              // build`); commands without a subcommand keep exact scope.
              const prefix = PendingAsks.#commandPrefixOf(persistedCmd);
              if (prefix) entry.commandPrefix = prefix;
              else entry.command = persistedCmd;
            }
            if (typeof persistedPath === 'string') entry.path = persistedPath;
            this.#alwaysAllows.push(entry);
            try {
              mkdirSync(dirname(this.alwaysPath), { recursive: true });
              // atomic: a torn store silently dropped every durable grant on
              // next construction (parse fails closed to []) — tmp+rename
              // keeps the last good grant set
              const tmp = `${this.alwaysPath}.tmp-${process.pid}`;
              writeFileSync(tmp, JSON.stringify(this.#alwaysAllows, null, 2));
              renameSync(tmp, this.alwaysPath);
            } catch { /* persistence failure only costs durability — session grant still stands */ }
            this.audit?.write?.({ kind: 'ASK_ALWAYS_PERSIST', toolName, data: { command: entry.command != null ? entry.command.slice(0, 200) : null, commandPrefix: entry.commandPrefix != null ? entry.commandPrefix.slice(0, 200) : null } });
          }
        }
        if (ans === 'deny' && rec.kind !== 'question' && rec.kind !== 'form') {
          this.#sessionDenies.add(PendingAsks.#sigOf(toolName, rec.args));
        }
        // outcome ledger — AgentStats outcome-bucketed counts (agreed/
        // rejected/timed-out) read this trail, not the transient event
        this.audit?.write?.({ kind: 'ASK_RESOLVED', toolName, data: { rule: rec.rule ?? 'ask', kind: rec.kind, answer: ans, server: srvGrant ?? undefined, edited: edited ? Object.keys(edited) : null } });
        this.#emit({ type: 'governance_resolved', askId: id, toolName, answer: ans });
        resolve(srvGrant ? 'allow' : answer);
      };
      // This timer owns an unresolved caller. Keep the loop alive until it
      // refuses the ask; finish()/dispose() clear it on all earlier exits.
      const timer = setTimeout(() => finish('timeout'), this.timeoutMs);
      const onAbort = () => finish('aborted');
      signal?.addEventListener?.('abort', onAbort, { once: true });
      const rec = {
        id,
        toolName,
        toolCallId: descriptor.toolCallId ?? null,
        rule: descriptor.rule ?? 'ask',
        kind,
        fields: kind === 'form' && Array.isArray(descriptor.fields)
          ? descriptor.fields.slice(0, 12).map((f) => ({
              key: String(f?.key ?? '').slice(0, 80),
              label: String(f?.label ?? f?.key ?? '').slice(0, 200),
              type: ['text', 'textarea', 'number', 'boolean', 'select', 'secret'].includes(f?.type) ? f.type : 'text',
              required: f?.required === true,
              options: Array.isArray(f?.options) ? f.options.slice(0, 20).map((o) => String(o).slice(0, 200)) : null,
              default: f?.default ?? null,
              description: f?.description != null ? String(f.description).slice(0, 500) : null,
            })).filter((f) => f.key)
          : null,
        options: kind === 'question' && Array.isArray(descriptor.options)
          ? descriptor.options.map((o) => ({
              label: String(o?.label ?? '').slice(0, 200),
              description: o?.description != null ? String(o.description).slice(0, 500) : null,
            })).filter((o) => o.label)
          : null,
        summary: descriptor.summary ?? '',
        detail: descriptor.detail ?? null,
        // dedup-h #2004 — plugin-described external verification choice
        // (openclaw approval-verification analogue): the asker may attach a
        // labelled extra answer; the host still owns identity, answer-set
        // authorization, timeout, and the final decision — 'external_verify'
        // resolves back to the asker, it never admits by itself.
        externalVerify: kind === 'approval' && descriptor.externalVerify && typeof descriptor.externalVerify.label === 'string'
          ? { label: String(descriptor.externalVerify.label).slice(0, 120) } : null,
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
    if (rec.kind === 'form') {
      // Structured-input answers are validated against the ask's own field
      // schema at the host — the UI is a renderer, not the contract owner.
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
        return { ok: false, error: 'form answers must be a values object' };
      }
      for (const f of rec.fields ?? []) {
        const v = answer[f.key];
        if (f.required && (v == null || v === '')) {
          return { ok: false, error: `form field '${f.key}' is required` };
        }
        if (v == null) continue;
        if (f.type === 'number' && !Number.isFinite(Number(v))) {
          return { ok: false, error: `form field '${f.key}' must be a number` };
        }
        if (f.type === 'boolean' && typeof v !== 'boolean') {
          return { ok: false, error: `form field '${f.key}' must be a boolean` };
        }
        if (f.type === 'select' && Array.isArray(f.options) && f.options.length && !f.options.includes(String(v))) {
          return { ok: false, error: `form field '${f.key}' must be one of: ${f.options.join(', ')}` };
        }
        if (typeof v === 'string' && v.length > 8000) {
          return { ok: false, error: `form field '${f.key}' exceeds the 8000-char cap` };
        }
      }
      rec._finish(answer);
      return { ok: true };
    }
    // in-card editing (CodeBuddy edit-then-approve): the operator may approve
    // an EDITED payload — answer arrives as {answer, edited:{key:value}}.
    // Only allow-family answers may carry edits; edited keys must already
    // exist in the card's args (no arg injection via the approval channel).
    let edited = null;
    if (answer && typeof answer === 'object') {
      edited = answer.edited;
      answer = answer.answer;
      if (edited && (typeof edited !== 'object' || Array.isArray(edited))) {
        return { ok: false, error: 'edited must be a plain object' };
      }
      if (edited) {
        // a clipped payload can never be edited-approved — the card showed a
        // truncated string; executing it would run a prefix of the real
        // command. Operator must approve/deny the full payload or retry.
        if (rec.argsTruncated) return { ok: false, error: 'cannot edit a truncated payload' };
        const bad = Object.entries(edited).find(([k, v]) =>
          typeof v !== 'string' || !(rec.args && Object.prototype.hasOwnProperty.call(rec.args, k)));
        if (bad) return { ok: false, error: `edited key '${bad[0]}' is not an existing string arg` };
      }
    }
    const validAnswers = ['allow', 'allow_session', 'always', 'deny'];
    // #2004 — 'external_verify' is authorized only when the asker declared
    // the choice on the pending record; it is never an allow-family answer.
    if (rec.externalVerify) validAnswers.push('external_verify');
    // #2027 — 'allow_server' only exists for mcp__* tools (server grant).
    if (PendingAsks.#mcpServerOf(rec.toolName)) validAnswers.push('allow_server');
    if (!validAnswers.includes(answer)) {
      return { ok: false, error: `answer must be one of: ${validAnswers.join(', ')}` };
    }
    if (edited && answer === 'deny') {
      return { ok: false, error: 'a denial cannot carry edits' };
    }
    if (answer === 'always' && rec.argsTruncated) {
      return { ok: false, error: 'cannot persist always-approval for a truncated payload — approve per-call instead' };
    }
    rec._finish(edited ? { answer, edited } : answer);
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
