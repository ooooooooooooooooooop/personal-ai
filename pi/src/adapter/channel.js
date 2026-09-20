/**
 * Pi-side channel facade — maps the real AgentSession + host core onto the
 * harness-neutral HostChannel contract. This is where Pi-specific state
 * shapes get translated into plain-data snapshots a UI can consume.
 */
import { HostChannel } from '../../../host/src/core/channel.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
export function createChannelHost({ session, core, jobs = null, jobDetail = null, bodies = null, handoff = null, sessions = null, asks = null, fileops = null, budget = null, writeLease = null, modes = null, hooks = null }) {
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
  const bill = (usage, source) => {
    if (!budget || !usage) return;
    try {
      const scope = box.s.sessionId ?? box.s.sessionManager?.getSessionId?.() ?? 'unknown';
      // tokens/cost only — the provider request itself was already counted
      // at the fetch gate (one HTTP call = one call, retries included)
      budget.record({ scope, source, usage, countCall: false });
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
  const rebind = (newSession) => {
    pump?.();
    box.s = newSession;
    pump = newSession.subscribe((ev) => {
      if (ev?.type === 'message_end' && ev.message?.role === 'assistant' && ev.message?.usage) {
        bill(ev.message.usage, 'turn');
      } else if (ev?.type === 'compaction_end' && ev.result?.usage) {
        bill(ev.result.usage, 'compaction');
      } else if (ev?.type === 'tool_execution_end' && writeLease) {
        // belt for the afterToolCall release — idempotent, holder-matched
        writeLease.release(`fg:${ev.toolCallId}`);
        hooks?.fire('tool_end', { toolName: ev.toolName, isError: Boolean(ev.isError) });
      } else if (ev?.type === 'agent_end' && writeLease) {
        // abort can skip afterToolCall — sweep any foreground-held lease so a
        // dead write never wedges the workspace
        const h = writeLease.held();
        if (h?.holder?.startsWith('fg:')) writeLease.release(h.holder);
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
      return box.s.prompt(message, options);
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
    export: async () => {
      const html = await box.s.exportToHtml?.();
      return { file: html ?? null };
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
    list: async () => {
      const available = await box.s.modelRuntime.getAvailable();
      return available.map((m) => ({
        provider: m.provider,
        id: m.id,
        name: m.name ?? m.id,
        reasoning: Boolean(m.reasoning),
        contextWindow: m.contextWindow ?? null,
        maxTokens: m.maxTokens ?? null,
      }));
    },
    set: async ({ provider, model }) => {
      const s = box.s;
      const m = s.modelRuntime.getModel(provider, model);
      if (!m) throw new Error(`model '${provider}/${model}' is not registered`);
      await s.setModel(m);
      s.settingsManager?.setDefaultModelAndProvider?.(provider, model);
      return { provider: m.provider, id: m.id, name: m.name ?? m.id };
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
      await box.s.modelRuntime.setRuntimeApiKey(provider, key);
      return { provider, hasAuth: true };
    },
    clearApiKey: async (provider) => {
      await box.s.modelRuntime.removeRuntimeApiKey(provider);
      return { provider, hasAuth: false };
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
  });
  const dispose = () => { pump?.(); uiListeners.clear(); channel.dispose(); };
  return { channel, rebind, dispose };
}
