/**
 * Pi-side channel facade — maps the real AgentSession + host core onto the
 * harness-neutral HostChannel contract. This is where Pi-specific state
 * shapes get translated into plain-data snapshots a UI can consume.
 */
import { HostChannel } from '../../../host/src/core/channel.js';
import { normalizeAttachments, partitionByCapability, describeAttachment, extractAttachmentText } from '../../../host/src/core/attachments.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

/**
 * @param {object} deps
 * @param {object} deps.session   real AgentSession (initial)
 * @param {object} deps.core      host core ({paths, audit, ...})
 * @param {object} [deps.jobs]    JobStore
 * @param {object} [deps.bodies]  {current()} — running body facts + selection
 * @param {object} [deps.handoff] {prepare,export,release} — live handoff side
 * @param {object} [deps.sessions] {list,create,open,rename} — session lifecycle,
 *        supplied by the bootstrap which owns session rebuilds
 * @returns {{channel: HostChannel, rebind: (newSession) => void}}
 *   rebind swaps the live session (session_new/session_switch rebuilds it);
 *   UI listeners survive the swap because they subscribe to the fan-out,
 *   not to the session object itself.
 */
const VERIFY_WRITE_TOOLS = new Set(['write', 'edit', 'delete', 'patch', 'apply_patch', 'create']);
// Shell-family tools whose side effects get a workspace-delta notice
// (CC bashEditDiffEnabled analogue — the diff panel for command edits).
const EXEC_TOOLS = new Set(['bash', 'shell', 'powershell', 'cmd']);

export function createChannelHost({ session, core, jobs = null, jobDetail = null, bodies = null, handoff = null, sessions = null, asks = null, fileops = null, budget = null, writeLease = null, modes = null, hooks = null, turns = null, tasks = null, memory = null, knowledge = null, exec = null, goals = null, verify = null, commands = null, pins = null, getLoopwatch = null, projectTrust = null, schedules = null, repoMap = null, workdir = null, goalStore = null, monitors = null }) {
  const auditPath = () => core.audit?.file
    ?? join(core.paths.auditDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);

  // Mutable session holder + fan-out pump: the facade delegates to whichever
  // session is current; rebind() retargets the pump to a rebuilt session.
  const box = { s: session };
  const uiListeners = new Set();
  const emit = (ev) => {
    for (const l of uiListeners) {
      try { l(ev); } catch { /* a dead UI listener must not break the pump */ }
    }
  };
  // Bounded autonomy: bill every usage-bearing event onto the append-only
  // ledger, and on breach refuse further spend — emit + abort + audit.
  const warnedScopes = new Set(); // 80% wrap-up hint fires once per scope
  const bill = (usage, source) => {
    if (!budget || !usage) return;
    try {
      const scope = box.s.sessionId ?? box.s.sessionManager?.getSessionId?.() ?? 'unknown';
      // tokens/cost only — the provider request itself was already counted
      // at the fetch gate (one HTTP call = one call, retries included)
      budget.record({ scope, source, usage, countCall: false });
      const c = budget.consumed(scope);
      const l = budget.limits ?? {};
      const pct = Math.max(
        l.maxTokensPerSession ? c.tokens / l.maxTokensPerSession : 0,
        l.maxCostPerSessionUsd ? c.cost / l.maxCostPerSessionUsd : 0,
        l.maxCallsPerSession ? c.calls / l.maxCallsPerSession : 0,
      );
      if (pct >= 0.8 && !warnedScopes.has(scope)) {
        warnedScopes.add(scope);
        core.audit?.write({ kind: 'BUDGET_WARNING', data: { scope, source, pct: Math.round(pct * 100), consumed: c } });
        emit({ type: 'budget_warning', scope, pct: Math.round(pct * 100), consumed: c });
      }
      const breach = budget.breach(scope);
      if (breach) {
        core.audit?.write({ kind: 'BUDGET_EXCEEDED', data: { scope, source, ...breach } });
        emit({ type: 'budget_exceeded', ...breach, consumed: budget.consumed(scope) });
        box.s.abort?.().catch(() => {});
      }
    } catch (e) {
      // a recording failure with configured limits is governance-relevant —
      // surface it rather than silently un-metering the run
      emit({ type: 'budget_error', error: String(e?.message ?? e) });
    }
  };
  let pump = null;
  let autoCompacted = false; // per-session latch — rebind resets it
  // N3 workspace-delta notices for shell commands: `git status --porcelain`
  // before/after the call; the NEW-dirty set is what the command touched.
  // Best-effort — non-git workdirs and slow git simply yield no notice.
  const pendingDelta = new Map(); // toolCallId → Promise<Set<path>|null>
  let gitProbe = null; // null=unprobed · true=repo · false=disabled (not a repo)
  const gitDirty = () => new Promise((res) => {
    if (!workdir || gitProbe === false) return res(null);
    execFile('git', ['status', '--porcelain', '--no-renames'], { cwd: workdir, timeout: 4000, windowsHide: true }, (e, out) => {
      if (e) {
        // disable permanently only when provably not a git repo
        if (/not a git repository/i.test(String(e.stderr ?? e.message ?? ''))) gitProbe = false;
        return res(null);
      }
      gitProbe = true;
      res(new Set(out.split('\n').map((l) => l.slice(3).trim()).filter(Boolean)));
    });
  });
  const rebind = (newSession) => {
    pump?.();
    autoCompacted = false;
    box.s = newSession;
    pump = newSession.subscribe((ev) => {
      if (ev?.type === 'message_end' && ev.message?.role === 'assistant' && ev.message?.usage) {
        bill(ev.message.usage, 'turn');
        // H-family auto-compact (Codex-style): at ≥90% of the context
        // window the body compacts itself once per threshold crossing —
        // announced via event + audit, never silently rewriting context.
        try {
          const u = box.s.getContextUsage?.();
          if (u?.contextWindow && u.tokens != null && !autoCompacted
              && u.tokens / u.contextWindow >= 0.9 && !box.s.isStreaming) {
            autoCompacted = true;
            emit({ type: 'auto_compact', tokens: u.tokens, contextWindow: u.contextWindow });
            core.audit?.write({ kind: 'AUTO_COMPACT', data: { tokens: u.tokens, contextWindow: u.contextWindow } });
            box.s.compact?.().catch(() => {});
          }
        } catch { /* auto-compact is best-effort */ }
      } else if (ev?.type === 'compaction_end' && ev.result?.usage) {
        bill(ev.result.usage, 'compaction');
      } else if (ev?.type === 'tool_execution_end' && writeLease) {
        // belt for the afterToolCall release — idempotent, holder-matched
        writeLease.release(`fg:${ev.toolCallId}`);
      } else if (ev?.type === 'agent_end' && writeLease) {
        // abort can skip afterToolCall — sweep any foreground-held lease so a
        // dead write never wedges the workspace
        const h = writeLease.held();
        if (h?.holder?.startsWith('fg:')) writeLease.release(h.holder);
      }
      // Lifecycle hooks (observational family — Claude Code SessionStart /
      // Stop / PreToolUse-event analogue; the operator-private veto gate is
      // the separate pre_tool hook on the decide path)
      if (ev?.type === 'tool_execution_start') {
        hooks?.fire('tool_start', { toolName: ev.toolName, toolCallId: ev.toolCallId });
        if (EXEC_TOOLS.has(ev.toolName) && ev.toolCallId) pendingDelta.set(ev.toolCallId, gitDirty());
      } else if (ev?.type === 'tool_execution_end') {
        // bashEditDiff analogue: report which files the command newly dirtied.
        // Detached — the tool_execution_end event itself must not wait on git.
        const beforeP = pendingDelta.get(ev.toolCallId);
        pendingDelta.delete(ev.toolCallId);
        if (beforeP) {
          const toolName = ev.toolName;
          beforeP.then(async (before) => {
            if (!before) return;
            const after = await gitDirty();
            if (!after) return;
            const delta = [...after].filter((f) => !before.has(f)).slice(0, 12);
            if (!delta.length) return;
            core.audit?.write({ kind: 'BASH_WORKSPACE_DELTA', data: { toolName, files: delta } });
            emit({ type: 'notify', message: `${toolName} 改动了 ${delta.length} 个文件：${delta.slice(0, 6).join('、')}${delta.length > 6 ? ` 等` : ''}`, level: 'info' });
          }).catch(() => {});
        }
        hooks?.fire('tool_end', { toolName: ev.toolName, toolCallId: ev.toolCallId, isError: Boolean(ev.isError) });
      } else if (ev?.type === 'agent_end') {
        hooks?.fire('agent_stop', {});
      } else if (ev?.type === 'compaction_start') {
        hooks?.fire('compact_start', {});
      } else if (ev?.type === 'compaction_end') {
        hooks?.fire('compact_end', {});
      }
      // Aider verify loop: a successful write-family call runs the project's
      // .pai/verify.json command (armed only if policy allows its class)
      if (ev?.type === 'tool_execution_end' && !ev.isError && VERIFY_WRITE_TOOLS.has(ev.toolName)) {
        verify?.afterWrite().catch(() => {});
      }
      // Roo mistake_limit: consecutive tool errors escalate to the operator;
      // 'deny' sets loopwatch.stopped → the decide chain refuses further calls.
      // Detached (no await): the tool_execution_end event must reach the UI
      // immediately — the error IS what the operator needs to see on the card.
      if (ev?.type === 'tool_execution_end') {
        const lw = getLoopwatch?.();
        if (lw) {
          const v = lw.observeResult(Boolean(ev.isError));
          if (v.level === 'escalate') {
            core.audit?.write({ kind: 'MISTAKE_LIMIT', data: { count: v.count, toolName: ev.toolName } });
            const answered = asks?.ask
              ? asks.ask({
                  toolName: ev.toolName ?? 'tool',
                  toolCallId: ev.toolCallId,
                  rule: 'mistake_limit',
                  summary: `连续 ${v.count} 次工具错误`,
                  detail: `${v.reason} —— 允许=继续本轮，拒绝=停止本轮全部工具调用`,
                  args: { streak: v.count, lastTool: ev.toolName },
                  argsTruncated: false,
                  argsTotalChars: null,
                })
              : Promise.resolve('deny'); // no operator channel → stop (fail-closed)
            answered.then((a) => {
              if (a !== 'allow' && a !== 'allow_session') {
                lw.stopRun();
                emit({ type: 'notify', message: '已停止本轮——连续工具错误过多', level: 'err' });
              }
            }).catch(() => {});
          }
        }
      }
      emit(ev);
    });
  };
  rebind(session);
  hooks?.fire('session_start', { sessionId: session?.sessionId ?? null });
  // Expensive-call admission — prompt/steer/compact all go through here.
  const admitSpend = () => {
    if (!budget) return;
    const scope = box.s.sessionId ?? box.s.sessionManager?.getSessionId?.() ?? 'unknown';
    const gate = budget.admit(scope);
    if (!gate.ok) throw new Error(`budget gate: ${gate.reason}`);
  };

  const sessionFacade = {
    prompt: (message, options) => {
      admitSpend();
      hooks?.fire('prompt_submit', { preview: String(message ?? '').slice(0, 200) });
      // Auto-name (Goose/OpenClaw): an unnamed session takes its first user
      // prompt as display name. Only fills the null slot — an operator
      // rename or a previous auto-name is never overwritten.
      try {
        if (!box.s.sessionName && typeof message === 'string' && message.trim()) {
          const t = message.trim().replace(/\s+/g, ' ');
          box.s.setSessionName?.(t.length > 40 ? `${t.slice(0, 40)}…` : t);
        }
      } catch { /* naming is best-effort */ }
      // U5: generalized attachments normalize at the channel boundary, then
      // split by body capability — pi carries images natively; other media
      // degrades to a truthful descriptor block (never a fake modality).
      let msg = message;
      let opts = options;
      // H-family microagents: prompt text matching a trigger injects that
      // knowledge block for this turn — topic-scoped, not always-on.
      try {
        const kb = knowledge?.match?.(msg);
        if (kb?.text) {
          msg = `${kb.text}\n\n${msg ?? ''}`;
          core.audit?.write({ kind: 'KNOWLEDGE_INJECTED', data: { agents: kb.agents } });
        }
      } catch { /* knowledge match is best-effort — never blocks a prompt */ }
      if (options?.attachments?.length) {
        const { attachments, rejected } = normalizeAttachments(options.attachments);
        // Capability-gated carry (OpenCode/Cline analogue): images ride
        // natively only when the CURRENT model advertises image input —
        // attaching to a text-only model degrades to a descriptor and the
        // operator is told, instead of the SDK silently dropping bytes.
        const curInput = box.s?.model?.input;
        const caps = { images: !Array.isArray(curInput) || curInput.includes('image') };
        const { native, degraded } = partitionByCapability(attachments, caps);
        const lostImages = degraded.filter((a) => a.kind === 'image').length;
        if (lostImages && caps.images === false) {
          emit({
            type: 'notify',
            level: 'warn',
            message: `当前模型 ${box.s?.model?.id ?? '?'} 不支持图片输入——${lostImages} 张图片将降级为文本描述（换个视觉模型可原生看图）`,
          });
        }
        if (native.length) {
          opts = { ...options, images: [...(options.images ?? []), ...native.map((a) => ({ type: 'image', data: a.source.data, mimeType: a.mime }))] };
        }
        if (degraded.length) {
          // Extractable formats (text/code/ipynb) inline their CONTENT so the
          // model reads them; opaque binaries stay honest descriptors.
          msg = `${msg ?? ''}\n\n${degraded.map((a) => {
            const text = extractAttachmentText(a);
            return text ? `<attachment kind="${a.kind}" name="${a.name}" mime="${a.mime}">\n${text}\n</attachment>` : describeAttachment(a);
          }).join('\n')}`;
        }
        if (rejected.length) {
          core.audit?.write({ kind: 'ATTACHMENT_REJECTED', data: { rejected } });
        }
      }
      return box.s.prompt(msg, opts);
    },
    steer: (message) => { admitSpend(); return box.s.steer(message); },
    abort: async () => {
      await box.s.abort?.();
      // question-kind asks carry no ctx.signal — the session abort above
      // resolves approval asks via their signal; sweep whatever is left
      asks?.abortPending?.();
      // Interrupt annotation: stopReason 'aborted' is metadata the model never
      // sees in its prompt. A non-display custom message enters the next turn's
      // context, so a continued run knows the interruption was the operator's —
      // other abort paths (budget breach, session switch, handoff) deliberately
      // bypass this facade and leave no such note.
      try {
        await box.s.sendCustomMessage?.({
          customType: 'pai.user_interrupt',
          content: 'The user interrupted this run. Treat the interrupted turn as partially complete — resume from the current state instead of restarting the work.',
          display: false,
        }, { triggerTurn: false, deliverAs: 'nextTurn' });
      } catch { /* annotation is best-effort; abort already landed */ }
    },
    getState: async () => {
      const s = box.s;
      return {
        model: s.model ? { provider: s.model.provider, id: s.model.id, name: s.model.name ?? s.model.id } : null,
        streaming: Boolean(s.isStreaming),
        messageCount: s.messages?.length ?? null,
        thinkingLevel: s.thinkingLevel ?? null,
        session: {
          id: s.sessionId ?? null,
          name: s.sessionManager?.getSessionName?.() ?? null,
          file: s.sessionManager?.getSessionFile?.() ?? null,
        },
        contextUsage: s.getContextUsage?.() ?? null,
        goals: goals?.() ?? null,
      };
    },
    // Context lifecycle — pi-native compact / tree rewind / stats / export.
    compact: async (instructions) => {
      admitSpend();
      const r = await box.s.compact?.(instructions);
      return r ? { compacted: true } : { compacted: false };
    },
    // User-message anchors are the natural rewind targets (pi ships
    // getUserMessagesForForking for exactly this picker shape). ts is
    // resolved from the tree entry — rewind+restore binds fileops receipts
    // to it by timestamp.
    entries: async () => (box.s.getUserMessagesForForking?.() ?? [])
      .map((e) => ({
        entryId: e.entryId,
        text: e.text ?? '',
        ts: box.s.sessionManager?.getEntry?.(e.entryId)?.timestamp ?? null,
      })),
    rewind: async (entryId, { summarize = false } = {}) => {
      const r = await box.s.navigateTree?.(entryId, { summarize });
      return {
        cancelled: Boolean(r?.cancelled),
        aborted: Boolean(r?.aborted),
        editorText: r?.editorText ?? null,
      };
    },
    stats: async () => box.s.getSessionStats?.() ?? null,
    export: async (opts = {}) => {
      // trajectory export (Hermes): raw JSONL is the replayable/training
      // form; HTML stays the human-readable default.
      if (opts.format === 'jsonl') {
        const src = box.s.sessionFile;
        if (!src) return { file: null, format: 'jsonl' };
        const dir = join(dirname(src), 'exports');
        mkdirSync(dir, { recursive: true });
        const out = join(dir, `trajectory-${Date.now()}.jsonl`);
        copyFileSync(src, out);
        return { file: out, format: 'jsonl' };
      }
      // /debug bundle (Devin trajectory-with-subagents analogue): the raw
      // session file PLUS the AgentTask subtree this session spawned and the
      // job rows — one JSON the operator can hand to support or replay.
      if (opts.format === 'debug') {
        const src = box.s.sessionFile;
        if (!src) return { file: null, format: 'debug' };
        const scope = box.s.sessionId ?? box.s.sessionManager?.getSessionId?.() ?? null;
        const dir = join(dirname(src), 'exports');
        mkdirSync(dir, { recursive: true });
        const out = join(dir, `debug-${Date.now()}.json`);
        const allTasks = tasks?.list?.() ?? [];
        // bind: tasks whose run_scope is this session (spawned children) or
        // whose parent chain leads into this session's tree
        const mine = new Set(
          allTasks.filter((t) => t.run_scope === scope || t.parent_scope === scope).map((t) => t.task_id));
        // pull grandchildren — a spawned child may itself have spawned tasks
        let grew = true;
        while (grew) {
          grew = false;
          for (const t of allTasks) {
            if (!mine.has(t.task_id) && t.parent_task_id && mine.has(t.parent_task_id)) {
              mine.add(t.task_id); grew = true;
            }
          }
        }
        const bundle = {
          exportedAt: new Date().toISOString(),
          sessionId: scope,
          sessionFile: src,
          trajectory: readFileSync(src, 'utf-8').trim().split('\n').filter(Boolean)
            .map((l) => { try { return JSON.parse(l); } catch { return { raw: l.slice(0, 400) }; } }),
          tasks: allTasks.filter((t) => mine.has(t.task_id)).map((t) => ({
            task_id: t.task_id, label: t.label, state: t.state, kind: t.kind, name: t.name,
            job_id: t.job_id, parent_task_id: t.parent_task_id, run_scope: t.run_scope,
            created: t.created,
            events: tasks?.read ? (tasks.read(t.task_id, 'events') ?? []) : [],
          })),
          jobs: (jobs?.list?.() ?? []).filter((j) => j.session_scope === scope || j.sessionId === scope),
        };
        writeFileSync(out, JSON.stringify(bundle, null, 2));
        return { file: out, format: 'debug', tasks: bundle.tasks.length };
      }
      const html = await box.s.exportToHtml?.();
      return { file: html ?? null, format: 'html' };
    },
    subscribe: (listener) => {
      uiListeners.add(listener);
      return () => uiListeners.delete(listener);
    },
    // Plain-data replay of the current session — what a UI needs to redraw
    // the transcript after a session_switch without knowing Pi message shapes.
    history: async () => (box.s.messages ?? []).map((m) => {
      const blocks = Array.isArray(m.content) ? m.content : [];
      const textOf = (type) => blocks.filter((b) => b?.type === type)
        .map((b) => b.text ?? b.thinking ?? '').join('');
      return {
        role: m.role ?? 'unknown',
        text: textOf('text') || (typeof m.content === 'string' ? m.content : ''),
        thinking: textOf('thinking') || null,
        toolName: m.toolName ?? m.name ?? null,
        tools: blocks.filter((b) => b?.type === 'toolCall' || b?.type === 'tool_use')
          .map((b) => b.name ?? b.toolName ?? 'tool'),
        model: m.role === 'assistant' && m.model
          ? { provider: m.model.provider, id: m.model.id }
          : (m.provider ? { provider: m.provider, id: m.responseModel ?? null } : null),
        usage: m.usage ?? null,
        error: m.errorMessage ?? null,
      };
    }),
  };

  // Model/auth surface — the body's ModelRuntime owns models.json + auth.json
  // under the instance's agentDir. Plain data out; key material never returns.
  // Model aliases (Gemini CLI alias analogue): <instance>/model-aliases.json
  // maps short names → {provider, model[, thinking]}. Read per call so edits
  // take effect without respawn.
  const aliasPath = core.paths.root ? join(core.paths.root, 'model-aliases.json') : null;
  const readAliases = () => {
    if (!aliasPath) return {};
    try { return JSON.parse(readFileSync(aliasPath, 'utf-8')); }
    catch { return {}; }
  };
  const writeAliases = (doc) => {
    if (!aliasPath) throw new Error('instance root unavailable');
    writeFileSync(aliasPath, JSON.stringify(doc, null, 2));
  };

  const modelsFacade = {
    status: async () => {
      const s = box.s;
      const rt = s.modelRuntime;
      // getProviders() is the full composed catalog (builtins + models.json
      // customs + extension providers); getRegisteredProviderIds() is only
      // the extension-registered subset — wrong source for a settings UI.
      const providers = rt.getProviders().map((p) => ({
        id: p.id,
        name: p.name ?? p.id,
        hasAuth: rt.hasConfiguredAuth(p.id),
        authStatus: rt.getProviderAuthStatus(p.id),
        oauth: rt.isUsingOAuth(p.id),
      }));
      const available = await rt.getAvailable().catch(() => []);
      return {
        current: s.model
          ? { provider: s.model.provider, id: s.model.id, name: s.model.name ?? s.model.id, reasoning: Boolean(s.model.reasoning) }
          : null,
        thinkingLevel: s.thinkingLevel ?? null,
        defaultModel: s.settingsManager?.getDefaultModel?.() ?? null,
        defaultProvider: s.settingsManager?.getDefaultProvider?.() ?? null,
        providers,
        availableCount: available.length,
      };
    },
    // provider doctor (Cline `doctor` analogue): real connectivity probe —
    // GET {baseUrl}/models with the resolved credential. Returns reachability
    // + auth source; key material never leaves the process.
    ping: async (providerId) => {
      const rt = box.s.modelRuntime;
      const pid = String(providerId ?? '').trim()
        || (box.s.model?.provider ?? rt.getProviders()[0]?.id);
      const p = rt.getProvider(pid);
      if (!p) return { ok: false, error: `unknown provider '${pid}'` };
      const configured = rt.hasConfiguredAuth(pid);
      const auth = await rt.getAuth(pid).catch(() => undefined);
      const base = auth?.auth?.baseUrl ?? p.baseUrl;
      if (!base) return { ok: false, configured, error: 'provider has no baseUrl' };
      const t0 = Date.now();
      try {
        const headers = { ...(p.headers ?? {}), ...(auth?.auth?.headers ?? {}) };
        if (auth?.auth?.apiKey) headers.Authorization = `Bearer ${auth.auth.apiKey}`;
        const res = await fetch(`${String(base).replace(/\/+$/, '')}/models`, {
          headers, signal: AbortSignal.timeout(8000),
        });
        return {
          ok: res.ok, reachable: true, httpStatus: res.status, ms: Date.now() - t0,
          configured, authSource: auth?.source ?? null,
        };
      } catch (e) {
        return { ok: false, reachable: false, configured, error: String(e?.message ?? e), ms: Date.now() - t0 };
      }
    },
    list: async () => {
      const available = await box.s.modelRuntime.getAvailable();
      return available.map((m) => ({
        provider: m.provider,
        id: m.id,
        name: m.name ?? m.id,
        reasoning: Boolean(m.reasoning),
        contextWindow: m.contextWindow ?? null,
        maxTokens: m.maxTokens ?? null,
        // Codex models.json capability declaration — surfaced, not invented:
        // the registry already carries input modalities per model.
        capabilities: {
          vision: Array.isArray(m.input) ? m.input.includes('image') : null,
          tools: true, // every catalog model in this runtime accepts tool calls
          reasoning: Boolean(m.reasoning),
        },
      }));
    },
    set: async ({ provider, model, alias }) => {
      let target = { provider, model };
      if (alias) {
        const hit = readAliases()[String(alias)];
        if (!hit) throw new Error(`model alias '${alias}' is not registered`);
        target = hit;
      }
      const s = box.s;
      const m = s.modelRuntime.getModel(target.provider, target.model);
      if (!m) throw new Error(`model '${target.provider}/${target.model}' is not registered`);
      await s.setModel(m);
      s.settingsManager?.setDefaultModelAndProvider?.(target.provider, target.model);
      if (target.thinking) await modelsFacade.setThinking(target.thinking).catch(() => {});
      return { provider: m.provider, id: m.id, name: m.name ?? m.id, alias: alias ?? null };
    },
    aliasList: () => Object.entries(readAliases()).map(([name, a]) => ({ name, ...a })),
    aliasSet: ({ name, provider, model, thinking }) => {
      if (!name || !provider || !model) throw new Error('alias requires {name, provider, model}');
      const doc = readAliases();
      doc[String(name)] = { provider: String(provider), model: String(model), ...(thinking ? { thinking: String(thinking) } : {}) };
      writeAliases(doc);
      return { name: String(name), ...doc[String(name)] };
    },
    aliasDel: ({ name }) => {
      const doc = readAliases();
      const had = delete doc[String(name)];
      writeAliases(doc);
      return { removed: had };
    },
    setThinking: async (level) => {
      const s = box.s;
      const lvl = String(level).toLowerCase();
      if (!THINKING_LEVELS.has(lvl)) throw new Error(`unknown thinking level '${level}'`);
      s.setThinkingLevel(lvl);
      if (s.model) s.settingsManager?.setModelThinkingLevel?.(s.model.provider, s.model.id, lvl);
      return { thinkingLevel: s.thinkingLevel ?? lvl };
    },
    setApiKey: async ({ provider, key }) => {
      // external secret sources (Bitwarden/1Password "fill without seeing"):
      // op://vault/item/field → `op read`; bw://item → `bw get password`.
      // The resolved key lands in the credential store — the reference itself
      // is never persisted, and resolution failures are reported, never
      // silently stored as a literal key.
      let resolved = key;
      // placeholder keys must not install (competitor pit: `sk-xxx` stored,
      // every call 401s, the failure reads like a provider outage). Real
      // prefixes (sk-ant-, sk-proj-, ghp_…) pass — only obvious templates
      // and toy values are refused.
      if (/^(sk-[x*]{2,}|sk-your|your[-_]|[x*]{4,}|changeme|test[-_]?key|placeholder|api[-_]?key[-_]?(here|goes)|<|insert|paste)/i.test(key) || key.length < 8) {
        return { provider, hasAuth: false, error: 'key looks like a placeholder — paste the real credential' };
      }
      if (/^op:\/\//.test(key) || /^bw:\/\//.test(key)) {
        const { execFileSync } = await import('node:child_process');
        try {
          resolved = /^op:\/\//.test(key)
            ? execFileSync('op', ['read', key], { timeout: 15_000, encoding: 'utf-8', windowsHide: true }).trim()
            : execFileSync('bw', ['get', 'password', key.slice(5)], { timeout: 15_000, encoding: 'utf-8', windowsHide: true }).trim();
        } catch (e) {
          return { provider, hasAuth: false, error: `secret-source resolve failed: ${e.message?.slice(0, 200) ?? 'unknown'}` };
        }
        if (!resolved) return { provider, hasAuth: false, error: 'secret source returned an empty value' };
      }
      await box.s.modelRuntime.setRuntimeApiKey(provider, resolved);
      return { provider, hasAuth: true };
    },
    clearApiKey: async (provider) => {
      await box.s.modelRuntime.removeRuntimeApiKey(provider);
      // honest sign-out: env-var / models.json fallbacks still resolve auth
      // after the runtime key is removed — report what actually remains so
      // the UI can say "signed out but env still provides a key" instead of
      // claiming a clean logout (competitor pit: silent resurrection).
      let residual = false;
      try {
        const auth = await box.s.modelRuntime.getAuth?.(provider);
        residual = Boolean(auth?.apiKey ?? auth?.auth?.apiKey ?? auth?.token);
      } catch { /* probe failure → report removal, not auth state */ }
      return { provider, hasAuth: residual, note: residual ? 'env/config still provides credentials for this provider' : undefined };
    },
    // Custom OpenAI/Anthropic-compatible provider → models.json in agentDir,
    // then a runtime refresh. Keys never go into models.json — auth_set_key
    // writes them to the credential store instead.
    addProvider: async (spec) => {
      const file = join(core.paths.root, 'pi-agent', 'models.json');
      let cfg = { providers: {} };
      if (existsSync(file)) {
        try { cfg = JSON.parse(readFileSync(file, 'utf-8')); } catch { /* rewrite below */ }
      }
      cfg.providers = cfg.providers ?? {};
      cfg.providers[spec.provider] = {
        baseUrl: spec.baseUrl,
        api: spec.api,
        // env-ref only ($NAME) — literal keys belong in the credential store
        // via auth_set_key, never in a committed-able JSON file.
        ...(spec.apiKeyEnv ? { apiKey: `$${spec.apiKeyEnv}` } : {}),
        models: [{
          id: spec.model,
          name: spec.modelName ?? spec.model,
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: spec.contextWindow ?? 128000,
          maxTokens: spec.maxTokens ?? 8192,
        }],
      };
      writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
      await box.s.modelRuntime.refresh?.().catch(() => {});
      return { provider: spec.provider, model: spec.model };
    },
  };

  const auditFacade = {
    tail: (n) => {
      if (!existsSync(auditPath())) return [];
      const lines = readFileSync(auditPath(), 'utf-8').trim().split('\n').filter(Boolean);
      return lines.slice(-n).map((l) => JSON.parse(l));
    },
  };
  const channel = new HostChannel({
    session: sessionFacade,
    jobs,
    jobDetail,
    audit: auditFacade,
    bodies,
    handoff,
    models: modelsFacade,
    sessions,
    asks,
    fileops,
    budget: budget ? {
      status: async () => budget.status(box.s.sessionId ?? box.s.sessionManager?.getSessionId?.() ?? 'unknown'),
    } : null,
    policy: {
      // Read-only posture for UIs — the canonical block itself is only
      // writable through provisioning, never through this surface.
      status: async () => ({
        checksum: core.policy.checksum,
        riskActions: core.policy.doc?.riskActions ?? {},
        budget: core.policy.doc?.budget ?? null,
        toolRules: Object.fromEntries(
          Object.entries(core.policy.toolPolicy ?? {})
            .map(([tool, r]) => [tool, { action: r.action ?? null, requiresPrediction: r.requiresPrediction === true }]),
        ),
        deniedTools: Object.entries(core.policy.toolPolicy ?? {})
          .filter(([, r]) => r?.action === 'deny').map(([t]) => t),
      }),
    },
    modes,
    turns,
    tasks,
    memory,
    exec,
    commands,
    pins,
    verify,
    projectTrust,
    schedules,
    goalStore,
    monitors,
    repoMap,
    skills: knowledge, // skill-doctor stats + allow-list ride the knowledge facade
  });
  const dispose = () => { pump?.(); uiListeners.clear(); channel.dispose(); };
  return { channel, rebind, dispose };
}
