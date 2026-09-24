/**
 * Pi-side channel facade — maps the real AgentSession + host core onto the
 * harness-neutral HostChannel contract. This is where Pi-specific state
 * shapes get translated into plain-data snapshots a UI can consume.
 */
import { HostChannel } from '../../../host/src/core/channel.js';
import { normalizeAttachments, partitionByCapability, describeAttachment, extractAttachmentText, materializeImageSource, pngDownscale, persistAttachment, sniffMime } from '../../../host/src/core/attachments.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { join, dirname, resolve } from 'node:path';
import { pathInsideRoot, pathInsideRootReal, pathInsideRootForWrite } from './paths.js';
import { isPrivateResolved } from './web.js';
import { parseSecretRef, resolveSecretRef } from '../../../host/src/core/secretsource.js';
import { redactSecrets } from '../../../host/src/core/secrets.js';
import { resolveRoute } from './modelroutes.js';

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

// dedup-h #1867: codecs every major vision provider reads natively. Anything
// else (heic/tiff/svg/ico/bmp-untranscoded/avif…) must never reach the wire
// as an image block — it degrades to an honest descriptor at attach time.
const VISION_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// dedup-h #2051: a model's input declaration treats EMPTY the same as
// ABSENT — `input: []` means "nothing declared", not "accepts nothing".
// Both readers below (the carry gate and the media-fallback pick) share
// this predicate; testing the raw list directly is how an empty list
// silently stripped image input upstream.
function acceptsImages(input) {
  return !Array.isArray(input) || input.length === 0 || input.includes('image');
}

/** Atomic JSON write: tmp + rename — a torn write must not leave a half-file
 * behind (credential/config corruption is unrecoverable by reload). */
function writeJsonAtomic(file, doc) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  renameSync(tmp, file);
}

function writeTextAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** dedup-h #74: session JSONL → markdown transcript (quarto = same doc
 * with YAML frontmatter). Full-fidelity readable form: every message
 * role, text, tool call (fenced args) and tool result (fenced, capped).
 * Torn tail lines are skipped, never fatal. */
function sessionToMarkdown(sessionFile, { quarto = false, sessionId = null } = {}) {
  const lines = readFileSync(sessionFile, 'utf-8').split('\n').filter(Boolean);
  const out = [];
  if (quarto) {
    out.push('---', `title: "Session ${sessionId ?? 'transcript'}"`,
      `date: "${new Date().toISOString()}"`, 'format: html', '---', '');
  } else {
    out.push(`# Session ${sessionId ?? 'transcript'}`, '', `> exported ${new Date().toISOString()}`, '');
  }
  const fence = (text, lang = '') => {
    const t = String(text ?? '');
    const ticks = t.includes('```') ? '````' : '```';
    return `${ticks}${lang}\n${t}\n${ticks}`;
  };
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const msg = e?.message ?? (e?.type === 'message' ? e : null);
    if (!msg?.role) continue;
    const ts = e?.timestamp ?? msg?.timestamp ?? null;
    const stamp = ts ? ` — ${new Date(ts).toISOString()}` : '';
    const role = { user: 'User', assistant: 'Assistant', toolResult: 'Tool result' }[msg.role] ?? msg.role;
    const blocks = Array.isArray(msg.content) ? msg.content
      : (typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : []);
    if (!blocks.length && msg.role === 'toolResult') {
      blocks.push({ type: 'text', text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '') });
    }
    const parts = [];
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'text') parts.push(String(b.text ?? ''));
      else if (b.type === 'thinking') parts.push(`*thinking*\n\n${fence(b.thinking ?? b.text ?? '')}`);
      else if (b.type === 'toolCall' || b.type === 'tool_use') {
        parts.push(`**🔧 ${b.name ?? b.toolName ?? 'tool'}**\n\n${fence(JSON.stringify(b.arguments ?? b.input ?? {}, null, 2), 'json')}`);
      } else if (b.type === 'tool_result' || b.type === 'toolResult') {
        const text = Array.isArray(b.content) ? b.content.map((c) => c?.text ?? '').join('\n') : String(b.content ?? b.text ?? '');
        parts.push(`**result${b.isError ? ' (error)' : ''}**\n\n${fence(text.length > 4000 ? `${text.slice(0, 4000)}\n…[truncated]` : text)}`);
      } else if (b.type === 'image' || b.type === 'resource') {
        parts.push(`*[${b.type} attachment: ${b.name ?? b.mimeType ?? 'blob'}]*`);
      } else parts.push(fence(JSON.stringify(b, null, 2), 'json'));
    }
    if (parts.length) out.push(`## ${role}${stamp}`, '', parts.join('\n\n'), '');
  }
  return out.join('\n');
}

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

export function createChannelHost({ session, core, jobs = null, jobDetail = null, bodies = null, handoff = null, sessions = null, asks = null, fileops = null, budget = null, writeLease = null, modes = null, hooks = null, turns = null, tasks = null, memory = null, knowledge = null, exec = null, goals = null, verify = null, commands = null, pins = null, getLoopwatch = null, projectTrust = null, schedules = null, repoMap = null, workdir = null, goalStore = null, monitors = null, webhooks = null, scan = null, imageDetail = null, fallbacks = null, leases = null, sessionFlags = null, proxy = null, structured = null, mcp = null, preToolGate = null, assist = null, secretSpawnFn = null, modelRoutes = null }) {

  // Mutable session holder + fan-out pump: the facade delegates to whichever
  // session is current; rebind() retargets the pump to a rebuilt session.
  const box = { s: session };
  const uiListeners = new Set();
  const emit = (ev) => {
    for (const l of uiListeners) {
      try { l(ev); } catch { /* a dead UI listener must not break the pump */ }
    }
    if (ev?.type === 'notify') hooks?.fire('notification', { message: String(ev.message ?? '').slice(0, 300), level: ev.level ?? 'info' });
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
        // dedup-h #1188 — message_sent observational hook: outbound assistant
        // message with an enriched payload (text tail, char count, model,
        // usage) — the OpenClaw message:preprocessed/sent analogue on the
        // outbound side. Text is bounded; hooks get JSON on stdin.
        try {
          const text = (Array.isArray(ev.message?.content) ? ev.message.content : [])
            .map((c) => (c?.type === 'text' ? c.text : '')).join('').slice(0, 4000);
          hooks?.fire('message_sent', {
            text, chars: text.length,
            model: ev.message?.model ?? null,
            usage: ev.message.usage ?? null,
          });
        } catch { /* observational — never blocks the lifecycle */ }
        // dedup-h #1922 — transform_llm_output gate: the operator-private
        // hook may reshape the DELIVERED assistant text. Session state and
        // the transcript keep the model's true output (no self-deception,
        // audit trail intact); the emitted display gets the governed text
        // via a follow-up message_update. A deny/error/withheld fails
        // CLOSED — a broken filter never leaks unfiltered output.
        if (preToolGate) {
          const msg = ev.message;
          // the gate sees the FULL text (bounded for stdin), not the 4000-char
          // observational preview — a transform that only saw a prefix would
          // silently truncate long outputs
          const fullText = (Array.isArray(msg?.content) ? msg.content : [])
            .map((c) => (c?.type === 'text' ? c.text : '')).join('').slice(0, 64000);
          const showTransformed = (next) => emit({
            type: 'message_update',
            message: {
              ...msg,
              content: [
                ...(Array.isArray(msg.content) ? msg.content.filter((c) => c?.type !== 'text') : []),
                { type: 'text', text: next },
              ],
            },
          });
          if (fullText) {
            preToolGate.fireGate('transform_llm_output', {
              text: fullText, model: ev.message?.model ?? null, usage: ev.message.usage ?? null,
            }).then((ans) => {
              if (ans?.text) {
                core.audit?.write({ kind: 'LLM_OUTPUT_TRANSFORMED', data: { before: fullText.length, after: ans.text.length } });
                showTransformed(ans.text);
              } else if (ans?.deny || ans?.requireApproval) {
                const why = String(ans.deny ?? 'approval required').slice(0, 200);
                core.audit?.write({ kind: 'LLM_OUTPUT_WITHHELD', data: { reason: why } });
                showTransformed(`[llm output withheld by transform gate: ${why}]`);
              }
            }).catch((e) => {
              core.audit?.write({ kind: 'LLM_OUTPUT_WITHHELD', data: { reason: String(e?.message ?? e).slice(0, 200) } });
              showTransformed('[llm output withheld — transform gate failed closed]');
            });
          }
        }
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
        if (ev.toolName?.startsWith('delegate')) hooks?.fire('subagent_start', { toolName: ev.toolName, toolCallId: ev.toolCallId });
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
        if (ev.toolName?.startsWith('delegate')) hooks?.fire('subagent_stop', { toolName: ev.toolName, toolCallId: ev.toolCallId, isError: Boolean(ev.isError) });
      } else if (ev?.type === 'turn_start') {
        hooks?.fire('turn_started', {});
      } else if (ev?.type === 'agent_end') {
        hooks?.fire('agent_stop', {});
        // dedup-h #1034 — gate agent_stop hook may block the stop: the agent
        // continues with the reason as a fresh prompt (Claude Code Stop hook
        // semantics). Bounded by a consecutive-continuation cap so a stuck
        // hook cannot loop the agent forever; an entry flag
        // continueOnBlock:false disables continuation. A broken gate never
        // manufactures work — its failure lets the turn end + audits.
        if (preToolGate && box.s) {
          Promise.resolve().then(async () => {
            let g = null;
            try {
              g = await preToolGate.fireValue('agent_stop', { sessionId: box.s?.sessionId ?? null });
            } catch (e) {
              core.audit?.write({ kind: 'AGENT_STOP_GATE_FAILED', data: { error: String(e?.message ?? e).slice(0, 300) } });
              return;
            }
            const reason = g && typeof (g.block ?? g.deny) === 'string' ? String(g.block ?? g.deny).slice(0, 500) : null;
            if (!reason || g?.hookEntry?.continueOnBlock === false) return;
            stopContinues++;
            if (stopContinues > 3) {
              core.audit?.write({ kind: 'AGENT_STOP_CONTINUE_CAP', data: { reason } });
              return;
            }
            core.audit?.write({ kind: 'AGENT_STOP_CONTINUED', data: { reason: reason.slice(0, 200), n: stopContinues } });
            try {
              await sessionFacade.prompt(
                `[stop-gate] 收尾被操作员钩子阻断：${reason}\n请继续完成任务。`,
                { _continuation: true });
            } catch (e) {
              core.audit?.write({ kind: 'AGENT_STOP_CONTINUE_FAILED', data: { error: String(e?.message ?? e).slice(0, 200) } });
            }
          }).catch(() => {});
        }
      } else if (ev?.type === 'compaction_start') {
        // dedup-h #535: hooks see WHY the compaction fired — the engine
        // already classifies reason (manual|threshold|overflow); dropping
        // it would force hook scripts to re-derive a worse guess.
        hooks?.fire('compact_start', { reason: ev.reason ?? null, runId: ev.runId ?? null });
      } else if (ev?.type === 'compaction_end') {
        hooks?.fire('compact_end', {
          reason: ev.reason ?? null, runId: ev.runId ?? null,
          status: ev.status ?? null, error: ev.error ? String(ev.error?.message ?? ev.error).slice(0, 300) : null,
        });
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

  // dedup-h #1034: consecutive stop-gate continuations — resets on any
  // non-continuation prompt so a healthy operator turn always re-arms.
  let stopContinues = 0;

  // dedup-h #2101 — project kill switch (.zed/settings.json disable_ai
  // analogue): <workdir>/.pai/settings.json {disable_ai:true} refuses AI
  // turns for this project. Re-read per prompt so a live flip applies
  // immediately; absent/malformed file = enabled. This gates model turns
  // only — bash_run/jobs/exec are not "AI features" and stay reachable.
  const projectAiDisabled = () => {
    if (!workdir) return false;
    try {
      return JSON.parse(readFileSync(join(workdir, '.pai', 'settings.json'), 'utf-8'))?.disable_ai === true;
    } catch { return false; }
  };

  // dedup-h #2118 — crush "Adaptive" default model: model-routes.json
  // {adaptive:true} resolves every prompt's text against the routing table
  // and switches the session model/effort per turn. An explicit pick
  // (model_set / config_set model) pins the session out of adaptive; the
  // 'adaptive' alias un-pins. Route misses leave the current model alone —
  // "no rule" is not a mandate to churn the operator's default.
  let modelPinned = false;
  const resolveRoutedModel = async (name) => {
    const rt = box.s?.modelRuntime;
    if (!rt || typeof name !== 'string' || !name.trim()) return null;
    const slash = name.trim().match(/^([a-z0-9_.-]+)\/(\S+)$/i);
    if (slash) {
      try { return rt.getModel(slash[1], slash[2]) ?? null; } catch { return null; }
    }
    const avail = await rt.getAvailable?.().catch(() => []);
    return (Array.isArray(avail) ? avail : []).find((m) => m?.id === name.trim()) ?? null;
  };
  const EFFORT_TO_THINKING = { max: 'xhigh' };
  const applyAdaptiveRoute = async (text) => {
    if (!modelRoutes?.adaptive || modelPinned) return;
    const route = resolveRoute(modelRoutes, { target: 'main', task: String(text ?? '') });
    if (!route) return;
    if (route.model) {
      const m = await resolveRoutedModel(route.model);
      if (m && (m.id !== box.s?.model?.id || m.provider !== box.s?.model?.provider)) {
        const ok = await box.s.setModel(m).then(() => true, () => false);
        core.audit?.write({
          kind: ok ? 'MODEL_ROUTED' : 'MODEL_ROUTE_FAILED',
          data: { via: route.via, model: `${m.provider}/${m.id}`, effort: route.effort ?? null },
        });
      }
    }
    if (route.effort) {
      // Route effort maps onto the thinking ladder; a non-reasoning target
      // rejects the level — that failure must never fail the prompt.
      try { await modelsFacade.setThinking(EFFORT_TO_THINKING[route.effort] ?? route.effort); } catch { /* advisory */ }
    }
  };

  const sessionFacade = {
    prompt: async (message, options) => {
      if (projectAiDisabled()) {
        core.audit?.write({ kind: 'PROMPT_PROJECT_DISABLED', data: { workdir } });
        throw new Error('AI turns are disabled for this project (.pai/settings.json disable_ai) — remove the flag to re-enable');
      }
      await applyAdaptiveRoute(message);
      admitSpend();
      if (options?._continuation === true) {
        // Internal channel flag (stop-gate continuation) — strip before the
        // options object can ride into engine prompt options.
        const { _continuation, ...rest } = options ?? {};
        options = rest;
      } else {
        stopContinues = 0;
      }
      hooks?.fire('prompt_submit', { preview: String(message ?? '').slice(0, 200) });
      // dedup-h #935 — input intercept/transform: the operator-private gate
      // file may deny the prompt, rewrite it, or prepend context before the
      // model ever sees it. A broken gate hook fails CLOSED (the prompt is
      // refused, never silently passed untransformed).
      if (preToolGate && typeof message === 'string' && message) {
        let g = null;
        try {
          g = await preToolGate.fireValue('prompt_submit', { text: message });
        } catch (e) {
          core.audit?.write({ kind: 'PROMPT_GATE_FAILED', data: { error: String(e?.message ?? e).slice(0, 300) } });
          throw new Error(`prompt_submit gate failed closed: ${String(e?.message ?? e).slice(0, 200)}`);
        }
        if (g) {
          if (typeof g.deny === 'string' && g.deny.trim()) {
            core.audit?.write({ kind: 'PROMPT_GATE_DENIED', data: { reason: g.deny.slice(0, 300) } });
            throw new Error(`prompt_submit gate denied: ${g.deny.slice(0, 300)}`);
          }
          if (typeof g.text === 'string' && g.text.trim()) {
            core.audit?.write({ kind: 'PROMPT_TRANSFORMED', data: { mode: 'replace', from: message.length, to: g.text.length } });
            message = g.text;
          } else if (typeof g.context === 'string' && g.context.trim()) {
            core.audit?.write({ kind: 'PROMPT_TRANSFORMED', data: { mode: 'context', chars: g.context.length } });
            message = `${g.context.trim()}\n\n${message}`;
          }
        }
      }
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
        const caps = { images: acceptsImages(curInput) };
        let { native, degraded } = partitionByCapability(attachments, caps);
        const lostImages = degraded.filter((a) => a.kind === 'image').length;
        if (lostImages && caps.images === false) {
          // dedup-h #181 media auto-fallback: before degrading images to
          // descriptors, walk the operator's fallback chain for a vision-
          // capable model — same-provider or cross-provider, first hit wins.
          // The chain is the operator's preference order; setModel failure
          // (no auth) just continues the search. Nothing found → degrade.
          const rt = box.s?.modelRuntime;
          const prev = box.s?.model;
          // dedup-h #282: the media failover surface is bounded by the
          // operator's models-allow.json — a non-allowed vision entry is
          // skipped and the walk continues, so a text+image prompt stays
          // reachable through the allowlisted remainder of the chain.
          const hit = (fallbacks?.chain ?? [])
            .filter((e) => !fallbacks?.allowed || fallbacks.allowed(e))
            .map((e) => { try { return rt?.getModel?.(e.provider, e.model) ?? null; } catch { return null; } })
            .find((m) => m && acceptsImages(m.input));
          const switched = hit && typeof box.s?.setModel === 'function'
            ? await box.s.setModel(hit).then(() => true, () => false)
            : false;
          if (switched) {
            caps.images = true; // the fallback target carries images natively
            ({ native, degraded } = partitionByCapability(attachments, caps));
            core.audit?.write({
              kind: 'MEDIA_FALLBACK',
              data: { from: `${prev?.provider}/${prev?.id}`, to: `${hit.provider}/${hit.id}`, images: lostImages },
            });
            emit({
              type: 'notify',
              level: 'info',
              message: `图片超出 ${prev?.provider}/${prev?.id} 能力——已按回退链切到视觉模型 ${hit.provider}/${hit.id}，${lostImages} 张图片原生输入`,
            });
          } else {
            emit({
              type: 'notify',
              level: 'warn',
              message: `当前模型 ${box.s?.model?.id ?? '?'} 不支持图片输入——${lostImages} 张图片将降级为文本描述（换个视觉模型可原生看图）`,
            });
          }
        }
        let codecDropped = 0;
        if (native.length) {
          // M137 image_detail tier: high (default) = untouched; balanced /
          // low cap the longest edge (1568px / 512px, OpenAI-grid analogue)
          // via zero-dep PNG halving. Non-PNG codecs can't be rescaled here
          // and ride untouched — honest boundary, no fake transcode.
          const tier = imageDetail?.current ?? 'high';
          const maxEdge = tier === 'low' ? 512 : tier === 'balanced' ? 1568 : Infinity;
          // M139: the model needs a persistent path it can edit/reference
          // later — path sources keep theirs; pasted blobs spill to
          // <instance>/exports/attachments/ and advertise that path.
          const spillDir = core.paths?.root ? join(core.paths.root, 'exports', 'attachments') : null;
          const carried = [];
          for (const a of native) {
            let data = materializeImageSource(a); // path → bytes (was silently undefined)
            if (data == null) { degraded.push(a); continue; }
            // dedup-h #1867 vision-codec gate: provider image surfaces read
            // png/jpeg/gif/webp — heic/tiff/svg/ico & friends must not ride a
            // native image block and die inside the provider request; they
            // degrade to a truthful descriptor at attach time instead. Bytes
            // are ground truth: a sniffed codec overrides the declared mime.
            let effMime = a.mime;
            try {
              const s = sniffMime(Buffer.from(data.slice(0, 96), 'base64'));
              if (s) effMime = s;
            } catch { /* keep declared */ }
            if (!VISION_MIME.has(effMime)) {
              a.mime = effMime; // descriptor names the true codec, not the label
              degraded.push(a); codecDropped++; continue;
            }
            a.mime = effMime; // a mislabeled image rides under its true codec
            if (Number.isFinite(maxEdge) && a.mime === 'image/png') {
              const smaller = pngDownscale(Buffer.from(data, 'base64'), maxEdge);
              if (smaller) {
                data = smaller.toString('base64');
                core.audit?.write({ kind: 'IMAGE_DETAIL_SCALED', data: { name: a.name, tier, from: a.bytes, to: smaller.length } });
              }
            }
            if (a.source.type === 'path') a.persistedPath = a.source.path;
            else if (spillDir) a.persistedPath = persistAttachment(a, spillDir);
            carried.push({ type: 'image', data, mimeType: a.mime });
          }
          if (carried.length) {
            opts = { ...options, images: [...(options.images ?? []), ...carried] };
          }
          const withPath = native.filter((a) => a.persistedPath);
          if (withPath.length) {
            msg = `${msg ?? ''}\n\n${withPath.map((a) =>
              `<attachment kind="image" name="${a.name}" mime="${a.mime}" path="${String(a.persistedPath).replace(/"/g, '')}"/>`
            ).join('\n')}`;
          }
        }
        if (codecDropped) {
          core.audit?.write({ kind: 'ATTACHMENT_CODEC_DEGRADED', data: { count: codecDropped } });
          emit({
            type: 'notify',
            level: 'warn',
            message: `${codecDropped} 张图片格式不可读（HEIC/TIFF/SVG/ICO 等非视觉编码）——已降级为文本描述，模型看不到像素`,
          });
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
      // dedup-h #238 structured output (--output-schema analogue): arming a
      // schema injects the contract and hands the agent_end gate the spec —
      // the loop extension validates the final reply and re-steers on
      // violation. Invalid schemas refuse BEFORE the prompt is sent.
      if (options?.outputSchema != null) {
        const { validateSchemaSpec } = await import('../../host/src/core/jsonschema.js');
        const v = validateSchemaSpec(options.outputSchema);
        if (!v.ok) throw new Error(`outputSchema invalid: ${v.error}`);
        if (structured) {
          structured.schema = options.outputSchema;
          structured.retries = 0;
        }
        msg = `${msg ?? ''}\n\n<output-schema>\n` +
          `Reply with ONLY a JSON object conforming to this schema — no prose, no fences:\n` +
          `${JSON.stringify(options.outputSchema)}\n</output-schema>`;
      }
      // Busy-session queueing: AgentSession.prompt THROWS when streaming and
      // no streamingBehavior is given (SDK contract). An operator prompt sent
      // mid-run must not bounce — queue it as a follow-up (runs after the
      // current run stops, SDK-side, so it survives beyond any volatile
      // client-side queue). Steering is a separate verb (channel 'steer').
      if (box.s.isStreaming) {
        opts = { ...(opts ?? {}), streamingBehavior: 'followUp' };
        hooks?.fire('prompt_queued', { preview: String(message ?? '').slice(0, 200) });
      }
      return box.s.prompt(msg, opts);
    },
    steer: (message) => {
      if (projectAiDisabled()) {
        core.audit?.write({ kind: 'PROMPT_PROJECT_DISABLED', data: { workdir, steer: true } });
        throw new Error('AI turns are disabled for this project (.pai/settings.json disable_ai)');
      }
      admitSpend(); return box.s.steer(message);
    },
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
      // M71: an ephemeral session's transcript must not leave the process —
      // export (any format) would write it to disk, defeating the contract.
      // Throwing keeps the wire semantics honest: session_export surfaces as
      // success:false, not a refused data payload.
      if (sessionFlags?.isEphemeral?.(box.s) === true) {
        throw new Error('ephemeral session is not exportable — transcript never leaves the process');
      }
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
        writeJsonAtomic(out, bundle);
        return { file: out, format: 'debug', tasks: bundle.tasks.length };
      }
      // dedup-h #74: markdown/quarto transcript export — quarto is a
      // markdown superset with YAML frontmatter, so one generator emits
      // both (.qmd carries `format: html` frontmatter for `quarto render`).
      if (opts.format === 'markdown' || opts.format === 'md' || opts.format === 'quarto') {
        const src = box.s.sessionFile;
        if (!src || !existsSync(src)) return { file: null, format: opts.format, error: 'no session file' };
        const quarto = opts.format === 'quarto';
        const dir = join(dirname(src), 'exports');
        mkdirSync(dir, { recursive: true });
        const out = join(dir, `transcript-${Date.now()}.${quarto ? 'qmd' : 'md'}`);
        writeTextAtomic(out, sessionToMarkdown(src, { quarto, sessionId: box.s.sessionId ?? null }));
        return { file: out, format: quarto ? 'quarto' : 'markdown' };
      }
      const html = await box.s.exportToHtml?.();
      return { file: html ?? null, format: 'html' };
    },
    // M108 sanitized share: export the session for handing to someone else —
    // every line passes the secret scrubber, the workdir path is masked to
    // [WORKDIR] (a share must not leak the operator's local layout), and a
    // header line carries provenance + the redaction count. The output is a
    // file the operator posts themselves — nothing here auto-uploads.
    share: async () => {
      const src = box.s.sessionFile;
      if (!src || !existsSync(src)) return { file: null, error: 'no session file' };
      const dir = join(dirname(src), 'exports');
      mkdirSync(dir, { recursive: true });
      const out = join(dir, `share-${Date.now()}.jsonl`);
      const wdir = String(workdir ?? '').replace(/\\/g, '/');
      let redactions = 0;
      const lines = readFileSync(src, 'utf-8').split('\n').filter(Boolean).map((line) => {
        let l = redactSecrets(line);
        if (wdir) l = l.split(wdir).join('[WORKDIR]').split(wdir.replace(/\//g, '\\')).join('[WORKDIR]');
        if (l !== line) redactions++;
        return l;
      });
      const header = JSON.stringify({ type: 'share_header', sharedAt: new Date().toISOString(), sessionId: box.s.sessionId ?? null, redactedLines: redactions, sanitizer: 'secrets+workdir-path' });
      writeFileSync(out, [header, ...lines].join('\n') + '\n');
      core.audit?.write({ kind: 'SESSION_SHARE', data: { file: out, lines: lines.length, redactedLines: redactions } });
      return { file: out, lines: lines.length, redactedLines: redactions };
    },
    subscribe: (listener) => {
      uiListeners.add(listener);
      return () => uiListeners.delete(listener);
    },
    // M101 detach: the operator-facing end of attach/detach — the session
    // itself keeps running (jobs/hooks/schedules are process-level, not UI-
    // bound); detach is the explicit marker + audit so "I walked away" is a
    // recorded state, not an inferred disconnect.
    detach: () => {
      const sid = box.s.sessionId ?? null;
      const streaming = Boolean(box.s.isStreaming);
      core.audit?.write({ kind: 'SESSION_DETACHED', data: { sessionId: sid, streaming } });
      return { detached: true, sessionId: sid, streaming };
    },
    // Plain-data replay of the current session — what a UI needs to redraw
    // the transcript after a session_switch without knowing Pi message shapes.
    history: async () => (box.s.messages ?? []).map((m) => {
      const blocks = Array.isArray(m.content) ? m.content : [];
      const textOf = (type) => blocks.filter((b) => b?.type === type)
        .map((b) => b.text ?? b.thinking ?? '').join('');
      // M115: media/resource blocks used to be dropped silently from replay.
      // Preserve bounded descriptors (type + mime + name) so a UI can render
      // "there was an image" without the body shipping raw URIs across the
      // egress boundary — consumers decide whether to fetch anything.
      const media = blocks.filter((b) => b && !['text', 'thinking', 'toolCall', 'tool_use'].includes(b.type))
        .map((b) => ({
          type: b.type,
          mimeType: b.mimeType ?? b.resource?.mimeType ?? null,
          name: b.name ?? b.resource?.name ?? null,
        }));
      return {
        role: m.role ?? 'unknown',
        text: textOf('text') || (typeof m.content === 'string' ? m.content : ''),
        thinking: textOf('thinking') || null,
        toolName: m.toolName ?? m.name ?? null,
        media: media.length ? media : null,
        tools: blocks.filter((b) => b?.type === 'toolCall' || b?.type === 'tool_use')
          .map((b) => b.name ?? b.toolName ?? 'tool'),
        model: m.role === 'assistant' && m.model
          ? { provider: m.model.provider, id: m.model.id }
          : (m.provider ? { provider: m.provider, id: m.responseModel ?? null } : null),
        usage: m.usage ?? null,
        error: m.errorMessage ?? null,
      };
    }),
    // M106 /context map: composition breakdown of the live context — what
    // occupies the window, not just how much. Segments are grouped by
    // role/kind with char counts (est tokens ≈ chars/4 — the engine reports
    // authoritative totals via getContextUsage; per-message token counts
    // exist on assistant usage rows only, so segment sizes are estimates
    // and labeled as such). Ring = the tail-window that survives a compact.
    contextMap: () => {
      const msgs = box.s.messages ?? [];
      const segs = new Map(); // key → {count, chars, estTokens}
      const bump = (key, chars) => {
        const s = segs.get(key) ?? { count: 0, chars: 0 };
        s.count += 1; s.chars += chars; segs.set(key, s);
      };
      for (const m of msgs) {
        const role = m.role ?? 'unknown';
        const blocks = Array.isArray(m.content) ? m.content : [];
        if (typeof m.content === 'string') bump(`${role}/text`, m.content.length);
        for (const b of blocks) {
          const t = b?.type ?? 'unknown';
          const len = (b?.text ?? b?.thinking ?? JSON.stringify(b ?? '')).length;
          bump(`${role}/${t}`, len);
        }
      }
      const usage = (() => { try { return box.s.getContextUsage?.() ?? null; } catch { return null; } })();
      const totalChars = [...segs.values()].reduce((a, s) => a + s.chars, 0);
      const segments = [...segs.entries()]
        .map(([segment, s]) => ({ segment, count: s.count, chars: s.chars, estTokens: Math.round(s.chars / 4) }))
        .sort((a, b) => b.chars - a.chars);
      return {
        sessionId: box.s.sessionId ?? box.s.sessionManager?.getSessionId?.() ?? null,
        usage,                                   // authoritative {tokens, contextWindow} when the engine reports it
        messages: msgs.length,
        totalChars,
        estTokens: Math.round(totalChars / 4),   // estimate label — see above
        segments,
        compacted: autoCompacted,
      };
    },
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
    writeJsonAtomic(aliasPath, doc);
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
    // Remote catalog probe: same request as ping, but KEEP the body — the
    // /models response is the provider's real model list, and throwing it
    // away forced users to hand-type model IDs. Returns parsed ids only;
    // registration stays an explicit operator act (provider_models_add).
    fetchModels: async (providerId) => {
      const rt = box.s.modelRuntime;
      const pid = String(providerId ?? '').trim()
        || (box.s.model?.provider ?? rt.getProviders()[0]?.id);
      const p = rt.getProvider(pid);
      if (!p) return { ok: false, error: `unknown provider '${pid}'` };
      const auth = await rt.getAuth(pid).catch(() => undefined);
      const base = auth?.auth?.baseUrl ?? p.baseUrl;
      if (!base) return { ok: false, error: 'provider has no baseUrl' };
      try {
        const headers = { ...(p.headers ?? {}), ...(auth?.auth?.headers ?? {}) };
        if (auth?.auth?.apiKey) headers.Authorization = `Bearer ${auth.auth.apiKey}`;
        const res = await fetch(`${String(base).replace(/\/+$/, '')}/models`, {
          headers, signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return { ok: false, httpStatus: res.status, error: `HTTP ${res.status}` };
        const body = await res.json().catch(() => null);
        // OpenAI shape: {data:[{id}]}; Ollama native: {models:[{name}]}
        const rows = body?.data ?? body?.models ?? [];
        const ids = rows.map((m) => m?.id ?? m?.name).filter((x) => typeof x === 'string' && x);
        return { ok: true, provider: pid, models: [...new Set(ids)] };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    },
    // Merge fetched model ids into models.json. Built-in providers keep their
    // catalog (models.json merge semantics upsert by id); custom providers
    // must already exist (provider_add owns creation). Model entries get the
    // same conservative defaults as provider_add.
    addModels: async ({ provider, modelIds, cost = null }) => {
      const file = join(core.paths.root, 'pi-agent', 'models.json');
      let cfg = { providers: {} };
      if (existsSync(file)) {
        try { cfg = JSON.parse(readFileSync(file, 'utf-8')); } catch { /* rewrite below */ }
      }
      cfg.providers = cfg.providers ?? {};
      const prov = cfg.providers[provider];
      // No models.json entry yet: allowed only for runtime-known (built-in)
      // providers — models.json merges by id and keeps the built-in catalog.
      // Seed baseUrl/api from the runtime provider so the partial entry can't
      // shadow the built-in connection config. Unknown ids must go through
      // provider_add (they need a real baseUrl/api from the operator).
      const rtProv = box.s.modelRuntime.getProvider(provider);
      if (!prov && !rtProv) {
        return { ok: false, error: `provider '${provider}' not in models.json and not built-in — use provider_add first` };
      }
      const entry = prov ?? {
        ...(rtProv?.baseUrl ? { baseUrl: rtProv.baseUrl } : {}),
        ...(rtProv?.api ? { api: typeof rtProv.api === 'string' ? rtProv.api : undefined } : {}),
      };
      entry.models = entry.models ?? [];
      const existing = new Set(entry.models.map((m) => m.id));
      const added = [];
      for (const id of modelIds) {
        if (existing.has(id)) continue;
        entry.models.push({
          id, name: id, reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...(cost ?? {}) },
          contextWindow: 128000, maxTokens: 8192,
        });
        added.push(id);
      }
      if (!prov) cfg.providers[provider] = entry;
      writeJsonAtomic(file, cfg);
      await box.s.modelRuntime.refresh?.().catch(() => {});
      return { ok: true, provider, added, total: entry.models.length };
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
      if (alias === 'adaptive') {
        if (!modelRoutes?.adaptive) throw new Error("adaptive routing is not enabled — set '\"adaptive\": true' in <instance>/model-routes.json");
        modelPinned = false;
        core.audit?.write({ kind: 'MODEL_ADAPTIVE_UNPINNED', data: {} });
        return { adaptive: true };
      }
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
      // #2118: an explicit pick opts the session out of adaptive routing —
      // crush parity ("you can still pick a specific model with /model").
      if (modelRoutes?.adaptive && !modelPinned) {
        modelPinned = true;
        core.audit?.write({ kind: 'MODEL_ADAPTIVE_PINNED', data: { model: `${m.provider}/${m.id}` } });
      }
      return { provider: m.provider, id: m.id, name: m.name ?? m.id, alias: alias ?? null };
    },
    // M100 fallback chain ops — mutates the shared config object the loop
    // extension reads, and persists to <instance>/model-fallbacks.json.
    fallbacks: async () => ({ chain: [...(fallbacks?.chain ?? [])] }),
    setFallbacks: async (chain) => {
      if (!fallbacks) throw new Error('fallback config unavailable');
      if (!Array.isArray(chain)) throw new Error('setFallbacks requires an array of {provider, model}');
      const clean = chain
        .filter((e) => e && typeof e.provider === 'string' && typeof e.model === 'string')
        .slice(0, 8);
      writeJsonAtomic(join(core.paths.root, 'model-fallbacks.json'), { chain: clean });
      fallbacks.chain = clean;
      core.audit?.write({ kind: 'MODEL_FALLBACK_CONFIG', data: { chain: clean.map((e) => `${e.provider}/${e.model}`) } });
      return { chain: clean };
    },
    // M95 local-inference discovery (Ollama/LM Studio/llama.cpp analogue):
    // probe the well-known local endpoints, report reachable nodes + their
    // model catalogs. Discovery only — nothing is configured implicitly.
    discover: async () => {
      const probes = [
        { kind: 'ollama', url: 'http://localhost:11434', listPath: '/api/tags', pick: (b) => (b?.models ?? []).map((m) => m.name) },
        { kind: 'lmstudio', url: 'http://localhost:1234', listPath: '/v1/models', pick: (b) => (b?.data ?? []).map((m) => m.id) },
        { kind: 'llamacpp', url: 'http://localhost:8080', listPath: '/v1/models', pick: (b) => (b?.data ?? []).map((m) => m.id) },
      ];
      const nodes = [];
      for (const p of probes) {
        try {
          const res = await fetch(`${p.url}${p.listPath}`, { signal: AbortSignal.timeout(2500) });
          if (!res.ok) continue;
          const body = await res.json().catch(() => null);
          nodes.push({ kind: p.kind, url: p.url, models: p.pick(body) ?? [] });
        } catch { /* node absent — discovery is best-effort */ }
      }
      return { nodes, hint: nodes.length ? 'add via provider panel: api=openai-completions, baseUrl=<node>/v1' : null };
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
      // Capability gate: a non-reasoning model accepts only 'off' — otherwise
      // the UI writes a setting the provider silently ignores.
      if (lvl !== 'off' && s.model && !s.model.reasoning) {
        throw new Error(`model '${s.model.provider}/${s.model.id}' has no reasoning capability — thinking stays off`);
      }
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
      if (/^(?:op|bw):\/\//.test(key) && !parseSecretRef(key)) {
        return { provider, hasAuth: false, error: `malformed secret reference — expected op://<vault>/<item>/<field> or bw://<item>[/<field>]` };
      }
      if (parseSecretRef(key)) {
        // dedup-h #1402→#1406 — route through the single secretsource broker:
        // secrets.json opt-in gate + items allowlist + minimized env +
        // timeout/output caps. The previous inline execFileSync resolved
        // op://bw:// unconditionally — the fail-closed contract says a scheme
        // resolves ONLY when the operator enabled it.
        const r = resolveSecretRef(key, { instanceRoot: core.paths.root, spawnFn: secretSpawnFn });
        core.audit?.write({
          kind: 'SECRET_SOURCE_RESOLVE',
          data: { tool: 'auth_set_key', provider, scheme: r.scheme ?? parseSecretRef(key)?.scheme, item: r.item ?? null, ok: r.ok === true },
        });
        if (!r.ok) return { provider, hasAuth: false, error: `secret-source resolve refused: ${r.reason}` };
        resolved = r.value;
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
      // dedup-h #1402 — private-egress registration gate (the runtime check in
      // budgetfetch is the real enforcement; this is the early honest hint):
      // a baseUrl targeting loopback/RFC1918/link-local space needs an
      // explicit allowPrivateNetwork opt-in — persisted on the provider entry
      // where the egress gate reads it.
      let baseHost = null;
      try { baseHost = new URL(String(spec.baseUrl ?? '')).hostname; } catch { /* malformed → let the write surface it */ }
      if (baseHost) {
        let hit = null;
        if (isIP(baseHost)) hit = isPrivateResolved(baseHost) ? baseHost : null;
        else {
          const addrs = await dnsLookup(baseHost, { all: true }).then((r) => r.map((a) => a.address)).catch(() => []);
          hit = addrs.find((a) => isPrivateResolved(a)) ?? null;
        }
        if (hit && spec.allowPrivateNetwork !== true) {
          return { ok: false, error: `provider baseUrl '${spec.baseUrl}' targets private/loopback address ${hit} — set allowPrivateNetwork to register a self-hosted endpoint` };
        }
      }
      const file = join(core.paths.root, 'pi-agent', 'models.json');
      let cfg = { providers: {} };
      if (existsSync(file)) {
        try { cfg = JSON.parse(readFileSync(file, 'utf-8')); } catch { /* rewrite below */ }
      }
      cfg.providers = cfg.providers ?? {};
      cfg.providers[spec.provider] = {
        baseUrl: spec.baseUrl,
        api: spec.api,
        ...(spec.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}),
        // env-ref only ($NAME) — literal keys belong in the credential store
        // via auth_set_key, never in a committed-able JSON file.
        ...(spec.apiKeyEnv ? { apiKey: `$${spec.apiKeyEnv}` } : {}),
        models: [{
          id: spec.model,
          name: spec.modelName ?? spec.model,
          reasoning: false,
          input: ['text'],
          // zero pricing = dollar budget caps cannot see this traffic; the
          // operator may declare per-1M-token rates at registration time
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...(spec.cost ?? {}) },
          contextWindow: spec.contextWindow ?? 128000,
          maxTokens: spec.maxTokens ?? 8192,
        }],
      };
      writeJsonAtomic(file, cfg);
      await box.s.modelRuntime.refresh?.().catch(() => {});
      return { provider: spec.provider, model: spec.model };
    },
  };

  const auditFacade = {
    // Paged tail over the WHOLE audit history (all daily files, oldest first),
    // not just today. before = lines-from-end cursor (0 = freshest page).
    // Returns {events, total, hasMore} so the UI can page back — the audit
    // log is the governance record; an 80-line window is not oversight.
    tail: (n, before = 0) => {
      let lines = [];
      try {
        const files = readdirSync(core.paths.auditDir).filter((f) => f.endsWith('.jsonl')).sort();
        for (const f of files) {
          lines.push(...readFileSync(join(core.paths.auditDir, f), 'utf-8').split('\n'));
        }
      } catch { return { events: [], total: 0, hasMore: false }; }
      lines = lines.filter(Boolean);
      const end = Math.max(0, lines.length - Math.max(0, Number(before) || 0));
      const start = Math.max(0, end - n);
      return {
        events: lines.slice(start, end).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean),
        total: lines.length,
        hasMore: start > 0,
      };
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
      status: async () => {
        const st = budget.status(box.s.sessionId ?? box.s.sessionManager?.getSessionId?.() ?? 'unknown');
        // Metering honesty: a dollar cap against a zero-priced model is a
        // dead limit — custom providers register with cost 0 unless the
        // operator declares rates. Say so instead of letting the cap look armed.
        const mc = box.s.model?.cost;
        const costMetered = Boolean(mc && (mc.input || mc.output || mc.cacheRead || mc.cacheWrite));
        const warning = st.limits?.maxCostPerSessionUsd && !costMetered
          ? '配置了美元上限，但当前模型没有定价数据（自定义提供商注册时 cost 默认为 0）——成本上限对这部分流量不可见；token/次数上限仍然有效。可在 provider_add/provider_models_add 用 cost 声明每百万 token 价格'
          : null;
        return { ...st, costMetered, ...(warning ? { warning } : {}) };
      },
      // cross-scope spend rollup over a window ({since?, until?} epoch ms) —
      // the operator's "what did the instance burn today" answer
      rollup: (opts = {}) => budget.rollup(opts),
      // Operator-tier budget dial: hot-mutates the live governor AND persists
      // an override file the bootstrap reads with top precedence (overrides >
      // policy doc > env). The canonical policy.json checksum is untouched —
      // no attestation drift, no body restart needed. Audited both ways.
      setLimits: (limits) => {
        const KEYS = ['maxTokensPerSession', 'maxCostPerSessionUsd', 'maxCallsPerSession'];
        const next = {};
        for (const [k, v] of Object.entries(limits ?? {})) {
          if (!KEYS.includes(k)) return { error: `budget_set: unknown limit '${k}' (known: ${KEYS.join(', ')})` };
          if (v === null || v === 0) continue; // null/0 clears that limit
          if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
            return { error: `budget_set: ${k} must be a non-negative number (0/null clears)` };
          }
          next[k] = v;
        }
        const before = budget.limits ?? null;
        budget.limits = Object.keys(next).length ? next : null;
        const file = join(core.paths.root, 'budget-overrides.json');
        try {
          if (budget.limits) writeJsonAtomic(file, { limits: budget.limits, setAt: new Date().toISOString() });
          else if (existsSync(file)) unlinkSync(file); // cleared back to policy/env tier
        } catch (e) {
          budget.limits = before; // persistence failed → roll the hot change back
          return { error: `budget_set: cannot persist override (${e?.message ?? e}) — limit unchanged` };
        }
        core.audit?.write({ kind: 'BUDGET_LIMITS_SET', data: { before, after: budget.limits } });
        return { limits: budget.limits, persisted: Boolean(budget.limits) };
      },
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
    governance: core.kernel?.decideToolCall ? {
      // Dry-run probe: run the REAL decideToolCall chain with probe:true so
      // the verdict (allow / deny / would-ask) is exactly what a live call
      // would get — minus audit writes, ask suspension, prediction binding.
      dryRun: async (toolName, args = {}) => {
        const d = await core.kernel.decideToolCall({
          toolName,
          toolCallId: 'probe',
          args: typeof args === 'object' && args !== null ? args : {},
          probe: true,
        });
        if (!d) return { action: 'allow' };
        if (d.wouldAsk) {
          return { action: 'ask', rule: d.rule, reason: d.reason, risk: d.risk, summary: d.summary };
        }
        return { action: 'deny', rule: d.rule, reason: d.reason, terminate: d.terminate === true, repair: d.repair ?? null };
      },
    } : null,
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
    webhooks,
    scan,
    imageDetail,
    leases,
    repoMap,
    proxy,
    mcp,
    assist,
    // M64 instance inventory — a cross-category purge PREVIEW surface: every
    // persisted artifact class under the instance root with file/byte counts.
    // Deletion goes through instance.purge: an explicit per-category action
    // that defaults to dry-run, refuses enforcement-evidence classes, and
    // never touches the live session file.
    instance: (() => {
      const cats = {
        sessions: /sessions[\\/]/, jobs: /jobs[\\/]/, audit: /audit[\\/]/,
        memory: /memory\.db$/, checkpoints: /checkpoints[\\/]/,
        exports: /exports[\\/]/, spool: /spool[\\/]/, schedules: /schedules?\.json$/,
        allowlists: /(command-allow|always-allow|egress-allow|feature-models)\.json$/,
        tasks: /tasks[\\/]/, macros: /macros\.json$/, receipts: /receipts[\\/]|fileops[\\/]/,
      };
      const catFiles = (category) => {
        const root = core.paths.root;
        const out = [];
        const walk = (dir, depth) => {
          if (depth > 5) return;
          let ents;
          try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of ents) {
            const p = join(dir, e.name);
            if (e.isDirectory()) { walk(p, depth + 1); continue; }
            const rel = p.slice(root.length);
            const cat = Object.keys(cats).find((k) => cats[k].test(rel)) ?? 'other';
            if (category == null || cat === category) {
              let bytes = 0;
              try { bytes = statSync(p).size; } catch { continue; }
              out.push({ path: p, rel, cat, bytes });
            }
          }
        };
        walk(root, 0);
        return out;
      };
      return {
        inventory: () => {
          const out = {};
          for (const f of catFiles(null)) {
            out[f.cat] ??= { files: 0, bytes: 0 };
            out[f.cat].files += 1; out[f.cat].bytes += f.bytes;
          }
          return { root: core.paths.root, categories: out };
        },
        purge: ({ category, dry_run = true } = {}) => {
          const PURGEABLE = new Set(['exports', 'spool', 'sessions', 'tasks']);
          if (!PURGEABLE.has(String(category))) {
            return {
              ok: false,
              error: `category '${category}' is not purgeable — exports/spool/sessions/tasks only; ` +
                'audit/jobs/memory/receipts/schedules/allowlists are enforcement evidence',
            };
          }
          const live = box.s.sessionFile ? String(box.s.sessionFile) : null;
          let files = catFiles(category).filter((f) => f.path !== live);
          // tasks: only CLOSED task dirs are history — an open mailbox is a
          // live channel the child may still be reading. Whole-dir semantics:
          // if any stream of an open task matched, drop ALL files of that dir.
          if (category === 'tasks') {
            const openDirs = new Set();
            for (const f of files) {
              const m = f.rel.match(/tasks[\\/]([^\\/]+)[\\/]task\.json$/);
              if (!m) continue;
              try {
                const meta = JSON.parse(readFileSync(f.path, 'utf-8'));
                if (meta?.state === 'open') openDirs.add(m[1]);
              } catch { /* torn meta — treat as closed? no: keep it, a torn task is safer kept */ openDirs.add(m[1]); }
            }
            if (openDirs.size) files = files.filter((f) => {
              const m = f.rel.match(/tasks[\\/]([^\\/]+)[\\/]/);
              return !m || !openDirs.has(m[1]);
            });
          }
          const bytes = files.reduce((a, f) => a + f.bytes, 0);
          if (dry_run !== false) {
            return { ok: true, dry_run: true, category, files: files.length, bytes, paths: files.map((f) => f.rel) };
          }
          const removed = [];
          for (const f of files) {
            try { unlinkSync(f.path); removed.push(f.rel); } catch { /* locked/gone — skip, keep counting */ }
          }
          core.audit?.write({
            kind: 'INSTANCE_PURGE',
            data: { category, requested: files.length, removed: removed.length, bytes },
          });
          return { ok: true, dry_run: false, category, removed: removed.length, bytes, skipped: files.length - removed.length };
        },
      };
    })(),
    skills: knowledge, // skill-doctor stats + allow-list ride the knowledge facade
    // M81 named profiles — a snapshot pack of {model, thinking, mode} the
    // operator can save/apply/delete inside this instance. Cross-instance
    // isolation is already the body layer's job; this is the in-instance
    // preset switch the per-instance bodies don't cover.
    profiles: (() => {
      const file = () => join(core.paths.root, 'profiles.json');
      const read = () => {
        try { return JSON.parse(readFileSync(file(), 'utf-8')).profiles ?? {}; } catch { return {}; }
      };
      const write = (doc) => writeJsonAtomic(file(), { profiles: doc });
      return {
        list: () => Object.entries(read()).map(([name, p]) => ({ name, ...p })),
        save: ({ name } = {}) => {
          const n = String(name ?? '').trim();
          if (!n || n.length > 40) throw new Error('profile name required (≤40 chars)');
          const s = box.s;
          const doc = read();
          doc[n] = {
            model: s?.model ? { provider: s.model.provider, id: s.model.id } : null,
            thinking: s?.thinkingLevel ?? null,
            mode: modes?.get?.() ?? null,
            savedAt: new Date().toISOString(),
          };
          write(doc);
          core.audit?.write({ kind: 'PROFILE_SAVED', data: { name: n, model: doc[n].model?.id ?? null } });
          return { name: n, ...doc[n] };
        },
        apply: async ({ name } = {}) => {
          const p = read()[String(name ?? '')];
          if (!p) return { ok: false, error: `no profile '${name}'` };
          const applied = {};
          if (p.model) {
            await modelsFacade.set({ provider: p.model.provider, model: p.model.id });
            applied.model = p.model.id;
          }
          if (p.thinking) { await modelsFacade.setThinking(p.thinking).catch(() => {}); applied.thinking = p.thinking; }
          if (p.mode && modes?.setMode) {
            const r = modes.setMode(p.mode);
            if (r?.ok === false) return { ok: false, error: `mode '${p.mode}' refused: ${r.error ?? 'unknown'}` };
            applied.mode = p.mode;
          }
          core.audit?.write({ kind: 'PROFILE_APPLIED', data: { name: String(name), applied } });
          return { ok: true, name: String(name), applied };
        },
        remove: ({ name } = {}) => {
          const doc = read();
          const had = delete doc[String(name ?? '')];
          if (had) write(doc);
          return { removed: had };
        },
        // Portability: profiles are instance-local presets — export/import
        // carries them between instances (same confinement as allowlists).
        export: ({ path } = {}) => {
          const target = resolve(core.paths.root, String(path ?? 'profiles-export.json'));
          if (!pathInsideRootForWrite(core.paths.root, target) || !target.endsWith('.json')) {
            return { ok: false, error: 'export target must be a .json path inside the instance directory' };
          }
          writeFileSync(target, JSON.stringify({ profiles: read() }, null, 2) + '\n');
          core.audit?.write({ kind: 'PROFILE_EXPORT', data: { file: target, count: Object.keys(read()).length } });
          return { ok: true, path: target };
        },
        import: ({ path } = {}) => {
          const source = resolve(core.paths.root, String(path ?? ''));
          if (!pathInsideRootReal(core.paths.root, source) || !source.endsWith('.json')) {
            return { ok: false, error: 'import source must be a .json path inside the instance directory' };
          }
          let doc;
          try { doc = JSON.parse(readFileSync(source, 'utf-8')); }
          catch (e) { return { ok: false, error: `invalid import file: ${e.message}` }; }
          const entries = Object.entries(doc?.profiles ?? {});
          if (!entries.length || entries.some(([n, p]) => !n || n.length > 40 || typeof p !== 'object' || p === null)) {
            return { ok: false, error: 'import file must contain a non-empty profiles object (names ≤40 chars)' };
          }
          const merged = { ...read(), ...doc.profiles };
          write(merged);
          core.audit?.write({ kind: 'PROFILE_IMPORT', data: { file: source, count: entries.length } });
          return { ok: true, imported: entries.length };
        },
      };
    })(),
  });
  const dispose = () => { pump?.(); uiListeners.clear(); channel.dispose(); };
  return { channel, rebind, dispose };
}
