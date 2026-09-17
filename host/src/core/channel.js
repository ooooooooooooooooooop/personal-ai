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
 *   session_history {}      → current session's messages as plain data
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
   */
  constructor({ session, jobs = null, audit = null, bodies = null, handoff = null, models = null, sessions = null }) {
    if (!session) throw new Error('HostChannel requires a session facade');
    this.session = session;
    this.jobs = jobs;
    this.audit = audit;
    this.bodies = bodies;
    this.handoff = handoff;
    this.models = models;
    this.sessions = sessions;
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
          if (!cmd.provider || !cmd.model) return reply(false, undefined, 'model_set requires {provider, model}');
          return reply(true, await this.models.set({ provider: String(cmd.provider), model: String(cmd.model) }));
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
        case 'session_history': {
          if (!this.session?.history) return reply(false, undefined, 'history unavailable');
          return reply(true, await this.session.history());
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
    this.listeners.clear();
  }
}
