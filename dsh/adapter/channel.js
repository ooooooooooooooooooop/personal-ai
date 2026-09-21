/**
 * DSH channel host — drives a `dsh --profile web` server's Typert API behind
 * the harness-neutral HostChannel contract.
 *
 * Direction is dsh → host: this file imports host contracts (HostChannel,
 * PendingAsks); host/ never imports dsh/. The web server it talks to is the
 * body's own runtime — spawned by bin/dsh-channel.js, which owns its life.
 *
 * D1 surface (transport + HostChannel parity):
 *   prompt/steer → session.prompt (queue/steer modes)
 *   abort        → session.cancel
 *   get_state    → describe + live turn state
 *   history      → session.history folded into plain message rows
 *   subscribe    → events.mux frames translated to host UI events
 *   sessions     → session.list/create/rename (+ open = retarget sessionId)
 *   models       → session.models / llm.models / session.selectModel
 *   approvals + questions (mux answerable frames) → PendingAsks → UI cards →
 *   /api/respond — the same operator surface governs both bodies.
 *
 * U1 projection: session/jobs + session/projection frames are captured and
 * surfaced read-only through job_list/get_state — the body's own durable
 * jobs and goal tree become visible in the task center. Cancel/lease stay
 * unimplemented (fail closed).
 *
 * Still not projected (fail closed, not faked): session_compact/entries/
 * rewind/stats/export, fileops, handoff. HostChannel reports them
 * 'unavailable' rather than pretending DSH speaks host durability yet.
 */
import { HostChannel } from '../../host/src/core/channel.js';
import { PendingAsks } from '../../host/src/core/asks.js';
import { hashOf } from '../../host/src/core/audit.js';
import { MUX_EVENTS_PATH, HOST_EVENTS_PATH } from './typert-paths.js';

const textOf = (blocks) => (blocks ?? [])
  .filter((b) => b?.type === 'text')
  .map((b) => b.text ?? '')
  .join('');
const thinkOf = (blocks) => (blocks ?? [])
  .filter((b) => b?.type === 'reasoning')
  .map((b) => b.text ?? '')
  .join('');
const toolNamesOf = (blocks) => (blocks ?? [])
  .filter((b) => b?.type === 'tool-call')
  .map((b) => b.name ?? 'tool');

/** Fold one session.history page into the UI's plain message rows. */
function foldHistory(entries) {
  const rows = [];
  for (const { event } of entries ?? []) {
    const d = event?.data ?? event ?? {};
    switch (event?.type) {
      case 'user/message':
        rows.push({ role: 'user', text: textOf(d.content), thinking: null, tools: [], model: null, usage: null, error: null });
        break;
      case 'assistant/message':
        rows.push({
          role: 'assistant',
          text: textOf(d.message?.content),
          thinking: thinkOf(d.message?.content) || null,
          tools: toolNamesOf(d.message?.content),
          model: d.message?.source?.model ?? null,
          usage: d.usage ?? null,
          error: d.interrupted ? 'interrupted' : null,
        });
        break;
      case 'tool/result':
        rows.push({
          role: 'toolResult',
          text: textOf(d.message?.content),
          thinking: null,
          tools: [],
          model: null,
          usage: null,
          error: d.error?.name ?? null,
        });
        break;
      default:
        break; // non-surface events are log-only — not transcript rows
    }
  }
  return rows;
}

/**
 * @param {object} deps
 * @param {object} deps.client   createTypertClient() result
 * @param {string} deps.sessionId initial DSH session id
 * @param {string} deps.cwd       session working directory (for create/open)
 * @param {object} [deps.facts]   DshBody.facts() for body_info
 * @param {object} [deps.audit]   AuditWriter — D3: DSH tool calls and
 *        operator asks land in the canonical audit stream (DSH_* kinds).
 *        Absent = observable-only channel (tests, dry runs).
 * @returns {{channel: HostChannel, dispose: () => void}}
 */
export function createDshChannel({ client, sessionId, cwd, facts = null, audit = null }) {
  const uiListeners = new Set();
  const emit = (ev) => {
    for (const l of uiListeners) {
      try { l(ev); } catch { /* dead UI listener must not break the pump */ }
    }
  };

  const state = {
    sessionId,
    streaming: false,
    // assistant chunk assembly — per-block text buffers keyed by stream index
    pendingText: new Map(),
    pendingThink: new Map(),
    todos: [],
    model: null, // last observed selection (session.models refresh)
    jobs: [], // last session/jobs frame, normalized to job_list rows
    projection: null, // last session/projection frame (goal/subagent tree)
  };

  const asks = new PendingAsks({});

  /* ---------- mux event pump (reconnecting, single generation at a time) ---------- */
  let running = true;
  let socket = null;
  let retryMs = 500;

  const flushStreamBlocks = () => {
    const text = [...state.pendingText.values()].join('');
    const thinking = [...state.pendingThink.values()].join('');
    if (text) emit({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text }] } });
    if (thinking) {
      emit({
        type: 'message_update',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking }, { type: 'text', text }] },
      });
    }
  };

  function onSessionEvent(sessionIdOfFrame, ev, view) {
    if (sessionIdOfFrame !== state.sessionId) return; // other sessions' events are not ours
    const d = ev?.data ?? {};
    switch (ev?.type) {
      case 'turn/start':
        state.streaming = true;
        state.pendingText.clear();
        state.pendingThink.clear();
        emit({ type: 'agent_start' });
        break;
      case 'turn/end':
        state.streaming = false;
        emit({ type: 'agent_end', reason: d.reason ?? null });
        break;
      case 'user/message':
        if (d.source?.kind === 'human') {
          emit({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: textOf(d.content) }] } });
        }
        break;
      case 'assistant/chunk': {
        const c = d.chunk;
        if (c?.type === 'block-start' && (c.blockType === 'text' || c.blockType === 'reasoning')) {
          if (!state.pendingText.size && !state.pendingThink.size) {
            emit({ type: 'message_start', message: { role: 'assistant' } });
          }
        } else if (c?.type === 'text-delta') {
          state.pendingText.set(c.index, (state.pendingText.get(c.index) ?? '') + c.text);
          flushStreamBlocks();
        } else if (c?.type === 'reasoning-delta') {
          state.pendingThink.set(c.index, (state.pendingThink.get(c.index) ?? '') + c.text);
          flushStreamBlocks();
        }
        break;
      }
      case 'assistant/message': {
        state.pendingText.clear();
        state.pendingThink.clear();
        const m = d.message;
        emit({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: m?.content ?? [],
            usage: d.usage ?? null,
            errorMessage: d.interrupted ? 'interrupted' : null,
            model: m?.source?.model ?? null,
          },
        });
        break;
      }
      case 'tool/call': {
        let args = null;
        try { args = JSON.parse(d.arguments); } catch { args = d.arguments; }
        audit?.write({
          kind: 'DSH_TOOL_CALL', toolName: d.name ?? 'tool',
          data: { callId: d.callId ?? null, argsHash: hashOf(JSON.stringify(args ?? null)) },
        });
        emit({
          type: 'tool_execution_start',
          toolCallId: d.callId,
          toolName: d.name,
          args,
          view: view?.for === 'call' ? view.view : null,
        });
        break;
      }
      case 'tool/result': {
        const block = d.message?.content?.[0];
        audit?.write({
          kind: 'DSH_TOOL_RESULT', toolName: block?.name ?? 'tool',
          data: { callId: block?.toolCallId ?? d.callId ?? null, isError: Boolean(d.error) || block?.isError === true },
        });
        emit({
          type: 'tool_execution_end',
          toolCallId: block?.toolCallId ?? d.callId ?? null,
          toolName: block?.name ?? null,
          result: textOf(block?.content) || block?.content,
          isError: Boolean(d.error) || block?.isError === true,
          view: view?.for === 'result' ? view.view : null,
        });
        break;
      }
      case 'compaction/start':
        emit({ type: 'compaction_start', reason: d.reason ?? 'threshold' });
        break;
      case 'compaction/end':
        emit({ type: 'compaction_end', aborted: Boolean(d.aborted), errorMessage: d.error?.message ?? null });
        break;
      case 'todo/write':
        state.todos = Array.isArray(d.todos) ? d.todos : [];
        emit({ type: 'todos_changed', todos: state.todos });
        break;
      case 'session/title':
        emit({ type: 'session_info_changed' });
        break;
      default:
        break; // log-only / unknown events are ignored, never faked
    }
  }

  async function onAnswerableFrame(frame) {
    // Answerable server-requests: echo the frame's rpcId on /api/respond.
    const p = frame.payload;
    if (p?.type === 'approval/requested') {
      audit?.write({
        kind: 'DSH_ASK', toolName: p.toolName ?? 'unknown',
        data: { callId: p.callId ?? null, approvalId: p.approvalId ?? null, rule: 'dsh-approval' },
      });
      const answer = await asks.ask({
        toolName: p.toolName ?? 'unknown',
        toolCallId: p.callId ?? null,
        rule: 'dsh-approval',
        summary: p.reason ?? `DSH requests approval for ${p.toolName}`,
      });
      audit?.write({
        kind: 'DSH_ASK_RESOLVED', toolName: p.toolName ?? 'unknown',
        data: { callId: p.callId ?? null, approvalId: p.approvalId ?? null, answer },
      });
      await client.respond(frame.rpcId, {
        sessionId: p.sessionId,
        approvalId: p.approvalId,
        outcome: (answer === 'allow' || answer === 'allow_session') ? 'allowed-once' : 'rejected',
      }).catch(() => {});
    } else if (p?.type === 'question/requested') {
      const qs = Array.isArray(p.questions) ? p.questions : [];
      const first = qs[0] ?? {};
      audit?.write({
        kind: 'DSH_ASK', toolName: 'ask_user',
        data: { approvalId: p.approvalId ?? null, rule: 'dsh-question', questions: qs.length },
      });
      const answer = await asks.ask({
        kind: 'question',
        toolName: 'ask_user',
        toolCallId: null,
        rule: 'dsh-question',
        summary: qs.map((q) => q.question).filter(Boolean).join('\n') || 'DSH asks a question',
        options: (first.options ?? []).map((o) => ({ label: String(o?.label ?? ''), description: o?.description ?? null })),
      });
      const refused = ['deny', 'timeout', 'aborted'].includes(answer);
      audit?.write({
        kind: 'DSH_ASK_RESOLVED', toolName: 'ask_user',
        data: { approvalId: p.approvalId ?? null, answer: refused ? answer : 'answered' },
      });
      await client.respond(frame.rpcId, {
        sessionId: p.sessionId,
        answer: refused
          ? { answers: [] }
          : {
              answers: qs.map((q) => ({
                id: q.id,
                selected: (q.options ?? []).some((o) => o?.label === answer) ? [answer] : [],
                custom: (q.options ?? []).some((o) => o?.label === answer) ? undefined : answer,
              })),
            },
      }).catch(() => {});
    }
  }

  function pump() {
    socket = client.openStream(MUX_EVENTS_PATH, {
      onOpen: () => { retryMs = 500; },
      onFrame: (frame) => {
        const p = frame.payload;
        if (p?.type === 'session/event') onSessionEvent(p.sessionId, p.event, p.view);
        else if (p?.type === 'approval/requested' || p?.type === 'question/requested') onAnswerableFrame(frame);
        else if (p?.type === 'session/jobs') {
          // U1: project the body's own durable jobs into job_list rows.
          const items = Array.isArray(p.jobs) ? p.jobs : Array.isArray(p.items) ? p.items : [];
          state.jobs = items
            .map((j) => ({
              job_id: String(j.job_id ?? j.id ?? ''),
              job_type: j.job_type ?? j.type ?? j.kind ?? 'dsh',
              job_state: j.job_state ?? j.state ?? j.status ?? '',
              updated_at: j.updated_at ?? j.updatedAt ?? null,
              command: j.command ?? j.label ?? null,
            }))
            .filter((j) => j.job_id);
          emit({ type: 'jobs_changed' });
        } else if (p?.type === 'session/projection') {
          // U1: goal/subagent tree — exposed via get_state + projection event.
          state.projection = p.projection ?? p;
          emit({ type: 'projection', projection: state.projection });
        } else if (p?.type === 'session/queue' || p?.type === 'session/subscribed') {
          // queue/subscribe bookkeeping — no UI surface
        }
      },
      onClose: () => {
        if (!running) return;
        const t = setTimeout(pump, retryMs);
        t.unref?.();
        retryMs = Math.min(retryMs * 2, 8000);
      },
    });
  }
  pump();

  /* ---------- facades ---------- */
  const sessionFacade = {
    prompt: async (message, _options) => {
      await client.call('session.prompt', {
        sessionId: state.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: String(message) }],
      });
    },
    steer: async (message) => {
      await client.call('session.prompt', {
        sessionId: state.sessionId,
        mode: 'steer',
        content: [{ type: 'text', text: String(message) }],
      });
    },
    abort: async () => {
      await client.call('session.cancel', { sessionId: state.sessionId });
      asks.abortPending();
    },
    getState: async () => ({
      model: state.model,
      streaming: state.streaming,
      messageCount: null,
      thinkingLevel: null,
      session: { id: state.sessionId, name: null, file: null },
      contextUsage: null,
      projection: state.projection,
    }),
    subscribe: (listener) => {
      uiListeners.add(listener);
      return () => uiListeners.delete(listener);
    },
    history: async () => {
      const page = await client.call('session.history', { sessionId: state.sessionId, maxMessages: 200 });
      return foldHistory(page?.events);
    },
  };

  const sessionsFacade = {
    list: async () => {
      const r = await client.call('session.list', {});
      const items = r?.sessions ?? r ?? [];
      return (Array.isArray(items) ? items : []).map((s) => ({
        id: s.sessionId ?? s.id,
        file: s.sessionId ?? s.id,
        title: s.title ?? s.name ?? null,
        updated: s.lastPromptAt ?? s.updatedAt ?? null,
        blank: s.blank ?? false,
      }));
    },
    create: async () => {
      const r = await client.call('session.create', { cwd });
      state.sessionId = r.sessionId;
      state.pendingText.clear();
      state.pendingThink.clear();
      emit({ type: 'session_changed', session: { id: r.sessionId, file: r.sessionId } });
      return { id: r.sessionId };
    },
    open: async (path) => {
      // HostChannel passes the list row's `file` — we minted it as sessionId.
      const r = await client.call('session.create', { sessionId: String(path), cwd });
      state.sessionId = r.sessionId;
      state.pendingText.clear();
      state.pendingThink.clear();
      emit({ type: 'session_changed', session: { id: r.sessionId, file: r.sessionId } });
      return { id: r.sessionId };
    },
    rename: async (name) => {
      await client.call('session.rename', { sessionId: state.sessionId, title: String(name) });
      return { title: name };
    },
    search: async (query) => {
      const r = await client.call('session.search', { query: String(query) });
      return r?.results ?? r ?? [];
    },
    fork: async (path) => {
      const r = await client.call('session.fork', { sessionId: String(path) });
      return { id: r?.sessionId ?? null };
    },
  };

  const modelsFacade = {
    status: async () => {
      const providers = await client.call('llm.providers', {}).catch(() => null);
      const selected = await client.call('session.models', { sessionId: state.sessionId }).catch(() => null);
      const current = selected?.current ?? selected?.selected ?? null;
      if (current) state.model = current;
      return {
        current,
        thinkingLevel: selected?.reasoningEffort ?? null,
        defaultModel: null,
        defaultProvider: null,
        providers: (providers?.providers ?? providers ?? []).map?.((p) => ({
          id: p.id ?? p.provider,
          name: p.name ?? p.id ?? p.provider,
          hasAuth: p.hasAuth ?? null,
          authStatus: p.authStatus ?? null,
          oauth: p.oauth ?? null,
        })) ?? [],
        availableCount: null,
      };
    },
    list: async () => {
      const r = await client.call('llm.models', {}).catch(() => null);
      const items = r?.models ?? r ?? [];
      return (Array.isArray(items) ? items : []).map((m) => ({
        provider: m.provider,
        id: m.id ?? m.model,
        name: m.name ?? m.id ?? m.model,
        reasoning: m.reasoning ?? null,
        contextWindow: m.contextWindow ?? null,
        maxTokens: m.maxTokens ?? null,
      }));
    },
    set: async ({ provider, model }) => {
      const r = await client.call('session.selectModel', { sessionId: state.sessionId, provider, model });
      state.model = r?.selected ?? { provider, id: model };
      return state.model;
    },
    setThinking: async (level) => {
      const sel = state.model ?? {};
      const r = await client.call('session.selectModel', {
        sessionId: state.sessionId,
        provider: sel.provider,
        model: sel.id ?? sel.model,
        reasoningEffort: String(level),
      });
      return { thinkingLevel: r?.selected?.reasoningEffort ?? level };
    },
  };

  const bodiesFacade = {
    current: async () => ({ body_id: 'dsh', facts, selection: null }),
  };

  const todosFacade = { list: async () => state.todos };

  // Read-only projection of the body's own durable jobs (session/jobs frames).
  // cancel/attempts/lease stay unimplemented — job_cancel fails closed rather
  // than pretending we can kill DSH-side work.
  const jobsFacade = {
    listRecent: (n) =>
      [...state.jobs]
        .sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))
        .slice(0, n ?? 20),
    getJob: (id) => state.jobs.find((j) => j.job_id === id) ?? null,
    getAttempts: () => [],
    getLease: () => null,
  };

  const channel = new HostChannel({
    session: sessionFacade,
    sessions: sessionsFacade,
    models: modelsFacade,
    bodies: bodiesFacade,
    todos: todosFacade,
    jobs: jobsFacade,
    asks,
  });

  const dispose = () => {
    running = false;
    socket?.close();
    asks.dispose();
    channel.dispose();
  };

  return { channel, dispose, state };
}
