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
  constructor({ session, jobs = null, jobDetail = null, audit = null, bodies = null, handoff = null, models = null, sessions = null, asks = null, fileops = null, policy = null, budget = null, modes = null, todos = null, turns = null, tasks = null, memory = null, exec = null, commands = null, pins = null, verify = null, projectTrust = null, schedules = null, repoMap = null, skills = null, goalStore = null, monitors = null }) {
    if (!session) throw new Error('HostChannel requires a session facade');
    this.session = session;
    this.exec = exec;
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
    this.tasks = tasks;
    this.memory = memory;
    this.commands = commands;
    this.pins = pins;
    this.verify = verify;
    this.projectTrust = projectTrust;
    this.schedules = schedules;
    this.goalStore = goalStore;
    this.monitors = monitors;
    this.repoMap = repoMap;
    this.skills = skills;
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
        case 'stop_all': {
          // Hermes global emergency stop: abort the foreground turn AND
          // cancel every non-terminal durable job — one operator kill switch.
          const out = { aborted: false, cancelled: [] };
          try { await this.session.abort(); out.aborted = true; } catch { /* no live turn */ }
          if (this.jobs?.listRecent) {
            const running = this.jobs.listRecent(200)
              .filter((j) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(j.job_state));
            for (const j of running) {
              try {
                if (this.jobDetail?.cancel) this.jobDetail.cancel(j.job_id);
                else this.jobs.cancelJob?.(j.job_id);
                out.cancelled.push(j.job_id);
              } catch { /* already terminal */ }
            }
          }
          this.audit?.write?.({ kind: 'STOP_ALL', data: { aborted: out.aborted, cancelled: out.cancelled.length } });
          return reply(true, out);
        }
        case 'bash_run': {
          // `!cmd` operator direct-exec (Claude Code bang-mode analogue): the
          // command still runs through the full decide chain — nothing the
          // operator types bypasses policy.
          if (!this.exec?.run) return reply(false, undefined, 'exec facade unavailable');
          return reply(true, await this.exec.run(String(cmd.command ?? '')));
        }
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
        case 'model_ping': {
          if (!this.models?.ping) return reply(false, undefined, 'models facade unavailable');
          return reply(true, await this.models.ping(cmd.provider));
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
        case 'model_discover': {
          // M95 — probe well-known local inference nodes (Ollama/LM Studio/
          // llama.cpp). Read-only; configuration stays operator-chosen.
          if (!this.models?.discover) return reply(false, undefined, 'discovery unavailable');
          return reply(true, await this.models.discover());
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
          // Cline credential pitfall: pasted keys carry invisible characters
          // (BOM, zero-width, non-breaking space, directional marks, stray
          // whitespace) that produce indistinguishable 401s — strip them at
          // the boundary so what is stored is what the provider sees.
          const key = String(cmd.key)
            .replace(/[\ufeff\u200b-\u200f\u00a0\u202a-\u202e\u2060\u180e\s]/g, '');
          if (!key) return reply(false, undefined, 'key contained only invisible characters');
          return reply(true, await this.models.setApiKey({ provider: String(cmd.provider), key }));
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
        case 'monitor_add': {
          if (!this.monitors?.add) return reply(false, undefined, 'monitors unavailable');
          if (!cmd.path || !cmd.prompt) return reply(false, undefined, 'monitor_add requires {path, prompt}');
          const r = this.monitors.add({ path: String(cmd.path), prompt: String(cmd.prompt) });
          return r.error ? reply(false, undefined, r.error) : reply(true, r);
        }
        case 'monitor_remove': {
          if (!this.monitors?.remove) return reply(false, undefined, 'monitors unavailable');
          const r = this.monitors.remove(String(cmd.id ?? ''));
          return r.error ? reply(false, undefined, r.error) : reply(true, r);
        }
        case 'monitor_list': {
          if (!this.monitors?.list) return reply(false, undefined, 'monitors unavailable');
          return reply(true, this.monitors.list());
        }
        case 'session_import': {
          if (!this.sessions?.importSession) return reply(false, undefined, 'session import unavailable');
          if (!cmd.path) return reply(false, undefined, 'session_import requires {path}');
          return reply(true, await this.sessions.importSession(String(cmd.path)));
        }
        case 'session_fork': {
          if (!this.sessions?.fork) return reply(false, undefined, 'sessions facade unavailable');
          if (!cmd.path) return reply(false, undefined, 'session_fork requires {path}');
          return reply(true, await this.sessions.fork(String(cmd.path), { entryId: cmd.entryId ?? null }));
        }
        case 'session_delete': {
          if (!this.sessions?.remove) return reply(false, undefined, 'sessions facade unavailable');
          if (!cmd.path) return reply(false, undefined, 'session_delete requires {path}');
          return reply(true, await this.sessions.remove(String(cmd.path)));
        }
        case 'session_search': {
          if (!this.sessions?.search) return reply(false, undefined, 'sessions facade unavailable');
          return reply(true, await this.sessions.search(String(cmd.query ?? ''), { scope: cmd.scope === 'prompts' ? 'prompts' : 'all' }));
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
          // Triple-scope rewind (ZCode EscEsc): 'chat' moves only the session
          // head, 'files' undoes only receipted mutations after the anchor
          // (conversation untouched), 'both' does both. restoreFiles:true is
          // the legacy spelling of 'both'.
          const scope = ['chat', 'files', 'both'].includes(cmd.scope)
            ? cmd.scope
            : (cmd.restoreFiles === true ? 'both' : 'chat');
          const anchor = scope !== 'chat' && this.session.entries
            ? (await this.session.entries()).find((e) => e.entryId === String(cmd.entryId)) ?? null
            : null;
          if (scope !== 'chat' && !anchor) {
            return reply(false, undefined, `anchor entry '${cmd.entryId}' not found — cannot locate the file-restore boundary`);
          }
          const r = scope === 'files'
            ? { filesOnly: true }
            : await this.session.rewind(String(cmd.entryId), { summarize: cmd.summarize === true });
          if (scope !== 'chat' && !r?.cancelled && !r?.aborted && this.fileops?.restore) {
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
          return reply(true, await this.session.export({ format: ['jsonl', 'debug'].includes(cmd.format) ? cmd.format : 'html' }));
        }
        case 'session_save': {
          // Gemini /chat save: named snapshot of the live transcript the
          // operator can resume later — a copy, not a rename of the live file.
          if (!this.sessions?.save) return reply(false, undefined, 'session save unavailable');
          return reply(true, await this.sessions.save(String(cmd.name ?? '')));
        }
        case 'session_saved_list': {
          if (!this.sessions?.savedList) return reply(false, undefined, 'saved list unavailable');
          return reply(true, await this.sessions.savedList());
        }
        case 'agent_stats': {
          if (!this.sessions?.agentStats) return reply(false, undefined, 'agent stats unavailable');
          return reply(true, await this.sessions.agentStats());
        }
        // F-family AgentTask mailbox — operator-facing mirrors of the
        // model's task_* tools (same store, same state machine).
        case 'task_list': {
          if (!this.tasks) return reply(false, undefined, 'task store unavailable');
          const rows = this.tasks.list();
          // Stale-task reconciliation (Cline stale-session analogue): an open
          // task whose bound job reached a terminal state is marked `stale` —
          // the mailbox stays readable/addressable, but nothing is listening
          // on the other end. Flag-only: teammates are persistent by design,
          // so we annotate instead of auto-closing.
          const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
          for (const t of rows) {
            if (t.state === 'open' && t.job_id) {
              const j = this.jobs?.getJob?.(t.job_id);
              if (j && TERMINAL.has(j.job_state)) t.stale = true;
            }
          }
          return reply(true, rows);
        }
        case 'task_events': {
          if (!this.tasks) return reply(false, undefined, 'task store unavailable');
          if (!cmd.taskId) return reply(false, undefined, 'task_events requires {taskId}');
          const t = this.tasks.get(String(cmd.taskId));
          if (!t) return reply(false, undefined, `task '${cmd.taskId}' not found`);
          return reply(true, {
            task: t,
            inbox: this.tasks.read(t.task_id, 'inbox'),
            outbox: this.tasks.read(t.task_id, 'outbox'),
            events: this.tasks.read(t.task_id, 'events', Number(cmd.since ?? 0)),
          });
        }
        case 'task_send': {
          if (!this.tasks) return reply(false, undefined, 'task store unavailable');
          if (!cmd.taskId || cmd.body == null) return reply(false, undefined, 'task_send requires {taskId,body}');
          const r = this.tasks.postInbox(String(cmd.taskId), { from: 'operator', body: String(cmd.body) });
          if (!r) return reply(false, undefined, `task '${cmd.taskId}' not found`);
          if (r.refused) return reply(false, undefined, r.refused);
          return reply(true, { seq: r.seq });
        }
        case 'task_close': {
          if (!this.tasks) return reply(false, undefined, 'task store unavailable');
          const t = this.tasks.setState(String(cmd.taskId ?? ''), 'closed');
          if (!t) return reply(false, undefined, `task '${cmd.taskId}' not found`);
          return reply(true, { task_id: t.task_id, state: t.state });
        }
        case 'task_interrupt': {
          if (!this.tasks?.interrupt) return reply(false, undefined, 'task interrupt unavailable');
          const t = this.tasks.get(String(cmd.taskId ?? ''));
          if (!t) return reply(false, undefined, `task '${cmd.taskId}' not found`);
          if (!t.job_id) return reply(false, undefined, 'task has no bound job');
          const r = await this.tasks.interrupt(t.job_id);
          this.tasks.postEvent(t.task_id, 'interrupted', { job_id: t.job_id, ok: r?.ok !== false });
          return reply(r?.ok !== false, r ?? {});
        }
        // G-family memory — operator oversight over the canonical store:
        // the model saves/recalls; the operator reviews, pins, forgets.
        case 'memory_list': {
          if (!this.memory) return reply(false, undefined, 'memory store unavailable');
          const q = String(cmd.query ?? '').trim();
          return reply(true, q ? this.memory.recall(q, { limit: 50 }) : this.memory.all(50));
        }
        case 'memory_save': {
          if (!this.memory) return reply(false, undefined, 'memory store unavailable');
          const r = this.memory.remember(String(cmd.text ?? ''), { kind: cmd.kind ?? 'fact', source: 'operator', scope: ['user', 'project'].includes(cmd.scope) ? cmd.scope : 'user' });
          if (r.refused) return reply(false, undefined, r.refused);
          return reply(true, r);
        }
        case 'memory_pin': {
          if (!this.memory) return reply(false, undefined, 'memory store unavailable');
          if (!cmd.id) return reply(false, undefined, 'memory_pin requires {id}');
          return reply(this.memory.pin(String(cmd.id), cmd.pinned !== false), {});
        }
        case 'memory_forget': {
          if (!this.memory) return reply(false, undefined, 'memory store unavailable');
          if (!cmd.id) return reply(false, undefined, 'memory_forget requires {id}');
          return reply(this.memory.forget(String(cmd.id)), {});
        }
        case 'memory_stats': {
          if (!this.memory?.stats) return reply(false, undefined, 'memory store unavailable');
          return reply(true, this.memory.stats());
        }
        case 'memory_distill': {
          if (!this.memory?.distill) return reply(false, undefined, 'memory store unavailable');
          return reply(true, this.memory.distill());
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
          return reply(true, await this.fileops.diff(cmd.n, cmd.receiptId ?? null));
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
        case 'modes_read': {
          if (!this.modes?.readProject) return reply(false, undefined, 'modes editor facade unavailable');
          return reply(true, this.modes.readProject());
        }
        case 'modes_save': {
          if (!this.modes?.saveProject) return reply(false, undefined, 'modes editor facade unavailable');
          const out = this.modes.saveProject(String(cmd.content ?? ''));
          if (out?.error) return reply(false, undefined, out.error);
          return reply(true, out);
        }
        case 'commands_read': {
          if (!this.commands?.readProject) return reply(false, undefined, 'commands facade unavailable');
          return reply(true, this.commands.readProject());
        }
        case 'commands_save': {
          if (!this.commands?.saveProject) return reply(false, undefined, 'commands facade unavailable');
          const out = this.commands.saveProject(String(cmd.content ?? ''));
          if (out?.error) return reply(false, undefined, out.error);
          return reply(true, out);
        }
        case 'command_allow_read': {
          if (!this.commands?.readAllow) return reply(false, undefined, 'commands facade unavailable');
          return reply(true, this.commands.readAllow());
        }
        case 'command_allow_save': {
          if (!this.commands?.saveAllow) return reply(false, undefined, 'commands facade unavailable');
          const out = this.commands.saveAllow(String(cmd.content ?? ''));
          if (out?.error) return reply(false, undefined, out.error);
          return reply(true, out);
        }
        // Roo allowlist portability: export/import BOTH lists as one file.
        // The facade owns path confinement (instance root, .json only).
        case 'command_allow_export': {
          if (!this.commands?.exportLists) return reply(false, undefined, 'commands facade unavailable');
          const out = this.commands.exportLists(cmd.path ?? null);
          if (out?.error) return reply(false, undefined, out.error);
          return reply(true, out);
        }
        case 'command_allow_import': {
          if (!this.commands?.importLists) return reply(false, undefined, 'commands facade unavailable');
          if (!cmd.path) return reply(false, undefined, 'command_allow_import requires {path}');
          const out = this.commands.importLists(String(cmd.path));
          if (out?.error) return reply(false, undefined, out.error);
          return reply(true, out);
        }
        case 'pins_list': {
          if (!this.pins?.list) return reply(false, undefined, 'pins facade unavailable');
          return reply(true, this.pins.list());
        }
        // /verify — operator-triggered lint/test run (Aider /lint /test
        // analogue). Same arm-check as the post-write loop: an agent-written
        // verify.json can only run what policy already allows.
        case 'verify_status': {
          if (!this.verify?.status) return reply(false, undefined, 'verify facade unavailable');
          return reply(true, this.verify.status());
        }
        case 'verify_run': {
          if (!this.verify?.runNow) return reply(false, undefined, 'verify facade unavailable');
          return reply(true, await this.verify.runNow());
        }
        // Project trust (Pi trust.json analogue) — the operator's grant that
        // lets repo-planted .pai/microagents auto-inject into prompts.
        case 'project_trust_status': {
          if (!this.projectTrust?.status) return reply(false, undefined, 'trust facade unavailable');
          return reply(true, this.projectTrust.status());
        }
        case 'project_trust_set': {
          if (!this.projectTrust?.set) return reply(false, undefined, 'trust facade unavailable');
          return reply(true, this.projectTrust.set(cmd.trusted === true));
        }
        // Operator surface for the durable schedule store — the model's
        // schedule_task creates entries; the operator needs the same
        // list/cancel truth (Cline cron panel analogue).
        case 'schedule_list': {
          if (!this.schedules?.list) return reply(false, undefined, 'schedules facade unavailable');
          return reply(true, this.schedules.list());
        }
        // Coordinator goals — operator mirror of goal_coordinator: read
        // goal truth (statement/state/tasks/last tick) + set state.
        case 'goal_list': {
          if (!this.goalStore?.list) return reply(false, undefined, 'goals facade unavailable');
          return reply(true, this.goalStore.list());
        }
        case 'goal_set': {
          if (!this.goalStore?.setState) return reply(false, undefined, 'goals facade unavailable');
          const g = this.goalStore.setState(String(cmd.id ?? ''), String(cmd.state ?? ''));
          if (!g || g.error) return reply(false, undefined, g?.error ?? `no goal '${cmd.id}'`);
          return reply(true, g);
        }
        case 'schedule_set': {
          if (!this.schedules?.setEnabled) return reply(false, undefined, 'schedules facade unavailable');
          const r = this.schedules.setEnabled(String(cmd.id ?? ''), cmd.enabled !== false);
          return r.ok ? reply(true, r.rec) : reply(false, undefined, r.error);
        }
        case 'schedule_cancel': {
          if (!this.schedules?.cancel) return reply(false, undefined, 'schedules facade unavailable');
          const r = this.schedules.cancel(String(cmd.id ?? ''));
          if (r?.error) return reply(false, undefined, r.error);
          return reply(true, r);
        }
        // /map operator surface — same host builder the repo_map tool wraps
        case 'repo_map': {
          if (!this.repoMap?.build) return reply(false, undefined, 'repo map unavailable');
          const r = this.repoMap.build(cmd.subdir ? String(cmd.subdir) : null);
          if (r?.error) return reply(false, undefined, r.error);
          return reply(true, r);
        }
        // Skill-doctor surface: which microagents load, what they cost, how
        // often they fired — plus an operator-private allow-list so a noisy
        // skill can be shelved without deleting the file.
        case 'skills_list': {
          if (!this.skills?.stats) return reply(false, undefined, 'skills facade unavailable');
          return reply(true, { skills: this.skills.stats() });
        }
        case 'skill_allow_set': {
          if (!this.skills?.allowSet) return reply(false, undefined, 'skills facade unavailable');
          const out = this.skills.allowSet(cmd.names === null ? null : (cmd.names ?? []).map(String));
          if (out?.error) return reply(false, undefined, out.error);
          return reply(true, out);
        }
        case 'pins_add': {
          if (!this.pins?.add) return reply(false, undefined, 'pins facade unavailable');
          const out = this.pins.add(String(cmd.path ?? ''));
          if (out?.error) return reply(false, undefined, out.error);
          return reply(true, out);
        }
        case 'pins_remove': {
          if (!this.pins?.remove) return reply(false, undefined, 'pins facade unavailable');
          const out = this.pins.remove(String(cmd.path ?? ''));
          if (out?.error) return reply(false, undefined, out.error);
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
          // object answers carry in-card edits: {answer:'allow', edited:{...}}
          const answer = cmd.answer && typeof cmd.answer === 'object' ? cmd.answer : String(cmd.answer ?? '');
          const r = this.asks.resolve(String(cmd.askId ?? cmd.ask ?? ''), answer);
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
