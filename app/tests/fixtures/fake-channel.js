#!/usr/bin/env node
/**
 * Fixture body channel — a real JSONL subprocess speaking the host protocol
 * subset the supervisor drives. It holds a REAL domain lease on the instance
 * (like the pi body's canonical-writer claim) so body switches exercise the
 * actual lease baton, and handoff_export computes real hashes from the real
 * canonical stores — nothing canned.
 *
 * env: FAKE_BODY (body id), FAKE_MSGS (get_state messageCount),
 *      FAKE_LEASE (domain lease name, default 'session-writer'),
 *      FAKE_INSTANCE (instance root, from --instance arg)
 *      FAKE_RECORD_HISTORY=1 — append user prompts to <instance>/fake-history.jsonl
 *        and serve them back from session_history (the receipt-loss reconcile
 *        path needs a body that REMEMBERS, like the real session JSONL)
 *      FAKE_SILENT_PROMPT=1 — execute prompts (history is recorded) but never
 *        write the response: a lost receipt
 *      FAKE_PROMPT_DELAY_MS — answer prompts after a delay (in-flight window)
 */
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DomainLeaseStore } from '../../../host/src/core/lease.js';
import { PredictionStore } from '../../../host/src/core/prediction.js';
import { loadPolicy } from '../../../host/src/core/policy.js';

const args = process.argv.slice(2);
const instance = args[args.indexOf('--instance') + 1];
const body = process.env.FAKE_BODY ?? 'fake';
const runId = `fake-run-${body}-${randomUUID().slice(0, 6)}`;
const leaseName = process.env.FAKE_LEASE ?? 'session-writer';
// Fileops receipt stream — grows one entry per scripted mutation so the
// dom gate can watch the changes view update LIVE (dedup-h #1955).
const fileops = [];
const owner = `${body}:${runId}`;

/* D07.5 falsifier hooks (v4 §7). Each is opt-in and narrow: a negative
 * regression can only be written against a body that is ABLE to misbehave —
 * a fixture that can never answer late, never refuses a stop and never sees a
 * sourceless attachment proves nothing about the guards that face those cases.
 *
 *   FAKE_MULTI_SESSION=1        session_list also offers s2.jsonl
 *   FAKE_HISTORY_MARK=1         session_history answers [{role:user,text:hist:<file>}]
 *                               — identifiable BY SESSION, so a late answer is
 *                               distinguishable from the fresh one
 *   FAKE_HISTORY_SLOW_FOR=<f>   only that session's history is delayed
 *   FAKE_HISTORY_DELAY_MS       how long (default 0)
 *   FAKE_ABORT_FAIL=1           abort is REFUSED (body keeps the run)
 *   FAKE_PROMPT_LOG=<path>      append every prompt envelope as JSONL
 *   FAKE_REQUIRE_ATTACH_DATA=1  refuse a prompt whose attachment has no data
 */
const multiSession = process.env.FAKE_MULTI_SESSION === '1';
const historyMark = process.env.FAKE_HISTORY_MARK === '1';
const historySlowFor = process.env.FAKE_HISTORY_SLOW_FOR ?? '';
const historyDelayMs = Number(process.env.FAKE_HISTORY_DELAY_MS ?? 0);
const abortFails = process.env.FAKE_ABORT_FAIL === '1';
const promptLog = process.env.FAKE_PROMPT_LOG ?? '';
const requireAttachData = process.env.FAKE_REQUIRE_ATTACH_DATA === '1';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const write = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

const deletedSessions = new Set();
// Receipt-loss test support: a body that REMEMBERS what it executed. With
// FAKE_RECORD_HISTORY=1 every prompt's user message is appended to
// <instance>/fake-history.jsonl and session_history serves it back — the same
// shape of evidence the real session JSONL gives the reconcile path.
const histFile = process.env.FAKE_RECORD_HISTORY === '1' ? `${instance}/fake-history.jsonl` : null;
const historyRows = () => {
  if (!histFile || !existsSync(histFile)) return [];
  return readFileSync(histFile, 'utf-8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};
// Stateful model store — the first-use journey (settings: provider → key →
// ping → fetch → save → set → chat) needs the fixture to actually REMEMBER,
// like a real body: keys persist, added providers/models show up in
// model_status/model_list, model_set changes current.
const modelStore = {
  authed: new Set(['fake', 'deepseek', 'openai']),
  providers: [
    { id: 'fake', name: 'Fake Provider', baseUrl: 'http://127.0.0.1:9999/v1', api: 'openai-completions' },
    { id: 'amazon-bedrock', name: 'Amazon Bedrock' },
    { id: 'deepseek', name: 'DeepSeek' },
    { id: 'ollama', name: 'Ollama' },
    { id: 'openai', name: 'OpenAI' },
  ],
  models: { fake: [{ provider: 'fake', id: 'fake-1', name: 'fake-1', reasoning: false, contextWindow: 128000, maxContextWindow: 128000 }] },
  current: { provider: 'fake', id: 'fake-1', name: 'fake-1', contextWindow: 128000, maxContextWindow: 128000, reasoning: false, supportsFast: true, supportedThinkingLevels: ['off', 'low', 'medium', 'high'] },
};
// The body reports the session it actually switched to — get_state mirrors
// the last session_switch, like a real body would.
let currentThinkingLevel = 'medium';
let currentRiskMode = 'normal';
const taskStore = [
  {
    task_id: 'task-fake-1',
    state: 'open',
    job_id: 'fake-job-1',
    title: '后台构建与测试',
    updatedAt: new Date().toISOString(),
    inbox: [{ from: 'operator', body: '检查分支健康', ts: new Date().toISOString() }],
    outbox: [{ from: 'task', body: '测试已启动，等待完成', ts: new Date().toISOString() }],
    events: [{ kind: 'SPAWN', data: { note: '任务已拉起' }, ts: new Date().toISOString() }],
  },
];
let currentFile = `${instance}/sessions/s1.jsonl`;
const leases = new DomainLeaseStore({ root: instance });
let held = null;
try {
  const c = leases.claim({ scope: 'domain', name: leaseName, owner, ttlSeconds: 8 });
  if (c.ok) held = c.lease;
} catch { /* lease contention is reported, not fatal */ }

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  const t = line.trim();
  if (!t) return;
  let cmd;
  try { cmd = JSON.parse(t); } catch { write({ type: 'response', success: false, error: 'bad json' }); return; }
  const reply = (data) => write({ id: cmd.id, type: 'response', command: cmd.type, success: true, data });
  const fail = (error) => write({ id: cmd.id, type: 'response', command: cmd.type, success: false, error });
  switch (cmd.type) {
    case 'body_info':
      return reply({ body_id: body, runId, sessionId: `sess-${body}` });
    case 'get_state':
      return reply({
        model: { provider: 'fake', id: 'fake-1' }, streaming: false,
        messageCount: Number(process.env.FAKE_MSGS ?? 0),
        session: { file: currentFile, name: 'DOM验收' },
        contextUsage: { tokens: 51200, contextWindow: 200000 },
      });
    case 'prompt': {
      // Ground-truth record of what the UI actually dispatched — the only
      // artifact that can prove an attachment arrived WITH its bytes
      // (V406) rather than as an empty shell.
      if (promptLog) {
        try {
          appendFileSync(promptLog, `${JSON.stringify({
            message: cmd.message, session_id: cmd.session_id ?? null,
            options: cmd.options ?? null,
          })}\n`);
        } catch { /* best-effort */ }
      }
      if (requireAttachData) {
        const atts = Array.isArray(cmd.options?.attachments) ? cmd.options.attachments : [];
        const sourceless = atts.find((a) => typeof a?.data !== 'string' || a.data.length === 0);
        if (sourceless) {
          return fail(`attachment '${sourceless?.name ?? '?'}' has no data — refusing a prompt it cannot execute`);
        }
      }
      if (histFile) {
        try { appendFileSync(histFile, `${JSON.stringify({ role: 'user', text: String(cmd.message ?? '') })}\n`); } catch { /* best-effort */ }
      }
      // FAKE_SILENT_PROMPT: the turn EXECUTES (history above is the proof)
      // but the receipt never comes back — the exact A05 failure shape.
      if (process.env.FAKE_SILENT_PROMPT === '1') return;
      const respond = () => {
      write({ type: 'event', event: { type: 'agent_start' } });
      write({ type: 'event', event: { type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: '' }] } } });
      const imgN = (cmd.options?.images?.length ?? 0)
        + (cmd.options?.attachments ?? []).filter((a) => a.mime?.startsWith('image/')).length;
      write({ type: 'event', event: { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: `echo:${cmd.message}${imgN ? ` | 收到图片 ${imgN}` : ''}` }] } } });
      if (process.env.FAKE_SCENARIO === 'domgate') {
        // Scripted turn for the DOM gate: a real tool card, then a pending
        // ask carrying a real payload — resolved when decision_resolve lands.
        write({ type: 'event', event: { type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'bash', args: { command: 'echo domgate' } } });
        write({ type: 'event', event: { type: 'tool_execution_end', toolCallId: 'tc1', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: 'domgate-out' }] } } });
        write({ type: 'event', event: { type: 'tool_execution_start', toolCallId: 'tc2', toolName: 'edit', args: { path: 'src/a.js', oldText: 'const x = 1;', newText: 'const x = 2;' } } });
        write({ type: 'event', event: { type: 'tool_execution_end', toolCallId: 'tc2', toolName: 'edit', isError: false, result: { content: [{ type: 'text', text: 'edited' }] } } });
        // #1955 — a `patch` mutation (previously missed by the UI's live set)
        // lands a fresh fileops receipt each turn.
        const target = `src/gen-${fileops.length}.js`;
        write({ type: 'event', event: { type: 'tool_execution_start', toolCallId: 'tcp', toolName: 'patch', args: { path: target } } });
        write({ type: 'event', event: { type: 'tool_execution_end', toolCallId: 'tcp', toolName: 'patch', isError: false, result: { content: [{ type: 'text', text: 'patched' }] } } });
        fileops.push({ receiptId: `rcpt-${fileops.length + 1}`, op: 'write', target, at: new Date().toISOString(), undoable: true });
        // #1507 — MCP Apps result shape: details.ui declares a ui:// surface,
        // details.mcpServer names the owning connection.
        write({ type: 'event', event: { type: 'tool_execution_start', toolCallId: 'tcapp', toolName: 'mcp__apps__chart', args: {} } });
        write({ type: 'event', event: { type: 'tool_execution_end', toolCallId: 'tcapp', toolName: 'mcp__apps__chart', isError: false, result: { content: [{ type: 'text', text: 'chart data' }], details: { mcpServer: 'apps', mcpTool: 'chart', ui: { key: 'ui/resourceUri', uri: 'ui://apps/chart.html' } } } } });
        write({
          type: 'event', event: {
            type: 'governance_ask', ask: {
              id: 'ask-dom-1', toolName: 'bash', riskCategory: 'shell',
              summary: 'bash: rm -rf scratch/', expiresAt: Date.now() + 60000,
              args: { command: 'rm -rf scratch/' },
            },
          },
        });
        return reply({ accepted: true, awaiting: 'decision' });
      }
      write({ type: 'event', event: { type: 'agent_end', messages: [] } });
      return reply({ echoed: cmd.message });
      };
      const delayMs = Number(process.env.FAKE_PROMPT_DELAY_MS ?? 0);
      if (delayMs > 0) { setTimeout(respond, delayMs); return; }
      return respond();
    }
    case 'decision_resolve':
      // Emit the normalized verdict like the real host (asks.js emits `ans`,
      // the extracted verdict string) — echoing the raw {answer,edited}
      // envelope would be a fixture-fidelity bug.
      write({ type: 'event', event: { type: 'governance_resolved', askId: cmd.askId, answer: cmd.answer && typeof cmd.answer === 'object' ? cmd.answer.answer : cmd.answer } });
      write({ type: 'event', event: { type: 'tool_execution_start', toolCallId: 'tc3', toolName: 'bash', args: { command: 'rm -rf scratch/' } } });
      write({ type: 'event', event: { type: 'tool_execution_end', toolCallId: 'tc3', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: 'removed' }] } } });
      write({ type: 'event', event: { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } });
      write({ type: 'event', event: { type: 'message_end', message: { role: 'assistant', usage: { cost: { total: 0.0042 } } } } });
      write({ type: 'event', event: { type: 'agent_end', messages: [] } });
      return reply({ resolved: cmd.askId });
    case 'command_rewrite':
      // #1392 wand stub — deterministic "model": append the instruction as a
      // shell comment so the dom gate can verify the rewrite round-trip.
      if (!cmd.command || !cmd.instruction) return fail('command_rewrite requires {command, instruction}');
      return reply({ command: `${cmd.command} # ${cmd.instruction}` });
    case 'mcp_resource_read':
      // #1507 — ui:// resource fetch through the owning connection; only
      // the declared URI resolves, everything else is an honest error.
      if (cmd.server === 'apps' && cmd.uri === 'ui://apps/chart.html') {
        return reply({ ok: true, contents: [{ uri: cmd.uri, mimeType: 'text/html', text: '<html><body><h1>chart-app</h1></body></html>' }] });
      }
      return reply({ ok: false, error: `mcp server '${cmd.server}' is not connected` });
    case 'steer':
      return reply({});
    case 'abort':
      // A refusal is a real outcome: the body still owns the run, and the UI
      // must not pretend it stopped (V404).
      if (abortFails) return fail('abort refused: body still owns the run');
      return reply({});
    case 'fileops_list':
      return reply(fileops);
    case 'session_stats':
      return reply({
        sessionId: 'sess-fake', totalMessages: 4, userMessages: 2, assistantMessages: 2,
        tokens: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, total: 1500 },
        cost: 0.0042,
      });
    case 'todos_list':
      return reply([
        { id: 't1', content: '盘点实现缺口', status: 'completed' },
        { id: 't2', content: '写 DOM 门测试', status: 'in_progress', activeForm: '正在写 DOM 门测试' },
      ]);
    case 'pending_list': return reply([]);
    case 'session_list': {
      const rows = [
        // cwd '/repo' matches the worktree_list entry with branch 'main' —
        // the #2173 sidebar branch tag renders off this pair.
        { path: `${instance}/sessions/s1.jsonl`, id: 'sess-1', name: 'DOM验收', firstMessage: 'hello', modified: '2026-01-01T00:00:00Z', messageCount: 3, cwd: '/repo' },
      ];
      // #143 dom-gate needs a second, distinct session to prove resume
      // actually switches — other fixtures see the original single row.
      if (process.env.FAKE_SCENARIO === 'domgate') {
        rows.push({ path: `${instance}/sessions/s2.jsonl`, id: 'sess-2', name: 'resume-target', firstMessage: 'second', modified: '2026-01-01T00:01:00Z', messageCount: 1 });
      } else if (multiSession) {
        // Same cwd as s1 so both rows land in the SAME project group: a
        // regression that needs two clickable sessions must not also depend
        // on a group's expansion state.
        rows.push({ path: `${instance}/sessions/s2.jsonl`, id: 'sess-2', name: 'resume-target', firstMessage: 'second', modified: '2026-01-01T00:01:00Z', messageCount: 1, cwd: '/repo' });
      }
      return reply(rows.filter((s) => !deletedSessions.has(s.path)));
    }
    case 'session_switch':
      currentFile = cmd.path;
      return reply({ id: 'sess-2', file: cmd.path, name: 'resume-target' });
    case 'session_new':
      currentFile = `${instance}/sessions/new.jsonl`;
      return reply({ id: 'sess-new', file: currentFile });
    case 'session_insights':
      return reply(cmd.all
        ? { sessions: 2, messages: 4, tokens: 120, cost: 0.01, errorBlocks: 0, avgDurationMs: 60000, topTools: [{ name: 'bash', count: 3 }], tips: ['覆盖良好'] }
        : { file: cmd.path ?? 's1.jsonl', messages: 3, roles: { user: 2, assistant: 1 }, durationMs: 30000, tokens: 60, cost: 0, topTools: [], tips: [] });
    case 'model_set': {
      const provider = cmd.provider ?? 'fake';
      const id = cmd.model ?? cmd.alias ?? 'fake-2';
      const existing = (modelStore.models[provider] ?? []).find((m) => m.id === id);
      modelStore.current = { provider, id, name: id, contextWindow: existing?.contextWindow ?? 128000, reasoning: existing?.reasoning ?? false, supportedThinkingLevels: ['off', 'low', 'medium', 'high'] };
      return reply({ provider, id, name: id, alias: cmd.alias ?? null });
    }
    case 'auth_set_key': {
      if (!cmd.provider || !cmd.key) return fail('auth_set_key requires {provider, key}');
      // mirror the real placeholder guard: obviously fake keys are refused
      if (/^sk-(mock|test|xxx|placeholder)$/i.test(cmd.key)) {
        return reply({ provider: cmd.provider, hasAuth: false, error: 'key looks like a placeholder — paste the real credential' });
      }
      modelStore.authed.add(cmd.provider);
      return reply({ provider: cmd.provider, hasAuth: true });
    }
    case 'auth_clear': {
      modelStore.authed.delete(cmd.provider);
      return reply({ provider: cmd.provider, hasAuth: false });
    }
    case 'model_ping':
      return reply({
        ok: true, reachable: true, httpStatus: 200, ms: 1,
        configured: modelStore.authed.has(cmd.provider) || Boolean(cmd.key),
        authSource: cmd.key ? 'direct input' : 'stored credential',
      });
    case 'provider_add': {
      if (!cmd.provider || !cmd.baseUrl) return fail('provider_add requires {provider, baseUrl}');
      if (!modelStore.providers.some((p) => p.id === cmd.provider)) {
        modelStore.providers.push({ id: cmd.provider, name: cmd.provider, baseUrl: cmd.baseUrl, api: cmd.api });
      }
      const ids = (Array.isArray(cmd.models) && cmd.models.length ? cmd.models : [cmd.model]).filter(Boolean);
      modelStore.models[cmd.provider] = ids.map((id) => ({ provider: cmd.provider, id, name: id, reasoning: false }));
      return reply({ provider: cmd.provider, model: cmd.model ?? ids[0] });
    }
    case 'provider_models_fetch':
      return reply({ ok: true, provider: cmd.provider, models: ['demo-alpha', 'demo-beta', 'demo-gamma'] });
    case 'provider_models_add': {
      const list = modelStore.models[cmd.provider] ??= [];
      for (const id of cmd.models ?? []) {
        if (!list.some((m) => m.id === id)) list.push({ provider: cmd.provider, id, name: id, reasoning: false });
      }
      return reply({ ok: true, provider: cmd.provider, added: cmd.models ?? [], total: list.length });
    }
    case 'provider_model_delete': {
      if (!cmd.provider || !cmd.model) return fail('provider_model_delete requires {provider, model}');
      const list = modelStore.models[cmd.provider];
      if (list) {
        modelStore.models[cmd.provider] = list.filter((m) => m.id !== cmd.model);
        if (modelStore.models[cmd.provider].length === 0) {
          delete modelStore.models[cmd.provider];
        }
      }
      return reply({ ok: true, provider: cmd.provider, deleted: cmd.model });
    }
    case 'provider_delete': {
      if (!cmd.provider) return fail('provider_delete requires {provider}');
      delete modelStore.models[cmd.provider];
      return reply({ ok: true, provider: cmd.provider });
    }
    case 'model_update': {
      if (!cmd.provider || !cmd.model) return fail('model_update requires {provider, model}');
      const list = modelStore.models[cmd.provider] ?? [];
      const m = list.find((x) => x.id === cmd.model);
      if (m) {
        if (cmd.contextWindow !== undefined) m.contextWindow = Number(cmd.contextWindow);
        if (cmd.reasoning !== undefined) m.reasoning = Boolean(cmd.reasoning);
        if (cmd.speed !== undefined) m.speed = cmd.speed;
      }
      return reply({ ok: true, provider: cmd.provider, model: cmd.model, updated: m });
    }
    case 'model_fast': {
      const tier = modelStore.fastTier ?? null;
      return reply({ enabled: tier === 'priority', tier, supported: true, provider: modelStore.current?.provider, model: modelStore.current?.id });
    }
    case 'model_fast_set': {
      modelStore.fastTier = cmd.off ? null : (cmd.tier ?? 'priority');
      return reply({ enabled: modelStore.fastTier === 'priority', tier: modelStore.fastTier, supported: true, provider: modelStore.current?.provider, model: modelStore.current?.id });
    }
    case 'config_get':
      return reply({ model: { provider: 'fake', id: 'fake-1' }, thinking: currentThinkingLevel, mode: currentRiskMode });
    case 'config_set':
      return reply({ applied: true, key: cmd.key, value: cmd.value });
    case 'session_history': {
      // The answer is tagged with the session it belongs to, and only the
      // designated slow session is delayed — so "a late answer overwrote a
      // newer one" becomes observable instead of a race that might pass.
      const at = String(currentFile ?? '');
      const rows = historyMark
        ? [{ role: 'user', text: `hist:${at.split(/[/\\]/).pop()}` }]
        : historyRows();
      if (historyDelayMs > 0 && historySlowFor && at.endsWith(historySlowFor)) {
        setTimeout(() => reply(rows), historyDelayMs);
        return;
      }
      return reply(rows);
    }
    case 'model_status': return reply({
      current: modelStore.current,
      providers: modelStore.providers.map((p) => ({
        ...p,
        hasAuth: modelStore.authed.has(p.id),
        models: modelStore.models[p.id] ?? [],
      })),
      thinkingLevel: currentThinkingLevel,
    });
    case 'model_list': return reply(Object.values(modelStore.models).flat());
    case 'thinking_set': {
      if (!cmd.level) return fail('level required');
      currentThinkingLevel = String(cmd.level);
      return reply({ level: currentThinkingLevel });
    }
    case 'risk_mode': return reply({ mode: currentRiskMode });
    case 'risk_mode_set': {
      if (!['normal', 'plan'].includes(cmd.mode)) return fail("risk_mode_set: mode must be 'normal' or 'plan'");
      currentRiskMode = cmd.mode;
      return reply({ mode: currentRiskMode });
    }
    case 'task_list': {
      return reply(taskStore.map((t) => ({ task_id: t.task_id, state: t.state, job_id: t.job_id, title: t.title, updatedAt: t.updatedAt })));
    }
    case 'task_events': {
      if (!cmd.taskId) return fail('task_events requires {taskId}');
      const t = taskStore.find((x) => x.task_id === String(cmd.taskId));
      if (!t) return fail(`task '${cmd.taskId}' not found`);
      return reply({ task: t, inbox: t.inbox, outbox: t.outbox, events: t.events });
    }
    case 'task_send': {
      if (!cmd.taskId || cmd.body == null) return fail('task_send requires {taskId,body}');
      const t = taskStore.find((x) => x.task_id === String(cmd.taskId));
      if (!t) return fail(`task '${cmd.taskId}' not found`);
      t.inbox.push({ from: 'operator', body: String(cmd.body), ts: new Date().toISOString() });
      return reply({ seq: t.inbox.length });
    }
    case 'task_interrupt': {
      if (!cmd.taskId) return fail('task_interrupt requires {taskId}');
      const t = taskStore.find((x) => x.task_id === String(cmd.taskId));
      if (!t) return fail(`task '${cmd.taskId}' not found`);
      t.events.push({ kind: 'interrupted', data: { ok: true }, ts: new Date().toISOString() });
      return reply({ ok: true, task_id: t.task_id, interrupted: true });
    }
    case 'task_close': {
      if (!cmd.taskId) return fail('task_close requires {taskId}');
      const t = taskStore.find((x) => x.task_id === String(cmd.taskId));
      if (!t) return fail(`task '${cmd.taskId}' not found`);
      t.state = 'closed';
      return reply({ task_id: t.task_id, state: 'closed' });
    }
    case 'job_spawn':
      if (!cmd.command) return fail('command required');
      if (cmd.in_worktree && cmd.in_worktree !== 'wt-linked') return fail(`no such worktree '${cmd.in_worktree}'`);
      return reply({ ok: true, jobId: 'fake-job-1', worktree: cmd.worktree === true, workdir: cmd.in_worktree ? '/repo/wt-linked' : undefined });
    case 'worktree_list':
      // The linked worktree is a REAL dir under the instance root so the
      // supervisor's set_workdir existsSync check passes end-to-end (#1353).
      mkdirSync(`${instance}/wt-linked`, { recursive: true });
      return reply({ ok: true, worktrees: [
        { path: '/repo', head: 'aaa', branch: 'main', detached: false, bare: false, managed: false },
        { path: `${instance}/wt-linked`, head: 'bbb', branch: null, detached: true, bare: false, managed: true },
      ] });
    case 'job_status':
      return reply({
        job: { job_id: cmd.job_id, job_type: 'shell', job_state: 'RUNNING', orchestration_state: 'foreground' },
        attempts: 1,
        lease: { writer_id: 'fake-writer' },
        detail: {
          command: 'pytest -q', running: true, exit_code: null,
          output_tail: 'collecting… 12 items',
          events: [{ timestamp: '2026-01-01T00:00:01Z', event_type: 'SPAWN' }],
        },
      });
    case 'job_cancel': return reply({ killed: true });
    case 'bash_run':
      if (!cmd.command) return fail('command required');
      return reply({ output: `domgate-bash-out[${cmd.command}]`, code: 0 });
    case 'job_list':
      return reply([{ job_id: 'job-dom-1', job_type: 'shell', job_state: 'RUNNING', updated_at: '2026-01-01T00:00:00Z' }]);
    case 'audit_tail': return reply([]);
    case 'session_entries': return reply([]);
    case 'session_export': return fail('export unsupported in fixture');
    case 'session_search': return reply([]);
    case 'session_delete': {
      deletedSessions.add(cmd.path);
      return reply({ removed: cmd.path });
    }
    case 'audit_tail': return reply([]);
    case 'handoff_prepare':
      return reply({
        runId, sessionId: `sess-${body}`,
        heldLeases: held ? [{ scope: 'domain', name: leaseName, owner, generation: held.generation }] : [],
      });
    case 'handoff_export': {
      const policy = loadPolicy(join(instance, 'canonical'));
      const predictions = new PredictionStore(join(instance, 'world-model'));
      return reply({
        goalIdentity: `goal:sess-${body}`,
        canonicalCursor: `sha256:${sha256(JSON.stringify(predictions.openPredictions()))}`,
        soulIdentity: 'soul:personal-ai',
        openPredictions: predictions.openPredictions().map((p) => p.id),
        jobCursors: [],
        policyIdentity: `sha256:${policy.checksum}`,
        provenanceChain: [runId],
        source: { body, session: `sess-${body}`, run: runId },
      });
    }
    case 'handoff_release': {
      let released = [];
      if (held) {
        const r = leases.release({ scope: 'domain', name: leaseName, owner, generation: held.generation });
        if (r.ok) released = [leaseName];
        held = null;
      }
      return reply({ released });
    }
    default:
      return fail(`unknown command '${cmd.type}'`);
  }
});
rl.on('close', () => {
  if (held) {
    leases.release({ scope: 'domain', name: leaseName, owner, generation: held.generation });
    held = null;
  }
  leases.close();
  process.exit(0);
});
