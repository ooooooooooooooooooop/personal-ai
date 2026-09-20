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
 *   job_list {n}            → last n durable jobs
 *   audit_tail {n}          → last n host audit events (redacted already)
 *   body_info {}            → running body's facts + boot-time selection result
 *   handoff_prepare {}      → quiesce the session, report held writer leases
 *   handoff_export {}       → PortableContinuityEnvelope fields from live state
 *   handoff_release {}      → release held writer leases (then the proc may die)
 *   model_status {}         → current model, thinking level, providers + auth state
 *   model_list {}           → models usable right now (auth present)
 *   model_set {provider,model} → switch active model (persisted by the body)
 *   thinking_set {level}    → set reasoning effort on the active model
 *   auth_set_key {provider,key} → store an API key in the body's auth store;
 *                               the key is written, never echoed back
 *   auth_clear {provider}   → remove stored credential for a provider
 *   provider_add {id,baseUrl,api,model,…} → register a custom OpenAI/Anthropic-
 *                               compatible provider in the body's model store
 *   session_list {}         → persisted sessions for this workdir
 *   session_new {}          → start a fresh persisted session
 *   session_switch {path}   → resume a persisted session
 *   session_rename {name}   → name the current session
 *   session_fork {path}     → fork a session and continue in the copy
 *   session_history {}      → current session's messages as plain data
 *   session_compact {instructions?} → compact context now (summarize window)
 *   session_entries {}      → user-message anchors usable as rewind targets
 *   session_rewind {entryId,summarize?} → move the session head to an entry
 *   session_stats {}        → session-wide token/cost totals
 *   session_export {}       → export transcript (body picks format+path)
 *   fileops_list {}         → receipted file mutations (backup/recycle log)
 *   fileops_restore {receiptId} → restore a receipted file mutation
 *   policy_status {}        → read-only governance posture (rules + actions)
 *   pending_list {}         → operator asks awaiting an answer
 *   decision_resolve {id,answer} → answer a governance ask
 *                               (allow | allow_session | deny)
 *
 * Events: whatever the body's event stream emits, re-tagged as
 * {type:'event', event} plus host-side {type:'audit', event} lines.
 */
export class HostChannel {
  /**
   * @param {object} facades
   * @param {object} facades.session  {prompt,steer,abort,getState,subscribe}
   * @param {object} [facades.jobs]   JobStore-like {getJob,getAttempts,getLease,listRecent}
   * @param {object} [facades.audit]  {tail(n)} → AuditEvent[]
   * @param {object} [facades.bodies] {current()} → {body_id, facts, selection}
   * @param {object} [facades.handoff] {prepare,export,release} — body-owned side
   *        of the cold-handoff phases a supervisor orchestrates
   * @param {object} [facades.models] {status,list,set,setThinking,setApiKey,clearApiKey}
   * @param {object} [facades.sessions] {list,create,open,rename} — persisted session lifecycle
   * @param {object} [facades.asks]   PendingAsks-like {ask,list,resolve,subscribe} —
   *        governance questions waiting on the operator; events re-emit as
   *        governance_ask / governance_resolved
   * @param {object} [facades.fileops] {list,restore} — receipted file-mutation log
   * @param {object} [facades.policy]  {status} — read-only policy posture for UIs
   * @param {object} [facades.budget]  {status} — bounded-autonomy spend posture
   * @param {object} [facades.modes]   {get,set} — session risk mode ('normal'|'plan')
   */
  constructor({ session, jobs = null, jobDetail = null, audit = null, bodies = null, handoff = null, models = null, sessions = null, asks = null, fileops = null, policy = null, budget = null, modes = null, todos = null, turns = null }) {
    if (!session) throw new Error('HostChannel requires a session facade');
    this.session = session;
    this.jobs = jobs;
    this.jobDetail = jobDetail;
    this.audit = audit;
    this.bodies = bodies;
    this.handoff = handoff;
    this.models = models;
    this.sessions = sessions;
    this.asks = asks;
    this.fileops = fileops;
    this.policy = policy;
    this.budget = budget;
    this.modes = modes;
    this.turns = turns;
    this.todos = todos;
    this.listeners = new Set();
    if (typeof session.subscribe === 'function') {
      this.unsub = session.subscribe((event) => this.#emit({ type: 'event', event }));
    }
    if (typeof asks?.subscribe === 'function') {
      this.unsubAsks = asks.subscribe((event) => this.#emit({ type: 'event', event }));
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
          this.turns?.reset(); // a user message starts a fresh tool-call budget
          await this.session.prompt(String(cmd.message ?? ''), cmd.options);
          return reply(true);
        case 'steer':
          this.turns?.reset();
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
            detail: this.jobDetail?.describe?.(cmd.job_id) ?? null,
          });
        }
        case 'job_cancel': {
          if (!cmd.job_id) return reply(false, undefined, 'job_cancel requires {job_id}');
          if (this.jobDetail?.cancel) return reply(true, this.jobDetail.cancel(cmd.job_id));
          if (this.jobs?.cancelJob) {
            this.jobs.cancelJob(cmd.job_id);
            return reply(true, { cancelled: true, killed: false });
          }
          return reply(false, undefined, 'job cancel unavailable');
        }
        case 'audit_tail': {
          if (!this.audit) return reply(false, undefined, 'audit facade unavailable');
          return reply(true, this.audit.tail(cmd.n ?? 20));
        }
        case 'job_list': {
          if (!this.jobs?.listRecent) return reply(false, undefined, 'jobs facade unavailable');
          return reply(true, this.jobs.listRecent(cmd.n ?? 20));
        }
        case 'body_info': {
          if (!this.bodies?.current) return reply(false, undefined, 'bodies facade unavailable');
          return reply(true, await this.bodies.current());
        }
        case 'handoff_prepare': {
          if (!this.handoff?.prepare) return reply(false, undefined, 'handoff facade unavailable');
          return reply(true, await this.handoff.prepare());
        }
        case 'handoff_export': {
          if (!this.handoff?.export) return reply(false, undefined, 'handoff facade unavailable');
          return reply(true, await this.handoff.export());
        }
        case 'handoff_release': {
          if (!this.handoff?.release) return reply(false, undefined, 'handoff facade unavailable');
          return reply(true, await this.handoff.release());
        }
        case 'model_status': {
          if (!this.models?.status) return reply(false, undefined, 'models facade unavailable');
          return reply(true, await this.models.status());
        }
        case 'model_list': {
          if (!this.models?.list) return reply(false, undefined, 'models facade unavailable');
          return reply(true, await this.models.list());
        }
        case 'model_set': {
          if (!this.models?.set) return reply(false, undefined, 'models facade unavailable');
          if (cmd.alias) return reply(true, await this.models.set({ alias: String(cmd.alias) }));
          if (!cmd.provider || !cmd.model) return reply(false, undefined, 'model_set requires {provider, model} or {alias}');
          return reply(true, await this.models.set({ provider: String(cmd.provider), model: String(cmd.model) }));
        }
        case 'model_alias_list': {
          if (!this.models?.aliasList) return reply(false, undefined, 'models facade unavailable');
          return reply(true, this.models.aliasList());
        }
        case 'model_alias_set': {
          if (!this.models?.aliasSet) return reply(false, undefined, 'models facade unavailable');
          return reply(true, this.models.aliasSet({ name: cmd.name, provider: cmd.provider, model: cmd.model, thinking: cmd.thinking }));
        }
        case 'model_alias_del': {
          if (!this.models?.aliasDel) return reply(false, undefined, 'models facade unavailable');
          return reply(true, this.models.aliasDel({ name: cmd.name }));
        }
        case 'thinking_set': {
          if (!this.models?.setThinking) return reply(false, undefined, 'models facade unavailable');
          return reply(true, await this.models.setThinking(String(cmd.level ?? '')));
        }
        case 'auth_set_key': {
          if (!this.models?.setApiKey) return reply(false, undefined, 'models facade unavailable');
          if (!cmd.provider || !cmd.key) return reply(false, undefined, 'auth_set_key requires {provider, key}');
          // The key travels in the command envelope only — never into responses,
          // events, or audit. Facades must not return key material.
          return reply(true, await this.models.setApiKey({ provider: String(cmd.provider), key: String(cmd.key) }));
        }
        case 'auth_clear': {
          if (!this.models?.clearApiKey) return reply(false, undefined, 'models facade unavailable');
          if (!cmd.provider) return reply(false, undefined, 'auth_clear requires {provider}');
          return reply(true, await this.models.clearApiKey(String(cmd.provider)));
        }
        case 'provider_add': {
          if (!this.models?.addProvider) return reply(false, undefined, 'models facade unavailable');
          const spec = {
            // 'provider', not 'id' — cmd.id is the envelope id and gets
            // rewritten to a seq number when a supervisor proxies the command
            provider: String(cmd.provider ?? '').trim(),
            baseUrl: String(cmd.baseUrl ?? '').trim(),
            api: String(cmd.api ?? '').trim(),
            model: String(cmd.model ?? '').trim(),
            modelName: cmd.modelName ? String(cmd.modelName) : undefined,
            contextWindow: cmd.contextWindow ? Number(cmd.contextWindow) : undefined,
            maxTokens: cmd.maxTokens ? Number(cmd.maxTokens) : undefined,
            apiKeyEnv: cmd.apiKeyEnv ? String(cmd.apiKeyEnv).replace(/^\$/, '') : undefined,
          };
          if (!spec.provider || !spec.baseUrl || !spec.api || !spec.model) {
            return reply(false, undefined, 'provider_add requires {provider, baseUrl, api, model}');
          }
          return reply(true, await this.models.addProvider(spec));
        }
        case 'session_list': {
          if (!this.sessions?.list) return reply(false, undefined, 'sessions facade unavailable');
          return reply(true, await this.sessions.list());
        }
        case 'session_new': {
          if (!this.sessions?.create) return reply(false, undefined, 'sessions facade unavailable');
          return reply(true, await this.sessions.create());
        }
        case 'session_switch': {
          if (!this.sessions?.open) return reply(false, undefined, 'sessions facade unavailable');
          if (!cmd.path) return reply(false, undefined, 'session_switch requires {path}');
          return reply(true, await this.sessions.open(String(cmd.path)));
        }
        case 'session_rename': {
          if (!this.sessions?.rename) return reply(false, undefined, 'sessions facade unavailable');
          return reply(true, await this.sessions.rename(String(cmd.name ?? '')));
        }
        case 'session_fork': {
          if (!this.sessions?.fork) return reply(false, undefined, 'sessions facade unavailable');
          if (!cmd.path) return reply(false, undefined, 'session_fork requires {path}');
          return reply(true, await this.sessions.fork(String(cmd.path)));
        }
        case 'session_delete': {
          if (!this.sessions?.remove) return reply(false, undefined, 'sessions facade unavailable');
          if (!cmd.path) return reply(false, undefined, 'session_delete requires {path}');
          return reply(true, await this.sessions.remove(String(cmd.path)));
        }
        case 'session_search': {
          if (!this.sessions?.search) return reply(false, undefined, 'sessions facade unavailable');
          return reply(true, await this.sessions.search(String(cmd.query ?? '')));
        }
        case 'session_history': {
          if (!this.session?.history) return reply(false, undefined, 'history unavailable');
          return reply(true, await this.session.history());
        }
        case 'session_compact': {
          if (!this.session?.compact) return reply(false, undefined, 'compact unavailable');
          return reply(true, await this.session.compact(cmd.instructions ? String(cmd.instructions) : undefined));
        }
        case 'session_entries': {
          if (!this.session?.entries) return reply(false, undefined, 'entries unavailable');
          return reply(true, await this.session.entries());
        }
        case 'session_rewind': {
          if (!this.session?.rewind) return reply(false, undefined, 'rewind unavailable');
          if (!cmd.entryId) return reply(false, undefined, 'session_rewind requires {entryId}');
          // Dual-scope rewind (ZCode): restoreFiles additionally undoes every
          // receipted file mutation recorded AFTER the rewind anchor — the
          // chat head and the worktree move together instead of diverging.
          const anchor = cmd.restoreFiles === true && this.session.entries
            ? (await this.session.entries()).find((e) => e.entryId === String(cmd.entryId)) ?? null
            : null;
          const r = await this.session.rewind(String(cmd.entryId), { summarize: cmd.summarize === true });
          if (cmd.restoreFiles === true && !r?.cancelled && !r?.aborted && this.fileops?.restore) {
            const anchorTs = anchor?.ts != null ? Date.parse(anchor.ts) : null;
            // Uncapped scan — the UI list cap must not silently drop undoable
            // mutations between the anchor and now.
            const all = this.fileops.listAll ? await this.fileops.listAll() : await this.fileops.list?.() ?? [];
            const undo = anchorTs != null
              ? all.filter((o) => o.at >= anchorTs && (o.recoverable || o.undoable))
              : [];
            const restored = [];
            const failed = [];
            for (const o of undo) { // receipts are newest-first — undo order
              try {
                await this.fileops.restore(o.receiptId);
                restored.push(o.receiptId);
              } catch (e) {
                failed.push({ receiptId: o.receiptId, error: String(e?.message ?? e) });
              }
            }
            // Honest partial semantics: failures are reported, not swallowed —
            // a rewind that left worktree state divergent must not claim success.
            return reply(true, { ...r, restoredFiles: restored, failedFiles: failed, partial: failed.length > 0 });
          }
          return reply(true, r);
        }
        case 'session_stats': {
          if (!this.session?.stats) return reply(false, undefined, 'stats unavailable');
          return reply(true, await this.session.stats());
        }
        case 'session_export': {
          if (!this.session?.export) return reply(false, undefined, 'export unavailable');
          return reply(true, await this.session.export());
        }
        case 'fileops_list': {
          if (!this.fileops?.list) return reply(false, undefined, 'fileops facade unavailable');
          return reply(true, await this.fileops.list());
        }
        case 'fileops_restore': {
          if (!this.fileops?.restore) return reply(false, undefined, 'fileops facade unavailable');
          if (!cmd.receiptId) return reply(false, undefined, 'fileops_restore requires {receiptId}');
          return reply(true, await this.fileops.restore(String(cmd.receiptId)));
        }
        case 'fileops_diff': {
          if (!this.fileops?.diff) return reply(false, undefined, 'fileops diff unavailable');
          return reply(true, await this.fileops.diff(cmd.n));
        }
        case 'session_btw': {
          if (!this.sessions?.btw) return reply(false, undefined, 'btw unavailable');
          if (typeof cmd.message !== 'string' || !cmd.message.trim()) return reply(false, undefined, 'session_btw requires {message}');
          return reply(true, await this.sessions.btw(cmd.message));
        }
        case 'policy_status': {
          if (!this.policy?.status) return reply(false, undefined, 'policy facade unavailable');
          return reply(true, await this.policy.status());
        }
        case 'budget_status': {
          if (!this.budget?.status) return reply(false, undefined, 'budget facade unavailable');
          return reply(true, await this.budget.status());
        }
        case 'risk_mode': {
          if (!this.modes?.get) return reply(false, undefined, 'modes facade unavailable');
          return reply(true, { mode: this.modes.get() });
        }
        case 'risk_mode_set': {
          if (!this.modes?.set) return reply(false, undefined, 'modes facade unavailable');
          const mode = String(cmd.mode ?? '');
          if (!['normal', 'plan'].includes(mode)) return reply(false, undefined, "risk_mode_set: mode must be 'normal' or 'plan'");
          return reply(true, { mode: this.modes.set(mode) });
        }
        case 'mode_list': {
          if (!this.modes?.list) return reply(false, undefined, 'modes facade unavailable');
          return reply(true, { modes: this.modes.list(), active: this.modes.active?.() ?? this.modes.get() });
        }
        case 'mode_set': {
          if (!this.modes?.setMode) return reply(false, undefined, 'modes facade unavailable');
          const name = String(cmd.name ?? '');
          const out = this.modes.setMode(name);
          if (!out) return reply(false, undefined, `mode_set: unknown mode '${name}'`);
          return reply(true, out);
        }
        case 'todos_list': {
          if (!this.todos?.list) return reply(false, undefined, 'todos facade unavailable');
          return reply(true, await this.todos.list());
        }
        case 'pending_list': {
          if (!this.asks?.list) return reply(false, undefined, 'asks facade unavailable');
          return reply(true, this.asks.list());
        }
        case 'decision_resolve': {
          if (!this.asks?.resolve) return reply(false, undefined, 'asks facade unavailable');
          const r = this.asks.resolve(String(cmd.askId ?? cmd.ask ?? ''), String(cmd.answer ?? ''));
          return r.ok ? reply(true, { resolved: true }) : reply(false, undefined, r.error);
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

  /** Emit a synthetic session-level event (e.g. session_changed after a rebuild). */
  emitEvent(event) {
    this.#emit({ type: 'event', event });
  }

  dispose() {
    this.unsub?.();
    this.unsubAsks?.();
    this.listeners.clear();
  }
}
