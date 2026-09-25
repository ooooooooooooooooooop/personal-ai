/**
 * M6 pi channel facade — real AgentSession subscribe + real audit file tail.
 * Asserts the facade translates Pi state into plain-data snapshots.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelHost } from '../src/adapter/channel.js';

const fakeSession = () => ({
  calls: [],
  prompt: async (m) => { fakeSessionRef.calls.push(m); },
  steer: async (m) => { fakeSessionRef.calls.push(['steer', m]); },
  abort: async () => { fakeSessionRef.calls.push(['abort']); },
  subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
  model: { provider: 'cpa', id: 'gpt-5.6-luna-max' },
  isStreaming: false,
  messages: [{ role: 'user' }, { role: 'assistant' }],
});
let fakeSessionRef; const listeners = new Set();

test('facade exposes plain-data get_state and dispatches prompt/steer/abort', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(join(auditDir, `${new Date().toISOString().slice(0, 10)}.jsonl`),
    `${JSON.stringify({ kind: 'HOST_STARTED' })}\n${JSON.stringify({ kind: 'TURN_ACCOUNTING', data: { input: 10 } })}\n`);
  const core = { paths: { auditDir } };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core });

  const state = await ch.handle({ type: 'get_state' });
  assert.equal(state.data.model.id, 'gpt-5.6-luna-max');
  assert.equal(state.data.messageCount, 2);

  await ch.handle({ type: 'prompt', message: 'go' });
  assert.deepEqual(fakeSessionRef.calls[0], 'go');

  const tail = await ch.handle({ type: 'audit_tail', n: 1 });
  assert.equal(tail.data.events[0].kind, 'TURN_ACCOUNTING');
  dispose();
});

test('budget gate: over-limit prompt is refused and billed events emit budget_exceeded', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-budget-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const { BudgetGovernor } = await import('../../host/src/core/budget.js');
  const { AuditWriter } = await import('../../host/src/core/audit.js');
  const audit = new AuditWriter({ auditDir });
  const budget = new BudgetGovernor({
    ledgerPath: join(dir, 'budget-ledger.jsonl'),
    limits: { maxTokensPerSession: 100 },
    audit,
  });
  const core = { paths: { auditDir }, audit };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core, budget });
  fakeSessionRef.sessionId = 's-test';
  fakeSessionRef.sessionManager = { getSessionId: () => 's-test' };

  // bill the session over the cap via a usage-bearing assistant event
  const events = [];
  ch.subscribe((m) => events.push(m));
  for (const l of [...listeners]) l({ type: 'message_end', message: { role: 'assistant', usage: { input: 80, output: 40, cost: { total: 0.01 } } } });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(events.some((m) => m.event?.type === 'budget_exceeded'), 'budget_exceeded emitted');
  assert.ok(fakeSessionRef.calls.some((c) => c[0] === 'abort'), 'run aborted on breach');

  // next prompt is refused at admission — the model never gets to spend more
  const r = await ch.handle({ type: 'prompt', message: 'again' });
  assert.equal(r.success, false);
  assert.match(r.error, /budget/);
  dispose();
});

test('budget_set: operator dial hot-applies, persists, audits; invalid input refused', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-budgetset-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const { BudgetGovernor } = await import('../../host/src/core/budget.js');
  const { AuditWriter } = await import('../../host/src/core/audit.js');
  const audit = new AuditWriter({ auditDir });
  const budget = new BudgetGovernor({
    ledgerPath: join(dir, 'budget-ledger.jsonl'),
    limits: { maxTokensPerSession: 100 },
    audit,
  });
  const core = { paths: { auditDir, root: dir }, audit };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core, budget });
  fakeSessionRef.sessionId = 's-set';
  fakeSessionRef.sessionManager = { getSessionId: () => 's-set' };

  // invalid: unknown key / negative value refused without mutation
  let r = await ch.handle({ type: 'budget_set', limits: { nope: 5 } });
  assert.equal(r.success, false);
  assert.match(r.error, /unknown limit/);
  r = await ch.handle({ type: 'budget_set', limits: { maxTokensPerSession: -1 } });
  assert.equal(r.success, false);
  assert.equal(budget.limits.maxTokensPerSession, 100, 'limit unchanged on refusal');

  // valid: hot-applied to the live governor AND persisted for next boot
  r = await ch.handle({ type: 'budget_set', limits: { maxTokensPerSession: 5000, maxCallsPerSession: 50 } });
  assert.equal(r.success, true);
  assert.equal(budget.limits.maxTokensPerSession, 5000, 'live governor sees the new cap immediately');
  assert.equal(budget.limits.maxCallsPerSession, 50);
  const persisted = JSON.parse(readFileSync(join(dir, 'budget-overrides.json'), 'utf-8'));
  assert.equal(persisted.limits.maxCallsPerSession, 50);

  // clearing removes the override file -> back to policy/env tier next boot
  r = await ch.handle({ type: 'budget_set', limits: { maxTokensPerSession: null, maxCallsPerSession: null } });
  assert.equal(r.success, true);
  assert.equal(budget.limits, null);
  assert.ok(!existsSync(join(dir, 'budget-overrides.json')), 'override file removed when limits cleared');

  const tail = await ch.handle({ type: 'audit_tail', n: 5 });
  assert.ok(tail.data.events.some((e) => e.kind === 'BUDGET_LIMITS_SET'), 'both mutations audited');
  dispose();
});

test('audit_tail pages through full history with a lines-from-end cursor', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-auditpage-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const { AuditWriter } = await import('../../host/src/core/audit.js');
  const audit = new AuditWriter({ auditDir });
  for (let i = 0; i < 12; i++) audit.write({ kind: `E${i}`, data: { i } });
  // a previous day's file must be included too — history is cross-day
  writeFileSync(join(auditDir, '2020-01-01.jsonl'), JSON.stringify({ kind: 'E_OLD', ts: '2020-01-01T00:00:00Z' }) + String.fromCharCode(10));
  const core = { paths: { auditDir, root: dir }, audit };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core });

  let r = await ch.handle({ type: 'audit_tail', n: 5 });
  assert.equal(r.data.events.length, 5);
  assert.equal(r.data.hasMore, true);
  assert.equal(r.data.total, 13);
  assert.equal(r.data.events.at(-1).kind, 'E11', 'freshest page ends at the newest event');

  r = await ch.handle({ type: 'audit_tail', n: 5, before: 5 });
  assert.equal(r.data.events.at(-1).kind, 'E6', 'cursor walks back exactly one page');

  r = await ch.handle({ type: 'audit_tail', n: 5, before: 10 });
  assert.equal(r.data.hasMore, false);
  assert.equal(r.data.events[0].kind, 'E_OLD', 'oldest page reaches prior-day files');
  dispose();
});

test('M115: session_history preserves media descriptors — non-text blocks are not dropped', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  fakeSessionRef.messages = [
    { role: 'user', content: [{ type: 'text', text: 'look' }] },
    { role: 'toolResult', toolName: 'shot', content: [
      { type: 'text', text: 'screenshot attached' },
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      { type: 'resource', resource: { uri: 'mcp://srv/doc', mimeType: 'text/csv', name: 'data.csv' } },
    ] },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ];
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-media-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const core = { paths: { auditDir, root: dir } };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core });

  const r = await ch.handle({ type: 'session_history' });
  const msgs = r.data?.messages ?? r.data;
  const tr = msgs.find((m) => m.role === 'toolResult');
  assert.ok(tr, 'toolResult message present');
  assert.equal(tr.text, 'screenshot attached');
  assert.deepEqual(tr.media, [
    { type: 'image', mimeType: 'image/png', name: null },
    { type: 'resource', mimeType: 'text/csv', name: 'data.csv' },
  ], 'image/resource blocks survive as bounded descriptors — no raw data/uri');
  assert.ok(!JSON.stringify(tr.media).includes('AAAA'), 'blob payload never crosses the wire');
  assert.ok(!JSON.stringify(tr.media).includes('mcp://'), 'resource URI stays in the body');
  const plain = msgs.find((m) => m.role === 'assistant');
  assert.equal(plain.media, null, 'text-only messages carry no media field noise');
  dispose();
});

test('M71: ephemeral session refuses session_export in every format', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  // in-memory session: no file, and exportToHtml WOULD still write one —
  // the guard must refuse before it ever runs. Production wiring tracks
  // ephemeral sessions in a bootstrap-owned WeakSet, surfaced via the
  // sessionFlags dep — the test exercises the same predicate path.
  const eph = new WeakSet();
  eph.add(fakeSessionRef);
  let htmlCalled = false;
  fakeSessionRef.exportToHtml = async () => { htmlCalled = true; return 'x'; };
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-eph-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const core = { paths: { auditDir } };
  const { channel: ch, dispose } = createChannelHost({
    session: fakeSessionRef, core,
    sessionFlags: { isEphemeral: (s) => eph.has(s) },
  });
  for (const format of ['html', 'jsonl', 'debug']) {
    const r = await ch.handle({ type: 'session_export', format });
    assert.equal(r.success, false, format);
    assert.match(r.error, /not exportable/);
  }
  assert.equal(htmlCalled, false);
  // a persistent session still exports normally (guard doesn't over-fire)
  const persistent = fakeSession();
  persistent.sessionFile = join(dir, 'live.jsonl');
  writeFileSync(persistent.sessionFile, '{"a":1}\n');
  const { channel: ch2, dispose: dispose2 } = createChannelHost({
    session: persistent, core,
    sessionFlags: { isEphemeral: (s) => eph.has(s) },
  });
  const ok = await ch2.handle({ type: 'session_export', format: 'jsonl' });
  assert.equal(ok.success, true);
  assert.ok(ok.data.file, 'persistent export produces a file');
  dispose(); dispose2();
});

test('U5 attachments: images ride options.images, media degrade to descriptors', async () => {
  const calls = [];
  fakeSessionRef = fakeSession(); listeners.clear();
  fakeSessionRef.prompt = async (m, o) => calls.push([m, o]);
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-att-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const audit = { events: [], write(e) { this.events.push(e); } };
  const core = { paths: { auditDir }, audit };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core });

  await ch.handle({
    type: 'prompt', message: 'look at these',
    options: { attachments: [
      { name: 'p.png', mime: 'image/png', data: 'aGk=' },
      { name: 's.mp3', mime: 'audio/mpeg', data: 'aGk=' },
      { name: 'bad' }, // rejected — must not eat the prompt
    ] },
  });
  const [msg, opts] = calls[0];
  assert.deepEqual(opts.images, [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }]);
  assert.match(msg, /look at these/);
  assert.match(msg, /<attachment kind="audio" name="s.mp3"/);
  assert.ok(audit.events.some((e) => e.kind === 'ATTACHMENT_REJECTED'));
  dispose();
});

test('fileops_diff and session_btw dispatch to their facades; unavailable surfaces fail closed', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-ops-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const core = { paths: { auditDir } };
  const calls = [];
  const { channel: ch, dispose } = createChannelHost({
    session: fakeSessionRef, core,
    fileops: { diff: async (n) => (calls.push(['diff', n]), { diffs: [], skipped: [] }) },
    sessions: { btw: async (m) => (calls.push(['btw', m]), { answer: 'side' }) },
  });
  const d = await ch.handle({ type: 'fileops_diff', n: 5 });
  assert.equal(d.success, true);
  const b = await ch.handle({ type: 'session_btw', message: 'side q' });
  assert.equal(b.data.answer, 'side');
  const bad = await ch.handle({ type: 'session_btw' });
  assert.equal(bad.success, false);
  assert.deepEqual(calls, [['diff', 5], ['btw', 'side q']]);
  dispose();

  // no facades → fail closed, not crash
  const bare = createChannelHost({ session: fakeSessionRef, core });
  const r1 = await bare.channel.handle({ type: 'fileops_diff' });
  const r2 = await bare.channel.handle({ type: 'session_btw', message: 'x' });
  assert.equal(r1.success, false);
  assert.equal(r2.success, false);
  bare.dispose();
});

test('mode_list/mode_set dispatch to modes facade; unknown mode fails closed', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-mode-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const core = { paths: { auditDir } };
  let active = 'normal';
  const { channel: ch, dispose } = createChannelHost({
    session: fakeSessionRef, core,
    modes: {
      list: () => [{ name: 'normal' }, { name: 'review', description: 'read-only' }],
      active: () => active,
      setMode: (name) => (name === 'review' ? (active = name, { mode: name }) : null),
    },
  });
  const l = await ch.handle({ type: 'mode_list' });
  assert.equal(l.success, true);
  assert.equal(l.data.modes.length, 2);
  const s = await ch.handle({ type: 'mode_set', name: 'review' });
  assert.equal(s.data.mode, 'review');
  const bad = await ch.handle({ type: 'mode_set', name: 'ghost' });
  assert.equal(bad.success, false);
  assert.match(bad.error, /unknown mode/);
  // no facade → fail closed
  const bare = createChannelHost({ session: fakeSessionRef, core });
  assert.equal((await bare.channel.handle({ type: 'mode_list' })).success, false);
  bare.dispose();
  dispose();
});

test('model alias commands manage <instance>/model-aliases.json; prompt/steer reset turn budget', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-alias-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const core = { paths: { auditDir, root: dir } };
  let resets = 0;
  const { channel: ch, dispose } = createChannelHost({
    session: fakeSessionRef, core,
    turns: { reset: () => { resets += 1; } },
  });
  // alias CRUD through real channel commands
  const s = await ch.handle({ type: 'model_alias_set', name: 'fast', provider: 'cpa', model: 'm1' });
  assert.equal(s.success, true);
  const l = await ch.handle({ type: 'model_alias_list' });
  assert.deepEqual(l.data, [{ name: 'fast', provider: 'cpa', model: 'm1' }]);
  // model_set {alias} resolves through the facade's alias path — the facade
  // itself is session-bound, so here we assert the command reaches it
  await ch.handle({ type: 'model_alias_del', name: 'fast' });
  assert.equal((await ch.handle({ type: 'model_alias_list' })).data.length, 0);
  // turn-budget reset fires on prompt AND steer (a user msg = fresh budget)
  await ch.handle({ type: 'prompt', message: 'go' });
  await ch.handle({ type: 'steer', message: 'hold' });
  assert.equal(resets, 2);
  dispose();
});

test('session_save/saved_list/agent_stats dispatch; auto-name fills only the null slot', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-sess-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const core = { paths: { auditDir } };
  const calls = [];
  const { channel: ch, dispose } = createChannelHost({
    session: fakeSessionRef, core,
    sessions: {
      save: async (n) => (calls.push(['save', n]), { name: n, path: `/saved/${n}.jsonl` }),
      savedList: async () => [{ name: 'cp1', path: '/saved/cp1.jsonl', modified: '2026-01-01' }],
      agentStats: async () => ({ sessions: 3, messages: 9, userMessages: 4, tokens: 1200, cost: 0.5 }),
    },
  });
  const s = await ch.handle({ type: 'session_save', name: 'cp1' });
  assert.equal(s.success, true);
  assert.equal(s.data.path, '/saved/cp1.jsonl');
  assert.deepEqual(calls, [['save', 'cp1']]);
  assert.equal((await ch.handle({ type: 'session_saved_list' })).data[0].name, 'cp1');
  const st = await ch.handle({ type: 'agent_stats' });
  assert.equal(st.data.sessions, 3);
  assert.equal(st.data.cost, 0.5);
  // auto-name: first real prompt names an unnamed session
  let named = null;
  fakeSessionRef.sessionName = undefined;
  fakeSessionRef.setSessionName = (n) => { named = n; };
  await ch.handle({ type: 'prompt', message: '  修复   登录页的   样式 ' });
  assert.equal(named, '修复 登录页的 样式');
  // named sessions are never overwritten
  fakeSessionRef.sessionName = '手工命名';
  named = null;
  await ch.handle({ type: 'prompt', message: '另一条消息' });
  assert.equal(named, null);
  // fail closed without the facade
  const bare = createChannelHost({ session: fakeSessionRef, core });
  assert.equal((await bare.channel.handle({ type: 'session_save', name: 'x' })).success, false);
  assert.equal((await bare.channel.handle({ type: 'agent_stats' })).success, false);
  bare.dispose();
  dispose();
});

test('task_* commands dispatch to the mailbox facade; interrupt maps to job cancel', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-task-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const core = { paths: { auditDir } };
  const { TaskStore } = await import('../../host/src/core/tasks.js');
  const store = new TaskStore(dir);
  const t = store.create({ label: 'child work' });
  store.bindJob(t.task_id, 'job-1');
  const interrupts = [];
  const { channel: ch, dispose } = createChannelHost({
    session: fakeSessionRef, core,
    tasks: {
      list: () => store.list(), get: (id) => store.get(id),
      read: (id, s, since) => store.read(id, s, since),
      postInbox: (id, m) => store.postInbox(id, m),
      postEvent: (id, k, d) => store.postEvent(id, k, d),
      setState: (id, s) => store.setState(id, s),
      interrupt: async (jobId) => { interrupts.push(jobId); return { ok: true }; },
    },
  });
  const l = await ch.handle({ type: 'task_list' });
  assert.equal(l.data[0].task_id, t.task_id);
  const send = await ch.handle({ type: 'task_send', taskId: t.task_id, body: 'operator note' });
  assert.equal(send.data.seq, 1);
  const ev = await ch.handle({ type: 'task_events', taskId: t.task_id });
  assert.equal(ev.data.inbox[0].body, 'operator note');
  assert.ok(ev.data.events.some((e) => e.kind === 'task_created'));
  const ix = await ch.handle({ type: 'task_interrupt', taskId: t.task_id });
  assert.equal(ix.success, true);
  assert.deepEqual(interrupts, ['job-1']);
  const cl = await ch.handle({ type: 'task_close', taskId: t.task_id });
  assert.equal(cl.data.state, 'closed');
  const late = await ch.handle({ type: 'task_send', taskId: t.task_id, body: 'x' });
  assert.equal(late.success, false); // closed refuses
  // no store → fail closed
  const bare = createChannelHost({ session: fakeSessionRef, core });
  assert.equal((await bare.channel.handle({ type: 'task_list' })).success, false);
  assert.equal((await bare.channel.handle({ type: 'task_send', taskId: 't', body: 'x' })).success, false);
  bare.dispose();
  dispose();
});

test('microagent knowledge injects on trigger match; auto-compact fires once at 90%', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-kb-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const audit = { events: [], write(e) { this.events.push(e); } };
  const core = { paths: { auditDir }, audit };
  const { channel: ch, dispose } = createChannelHost({
    session: fakeSessionRef, core,
    knowledge: {
      match: (text) => /deploy/.test(text)
        ? { text: '<knowledge name="deploy">migrations first</knowledge>', agents: ['deploy'] }
        : null,
    },
  });
  const calls = [];
  fakeSessionRef.prompt = async (m) => calls.push(m);
  await ch.handle({ type: 'prompt', message: 'deploy the service' });
  assert.match(calls[0], /<knowledge name="deploy">/);
  assert.ok(audit.events.some((e) => e.kind === 'KNOWLEDGE_INJECTED'));
  await ch.handle({ type: 'prompt', message: 'unrelated question' });
  assert.equal(calls[1], 'unrelated question');

  // auto-compact: assistant message_end at ≥90% context → compact once
  let compacts = 0;
  fakeSessionRef.isStreaming = false;
  fakeSessionRef.getContextUsage = () => ({ tokens: 950, contextWindow: 1000 });
  fakeSessionRef.compact = async () => { compacts++; };
  const events = [];
  ch.subscribe((m) => events.push(m));
  for (const l of [...listeners]) l({ type: 'message_end', message: { role: 'assistant', usage: { input: 1, output: 1 } } });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(compacts, 1);
  assert.ok(events.some((m) => m.event?.type === 'auto_compact'));
  assert.ok(audit.events.some((e) => e.kind === 'AUTO_COMPACT'));
  // latch: second threshold message does NOT compact again this session
  for (const l of [...listeners]) l({ type: 'message_end', message: { role: 'assistant', usage: { input: 1, output: 1 } } });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(compacts, 1);
  dispose();
});

test('session_export format=jsonl copies the raw session file to exports/', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-exp-'));
  const auditDir = join(dir, 'audit');
  const sessDir = join(dir, 'sessions');
  mkdirSync(auditDir, { recursive: true });
  mkdirSync(sessDir, { recursive: true });
  const src = join(sessDir, 's1.jsonl');
  writeFileSync(src, '{"role":"user"}\n{"role":"assistant"}\n');
  fakeSessionRef.sessionFile = src;
  fakeSessionRef.exportToHtml = async () => '/tmp/out.html';
  const core = { paths: { auditDir } };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core });
  const j = await ch.handle({ type: 'session_export', format: 'jsonl' });
  assert.equal(j.success, true);
  assert.equal(j.data.format, 'jsonl');
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(j.data.file, 'utf-8'), '{"role":"user"}\n{"role":"assistant"}\n');
  const h = await ch.handle({ type: 'session_export' });
  assert.equal(h.data.file, '/tmp/out.html');
  assert.equal(h.data.format, 'html');
  dispose();
});

test('session_export markdown/quarto: full transcript doc, fenced blocks, quarto frontmatter', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-mdexp-'));
  const auditDir = join(dir, 'audit');
  const sessDir = join(dir, 'sessions');
  mkdirSync(auditDir, { recursive: true });
  mkdirSync(sessDir, { recursive: true });
  const src = join(sessDir, 's1.jsonl');
  writeFileSync(src, [
    JSON.stringify({ type: 'message', timestamp: '2026-09-23T01:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hello world' }] } }),
    JSON.stringify({ type: 'message', timestamp: '2026-09-23T01:00:01Z', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'answer text' },
      { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } },
    ] } }),
    JSON.stringify({ type: 'message', timestamp: '2026-09-23T01:00:02Z', message: { role: 'toolResult', content: [{ type: 'tool_result', content: 'file1\nfile2', isError: false }] } }),
    '{"torn":', // torn tail tolerated
  ].join('\n') + '\n');
  fakeSessionRef.sessionFile = src;
  const core = { paths: { auditDir } };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core });
  const { readFileSync } = await import('node:fs');
  const md = await ch.handle({ type: 'session_export', format: 'markdown' });
  assert.equal(md.success, true);
  assert.equal(md.data.format, 'markdown');
  assert.ok(md.data.file.endsWith('.md'));
  const doc = readFileSync(md.data.file, 'utf-8');
  assert.match(doc, /## User — 2026-09-23T01:00:00\.000Z/);
  assert.match(doc, /hello world/);
  assert.match(doc, /## Assistant/);
  assert.match(doc, /answer text/);
  assert.match(doc, /🔧 bash/);
  assert.match(doc, /```json\n\{\n  "command": "ls"/);
  assert.match(doc, /\*\*result\*\*/);
  assert.match(doc, /file1\nfile2/);
  const q = await ch.handle({ type: 'session_export', format: 'quarto' });
  assert.equal(q.data.format, 'quarto');
  assert.ok(q.data.file.endsWith('.qmd'));
  const qdoc = readFileSync(q.data.file, 'utf-8');
  assert.match(qdoc, /^---\ntitle: "Session/);
  assert.match(qdoc, /format: html/);
  assert.match(qdoc, /## User/);
  dispose();
});

test('modes_read/modes_save dispatch; fileops_diff forwards receiptId filter', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-med-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const core = { paths: { auditDir } };
  const calls = [];
  const { channel: ch, dispose } = createChannelHost({
    session: fakeSessionRef, core,
    modes: {
      list: () => [], active: () => 'normal',
      readProject: () => ({ path: '/w/.pai/modes.json', content: '{"modes":[]}' }),
      saveProject: (c) => (calls.push(['save', c]), { ok: true, presets: 1 }),
    },
    fileops: { diff: async (n, rid) => (calls.push(['diff', n, rid]), { diffs: [], skipped: [] }) },
  });
  const rd = await ch.handle({ type: 'modes_read' });
  assert.equal(rd.data.content, '{"modes":[]}');
  const sv = await ch.handle({ type: 'modes_save', content: '{"modes":[{"name":"review"}]}' });
  assert.equal(sv.data.ok, true);
  await ch.handle({ type: 'fileops_diff', receiptId: 'r-9' });
  assert.deepEqual(calls[1], ['diff', undefined, 'r-9']);
  dispose();
});

test('bash_run dispatches to exec facade; unavailable exec fails closed; goals ride get_state', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-'));
  const core = { paths: { auditDir: join(dir, 'audit') } };
  const ran = [];
  const { channel: ch, dispose } = createChannelHost({
    session: fakeSessionRef, core,
    exec: { run: async (command) => (ran.push(command), { ok: true, code: 0, output: 'hi' }) },
    goals: () => ({ requirements: [{ id: 'r1', kind: 'tool_success' }], continuations: 2, maxContinuations: 8, lastAction: 'continue', lastGaps: ['r1'] }),
  });
  const r = await ch.handle({ type: 'bash_run', command: 'ls -la' });
  assert.equal(r.success, true);
  assert.deepEqual(ran, ['ls -la']);
  assert.equal(r.data.output, 'hi');
  const st = await ch.handle({ type: 'get_state' });
  assert.equal(st.data.goals.requirements[0].id, 'r1');
  assert.equal(st.data.goals.lastAction, 'continue');
  dispose();

  const bare = createChannelHost({ session: fakeSessionRef, core });
  const r2 = await bare.channel.handle({ type: 'bash_run', command: 'ls' });
  assert.equal(r2.success, false);
  assert.match(r2.error, /exec facade unavailable/);
  const st2 = await bare.channel.handle({ type: 'get_state' });
  assert.equal(st2.data.goals, null);
  bare.dispose();
});

test('commands_read/save dispatch; project file refuses allowPrefixes (layered ownership)', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-cmd-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const { AuditWriter } = await import('../../host/src/core/audit.js');
  const audit = new AuditWriter({ auditDir });
  const workdir = join(dir, 'work'); mkdirSync(workdir, { recursive: true });
  const instanceRoot = join(dir, 'inst'); mkdirSync(instanceRoot, { recursive: true });
  const { readFileSync, writeFileSync: wf, mkdirSync: md } = await import('node:fs');
  const core = { paths: { auditDir }, audit };
  // same facade shape bootstrap builds — exercised through the real channel
  const commands = {
    readProject: () => {
      const f = join(workdir, '.pai', 'commands.json');
      try { return { path: f, content: readFileSync(f, 'utf-8') }; } catch { return { path: f, content: '' }; }
    },
    saveProject: (content) => {
      let doc; try { doc = JSON.parse(content); } catch (e) { return { error: `invalid JSON: ${e.message}` }; }
      if (Object.keys(doc ?? {}).some((k) => k !== 'denyPrefixes')) return { error: 'only denyPrefixes is allowed here' };
      if (!Array.isArray(doc.denyPrefixes ?? [])) return { error: 'denyPrefixes must be an array' };
      md(join(workdir, '.pai'), { recursive: true });
      const f = join(workdir, '.pai', 'commands.json');
      wf(f, JSON.stringify({ denyPrefixes: doc.denyPrefixes ?? [] }, null, 2));
      return { ok: true, path: f };
    },
    readAllow: () => {
      const f = join(instanceRoot, 'command-allow.json');
      try { return { path: f, content: readFileSync(f, 'utf-8') }; } catch { return { path: f, content: '' }; }
    },
    saveAllow: (content) => {
      let doc; try { doc = JSON.parse(content); } catch (e) { return { error: `invalid JSON: ${e.message}` }; }
      if (Object.keys(doc ?? {}).some((k) => k !== 'allowPrefixes')) return { error: 'only allowPrefixes is allowed' };
      const f = join(instanceRoot, 'command-allow.json');
      wf(f, JSON.stringify({ allowPrefixes: doc.allowPrefixes ?? [] }, null, 2));
      return { ok: true, path: f };
    },
  };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core, commands });

  // project deny file: save + read roundtrip — allowPrefixes is refused at
  // the facade (agent-writable config can only tighten)
  const bad = await ch.handle({ type: 'commands_save', content: '{"allowPrefixes":["npm"]}' });
  assert.equal(bad.success, false);
  assert.match(bad.error, /only denyPrefixes/);
  const good = await ch.handle({ type: 'commands_save', content: '{"denyPrefixes":["rm -rf"]}' });
  assert.equal(good.data.ok, true);
  const rd = await ch.handle({ type: 'commands_read' });
  assert.match(rd.data.content, /rm -rf/);

  // operator allow file roundtrip
  const sa = await ch.handle({ type: 'command_allow_save', content: '{"allowPrefixes":["git status"]}' });
  assert.equal(sa.data.ok, true);
  const ra = await ch.handle({ type: 'command_allow_read' });
  assert.match(ra.data.content, /git status/);

  // unavailable facade fails closed
  const bare = createChannelHost({ session: fakeSessionRef, core });
  const nr = await bare.channel.handle({ type: 'commands_read' });
  assert.equal(nr.success, false);
  bare.dispose();
  dispose();
});

test('session_export format=debug bundles trajectory + spawned task chain', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-debug-'));
  const auditDir = join(dir, 'audit'); mkdirSync(auditDir, { recursive: true });
  const sessDir = join(dir, 'sessions'); mkdirSync(sessDir, { recursive: true });
  const sessFile = join(sessDir, 's1.jsonl');
  writeFileSync(sessFile, '{"type":"message","role":"user"}\n{"type":"message","role":"assistant"}\n');
  fakeSessionRef.sessionFile = sessFile;
  fakeSessionRef.sessionId = 'sess-42';
  const core = { paths: { auditDir } };
  const taskRows = [
    { task_id: 't1', label: 'child', state: 'open', run_scope: 'sess-42', job_id: 'j1', parent_task_id: null },
    { task_id: 't2', label: 'grandchild', state: 'open', run_scope: 'sess-child', parent_task_id: 't1' },
    { task_id: 't3', label: 'other session', state: 'open', run_scope: 'sess-99' },
  ];
  const { channel: ch, dispose } = createChannelHost({
    session: fakeSessionRef, core,
    tasks: { list: () => taskRows, read: () => [{ seq: 1, kind: 'note' }] },
    jobs: { list: () => [{ job_id: 'j1', session_scope: 'sess-42' }, { job_id: 'j9', session_scope: 'sess-99' }] },
  });
  const r = await ch.handle({ type: 'session_export', format: 'debug' });
  assert.equal(r.success, true);
  const bundle = JSON.parse(readFileSync(r.data.file, 'utf-8'));
  assert.equal(bundle.sessionId, 'sess-42');
  assert.equal(bundle.trajectory.length, 2);
  // t1 bound directly (run_scope), t2 via parent chain, t3 excluded
  assert.deepEqual(bundle.tasks.map((t) => t.task_id).sort(), ['t1', 't2']);
  assert.equal(bundle.tasks[0].events[0].seq, 1);
  assert.deepEqual(bundle.jobs.map((j) => j.job_id), ['j1']);
  dispose();
});

test('mistake_limit: consecutive tool errors ask the operator; deny stops the run', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-ml-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const { LoopDetector } = await import('../../host/src/core/loopwatch.js');
  const lw = new LoopDetector({ errorLimit: 2 });
  const asked = [];
  const asks = { ask: async (d) => { asked.push(d); return 'deny'; } };
  const core = { paths: { auditDir }, audit: { write: () => {} } };
  const { channel: ch, dispose } = createChannelHost({
    session: fakeSessionRef, core, asks, getLoopwatch: () => lw,
  });
  const events = [];
  ch.subscribe((m) => events.push(m));
  // the error events themselves must stream through — not held behind the ask
  for (const l of [...listeners]) l({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', isError: true });
  assert.ok(events.some((m) => m.event?.type === 'tool_execution_end'), 'error event emitted before ask resolves');
  for (const l of [...listeners]) l({ type: 'tool_execution_end', toolCallId: 'c2', toolName: 'write', isError: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asked.length, 1);
  assert.equal(asked[0].rule, 'mistake_limit');
  assert.equal(lw.stopped, true);
  assert.ok(events.some((m) => m.event?.type === 'notify'), 'stop notice emitted');
  dispose();
});

test('mistake_limit: operator allow leaves the run unstopped', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-ml2-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const { LoopDetector } = await import('../../host/src/core/loopwatch.js');
  const lw = new LoopDetector({ errorLimit: 2 });
  const asks = { ask: async () => 'allow' };
  const core = { paths: { auditDir }, audit: { write: () => {} } };
  const { dispose } = createChannelHost({
    session: fakeSessionRef, core, asks, getLoopwatch: () => lw,
  });
  for (const l of [...listeners]) l({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', isError: true });
  for (const l of [...listeners]) l({ type: 'tool_execution_end', toolCallId: 'c2', toolName: 'bash', isError: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lw.stopped, false);
  dispose();
});

test('schedule_list / schedule_cancel dispatch to the shared store', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-sched-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const rows = [{ id: 's1', kind: 'interval', every_seconds: 300, enabled: true, nextRunAt: Date.now(), command: 'npm test' }];
  const schedules = {
    list: () => rows.filter((s) => s.enabled !== false),
    cancel: (id) => { const s = rows.find((x) => x.id === id); if (!s) return { error: 'not found' }; s.enabled = false; return { ok: true, id }; },
  };
  const core = { paths: { auditDir }, audit: { write: () => {} } };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core, schedules });

  const listed = await ch.handle({ type: 'schedule_list' });
  assert.equal(listed.success, true);
  assert.equal(listed.data[0].id, 's1');
  const c = await ch.handle({ type: 'schedule_cancel', id: 's1' });
  assert.equal(c.success, true);
  assert.equal((await ch.handle({ type: 'schedule_list' })).data.length, 0);
  const miss = await ch.handle({ type: 'schedule_cancel', id: 'nope' });
  assert.equal(miss.success, false);
  dispose();
});

test('model_ping probes {baseUrl}/models with resolved auth, never leaks the key', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-ping-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const seen = { url: null, auth: null };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen.url = String(url); seen.auth = opts?.headers?.Authorization ?? null;
    return { ok: true, status: 200 };
  };
  fakeSessionRef.modelRuntime = {
    getProviders: () => [{ id: 'cpa', name: 'CPA', baseUrl: 'https://api.test/v1' }],
    getProvider: (id) => (id === 'cpa' ? { id: 'cpa', baseUrl: 'https://api.test/v1', headers: {} } : undefined),
    hasConfiguredAuth: () => true,
    getAuth: async () => ({ auth: { apiKey: 'sk-secret' }, source: 'stored key' }),
    getAvailable: async () => [],
  };
  const core = { paths: { auditDir }, audit: { write: () => {} } };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core });
  try {
    const r = await ch.handle({ type: 'model_ping', provider: 'cpa' });
    assert.equal(r.success, true);
    assert.equal(r.data.ok, true);
    assert.equal(seen.url, 'https://api.test/v1/models');
    assert.equal(seen.auth, 'Bearer sk-secret');
    assert.ok(!JSON.stringify(r.data).includes('sk-secret')); // key never returned
    const bad = await ch.handle({ type: 'model_ping', provider: 'nope' });
    assert.equal(bad.data.ok, false);
    assert.match(bad.data.error, /unknown provider/);
  } finally {
    globalThis.fetch = origFetch;
    dispose();
  }
});

test('capability-gated attachments: text-only model degrades images with operator notice', async () => {
  const calls = [];
  fakeSessionRef = fakeSession(); listeners.clear();
  fakeSessionRef.model = { provider: 'cpa', id: 'text-only-1', input: ['text'] };
  fakeSessionRef.prompt = async (m, o) => calls.push([m, o]);
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-caps-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const core = { paths: { auditDir }, audit: { write: () => {} } };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core });
  const events = [];
  ch.subscribe((m) => events.push(m));

  await ch.handle({
    type: 'prompt', message: 'see this',
    options: { attachments: [{ name: 'p.png', mime: 'image/png', data: 'aGk=' }] },
  });
  const [msg, opts] = calls[0];
  assert.ok(!opts.images?.length, 'no native images for a text-only model');
  assert.match(msg, /<attachment kind="image" name="p.png"/);
  assert.ok(events.some((m) => m.event?.type === 'notify' && /不支持图片输入/.test(m.event.message ?? '')),
    'operator is told the image degraded');

  // vision-capable model still rides natively
  fakeSessionRef.model = { provider: 'cpa', id: 'vision-1', input: ['text', 'image'] };
  await ch.handle({
    type: 'prompt', message: 'again',
    options: { attachments: [{ name: 'q.png', mime: 'image/png', data: 'aGk=' }] },
  });
  assert.deepEqual(calls[1][1].images, [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }]);
  dispose();
});

// dedup-h #181: media auto-fallback — images on a text-only model walk the
// operator's fallback chain for a vision-capable entry before degrading.
test('media fallback: image prompt switches to a vision-capable chain entry', async () => {
  const calls = [];
  const auditEvents = [];
  fakeSessionRef = fakeSession(); listeners.clear();
  fakeSessionRef.model = { provider: 'cpa', id: 'text-only-1', input: ['text'] };
  fakeSessionRef.prompt = async (m, o) => calls.push([m, o]);
  const vision = { provider: 'other', id: 'vision-9', input: ['text', 'image'] };
  fakeSessionRef.modelRuntime = { getModel: (p, id) => (p === 'other' && id === 'vision-9' ? vision : null) };
  fakeSessionRef.setModel = async (m) => { fakeSessionRef.model = m; };
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-mediafb-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const core = { paths: { auditDir }, audit: { write: (e) => auditEvents.push(e) } };
  const { channel: ch, dispose } = createChannelHost({
    session: fakeSessionRef, core,
    fallbacks: { chain: [{ provider: 'other', model: 'vision-9' }] },
  });
  const events = [];
  ch.subscribe((m) => events.push(m));

  await ch.handle({
    type: 'prompt', message: 'see this',
    options: { attachments: [{ name: 'p.png', mime: 'image/png', data: 'aGk=' }] },
  });
  assert.equal(fakeSessionRef.model.id, 'vision-9', 'session model switched to the vision entry');
  assert.deepEqual(calls[0][1].images, [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }],
    'image rides natively after the media fallback');
  assert.ok(auditEvents.some((e) => e.kind === 'MEDIA_FALLBACK' && e.data.to === 'other/vision-9'),
    'fallback audited');
  assert.ok(events.some((m) => m.event?.type === 'notify' && /视觉模型/.test(m.event.message ?? '')),
    'operator told about the switch');

  // no vision entry in the chain → the honest degrade path, unchanged
  fakeSessionRef.model = { provider: 'cpa', id: 'text-only-1', input: ['text'] };
  const { channel: ch2, dispose: dispose2 } = createChannelHost({
    session: fakeSessionRef, core,
    fallbacks: { chain: [{ provider: 'other', model: 'text-2' }] },
  });
  await ch2.handle({
    type: 'prompt', message: 'again',
    options: { attachments: [{ name: 'q.png', mime: 'image/png', data: 'aGk=' }] },
  });
  assert.equal(fakeSessionRef.model.id, 'text-only-1', 'no switch when chain has no vision model');
  assert.ok(!calls[1][1].images?.length, 'image degrades to a descriptor');
  dispose(); dispose2();
});

test('skills_list and skill_allow_set dispatch to the knowledge facade; fail closed without it', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-skills-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const core = { paths: { auditDir } };
  const calls = [];
  const { channel: ch, dispose } = createChannelHost({
    session: fakeSessionRef, core,
    knowledge: {
      stats: () => [{ name: 'deploy', triggers: ['deploy'], bytes: 40, hits: 2, allowed: true }],
      allowSet: (names) => { calls.push(names); return { allow: names }; },
    },
  });
  const list = await ch.handle({ type: 'skills_list' });
  assert.equal(list.success, true);
  assert.equal(list.data.skills[0].name, 'deploy');
  const set = await ch.handle({ type: 'skill_allow_set', names: ['a', 'b'] });
  assert.equal(set.success, true);
  assert.deepEqual(calls[0], ['a', 'b']);
  const clear = await ch.handle({ type: 'skill_allow_set', names: null });
  assert.equal(clear.success, true);
  assert.deepEqual(calls[1], null);
  dispose();

  const bare = createChannelHost({ session: fakeSession(), core });
  const r = await bare.channel.handle({ type: 'skills_list' });
  assert.equal(r.success, false);
  assert.match(r.error, /skills facade unavailable/);
  bare.dispose();
});

test('governance_dryrun: real kernel probe through the channel — verdicts without side effects', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-dryrun-'));
  const auditDir = join(dir, 'audit');
  const canonicalDir = join(dir, 'canonical');
  mkdirSync(auditDir, { recursive: true });
  mkdirSync(canonicalDir, { recursive: true });
  writeFileSync(join(canonicalDir, 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: { write: { action: 'ask' } },
    riskActions: { destructive: 'deny' },
  }));
  const { AuditWriter } = await import('../../host/src/core/audit.js');
  const { AttestedPolicy } = await import('../../host/src/core/policy.js');
  const { PredictionStore } = await import('../../host/src/core/prediction.js');
  const { GovernanceKernel } = await import('../../host/src/core/governance.js');
  const audit = new AuditWriter({ auditDir });
  const kernel = new GovernanceKernel({
    audit, policy: new AttestedPolicy(canonicalDir),
    predictions: new PredictionStore(canonicalDir),
    protectedRoots: [auditDir],
    ask: async () => { throw new Error('probe must never reach the operator'); },
  });
  const core = { paths: { auditDir }, audit, kernel };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core });

  const denied = await ch.handle({ type: 'governance_dryrun', tool: 'bash', args: {} });
  // bash with no commandArg configured and no rules → allow
  assert.equal(denied.data.action, 'allow');

  const ask = await ch.handle({ type: 'governance_dryrun', tool: 'write', args: { path: 'a.txt' } });
  assert.equal(ask.data.action, 'ask');
  assert.equal(ask.data.rule, 'tool_ask');

  const blocked = await ch.handle({ type: 'governance_dryrun', tool: 'write', args: { path: join(auditDir, 'x.jsonl') } });
  // protected-root scan: instance internals are negative capabilities
  assert.equal(blocked.data.action, 'deny');
  assert.equal(blocked.data.rule, 'negative_capability');

  // probe purity: the audit dir must hold zero events after three verdicts
  const { readdirSync } = await import('node:fs');
  const files = readdirSync(auditDir).filter((f) => f.endsWith('.jsonl'));
  const lines = files.flatMap((f) => readFileSync(join(auditDir, f), 'utf-8').split('\n').filter(Boolean));
  assert.equal(lines.length, 0, 'dry-runs wrote no audit events');
  dispose();
});

test('busy-session prompt queues as followUp instead of throwing (SDK contract)', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-q-'));
  const core = { paths: { auditDir: join(dir, 'audit') } };
  mkdirSync(core.paths.auditDir, { recursive: true });
  const seen = [];
  fakeSessionRef.prompt = async (m, o) => {
    seen.push([m, o]);
    // the real SDK throws when streaming without streamingBehavior
    if (fakeSessionRef.isStreaming && !o?.streamingBehavior) throw new Error('streaming and no streamingBehavior specified');
  };
  const fired = [];
  const hooks = { fire: (name, payload) => { fired.push([name, payload]); return 0; } };
  const { channel: ch } = createChannelHost({ session: fakeSessionRef, core, hooks });

  const idle = await ch.handle({ type: 'prompt', message: 'first' });
  assert.equal(idle.success, true);
  assert.equal(seen.at(-1)[1]?.streamingBehavior, undefined, 'idle prompt carries no queueing override');

  fakeSessionRef.isStreaming = true;
  const busy = await ch.handle({ type: 'prompt', message: 'while you work' });
  assert.equal(busy.success, true, 'busy prompt is queued, not bounced');
  assert.equal(seen.at(-1)[1].streamingBehavior, 'followUp');
  // dedup-h #280: the queued prompt fires the observational hook; the idle
  // prompt did not queue → no event for it.
  assert.deepEqual(fired.filter(([n]) => n === 'prompt_queued').length, 1);
  assert.equal(fired.find(([n]) => n === 'prompt_queued')?.[1]?.preview, 'while you work');
});

test('budget status flags a dollar cap that cannot see an unpriced model', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-b-'));
  const core = { paths: { auditDir: join(dir, 'audit'), root: dir } };
  mkdirSync(core.paths.auditDir, { recursive: true });
  const { BudgetGovernor } = await import('../../host/src/core/budget.js');
  const budget = new BudgetGovernor({
    ledgerPath: join(dir, 'budget-ledger.jsonl'),
    limits: { maxCostPerSessionUsd: 5 },
  });
  // custom-provider posture: model carries zero pricing
  fakeSessionRef.model = { provider: 'cpa', id: 'local-x', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const { channel: ch } = createChannelHost({ session: fakeSessionRef, core, budget });
  const st = await ch.handle({ type: 'budget_status' });
  assert.equal(st.success, true);
  assert.equal(st.data.costMetered, false);
  assert.match(st.data.warning, /成本上限对这部分流量不可见/, 'dead dollar cap is surfaced, not silent');

  // priced model → cap is real, no warning
  fakeSessionRef.model = { provider: 'openai', id: 'gpt-5', cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 } };
  const st2 = await ch.handle({ type: 'budget_status' });
  assert.equal(st2.data.costMetered, true);
  assert.equal(st2.data.warning, undefined);

  // unpriced model but no dollar cap configured → nothing to warn about
  const budget2 = new BudgetGovernor({ ledgerPath: join(dir, 'l2.jsonl'), limits: { maxTokensPerSession: 1000 } });
  const { channel: ch2 } = createChannelHost({ session: fakeSessionRef, core, budget: budget2 });
  fakeSessionRef.model = { provider: 'cpa', id: 'local-x', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const st3 = await ch2.handle({ type: 'budget_status' });
  assert.equal(st3.data.warning, undefined);
});

test('M106 context_map: composition segments + authoritative usage', async () => {
  fakeSessionRef = {
    ...fakeSession(),
    sessionId: 's-ctx',
    messages: [
      { role: 'user', content: 'hello there' },
      { role: 'assistant', content: [{ type: 'text', text: 'answer text' }, { type: 'toolCall', name: 'bash' }] },
      { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'x'.repeat(400) }] },
    ],
    getContextUsage: () => ({ tokens: 1234, contextWindow: 200000 }),
  };
  listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-'));
  const auditDir = join(dir, 'audit'); mkdirSync(auditDir, { recursive: true });
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core: { paths: { auditDir } } });
  const r = await ch.handle({ type: 'context_map' });
  assert.equal(r.success, true);
  assert.equal(r.data.usage.tokens, 1234);
  assert.ok(r.data.messages >= 3);
  const segKeys = r.data.segments.map((s) => s.segment);
  assert.ok(segKeys.some((k) => k.startsWith('toolResult/')));
  assert.ok(r.data.estTokens > 0);
  dispose();
});

test('M101 session_detach: reports detached + streaming state, audits', async () => {
  fakeSessionRef = { ...fakeSession(), sessionId: 's-det', isStreaming: true };
  listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-'));
  const auditDir = join(dir, 'audit'); mkdirSync(auditDir, { recursive: true });
  const auditEvents = [];
  const core = { paths: { auditDir }, audit: { write: (e) => auditEvents.push(e) } };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core });
  const r = await ch.handle({ type: 'session_detach' });
  assert.equal(r.success, true);
  assert.equal(r.data.detached, true);
  assert.equal(r.data.streaming, true);
  assert.ok(auditEvents.some((e) => e.kind === 'SESSION_DETACHED' && e.data.sessionId === 's-det'));
  dispose();
});

test('M108 session_share: secrets + workdir path masked in artifact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-share-'));
  const sessDir = join(dir, 'sessions'); mkdirSync(sessDir, { recursive: true });
  const sessFile = join(sessDir, 's.jsonl');
  writeFileSync(sessFile, [
    // fake key built at runtime — the literal must not trip the repo's
    // privacy scan while still matching the scrubber's key pattern
    JSON.stringify({ role: 'user', content: `my key is sk-${'a'.repeat(26)}` }),
    JSON.stringify({ role: 'assistant', content: `see ${dir.split('\\').join('/')}/src/x.js` }),
  ].join('\n'));
  fakeSessionRef = { ...fakeSession(), sessionId: 's-share', sessionFile: sessFile };
  listeners.clear();
  const auditDir = join(dir, 'audit'); mkdirSync(auditDir, { recursive: true });
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core: { paths: { auditDir } }, workdir: dir });
  const r = await ch.handle({ type: 'session_share' });
  assert.equal(r.success, true);
  const out = readFileSync(r.data.file, 'utf-8');
  assert.ok(!out.includes('sk-abcdefghij'), 'secret redacted');
  assert.ok(out.includes('[REDACTED:openai_key]'));
  assert.ok(!out.includes(dir.split('\\').join('/')), 'workdir masked');
  assert.ok(out.includes('[WORKDIR]'));
  assert.ok(out.includes('share_header'));
  dispose();
});

test('M139: path-source image materializes bytes AND advertises its path', async () => {
  const calls = [];
  fakeSessionRef = fakeSession(); listeners.clear();
  fakeSessionRef.prompt = async (m, o) => calls.push([m, o]);
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-attpath-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const core = { paths: { auditDir, root: dir }, audit: { write() {} } };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core });

  // a real PNG on disk — path source must materialize bytes, not data:undefined
  const { bmpToPng } = await import('../../host/src/core/attachments.js');
  const bmp = Buffer.alloc(54 + 4 * 4 * 4); // 4x4 24-bit BMP
  bmp[0] = 0x42; bmp[1] = 0x4d;
  bmp.writeUInt32LE(54 + 64, 2); bmp.writeUInt32LE(54, 10);
  bmp.writeInt32LE(4, 18); bmp.writeInt32LE(4, 22);
  bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp.writeUInt32LE(0, 30);
  const png = bmpToPng(bmp);
  assert.ok(png, 'fixture encoder works');
  const imgPath = join(dir, 'shot.png');
  writeFileSync(imgPath, png);

  await ch.handle({
    type: 'prompt', message: 'see',
    options: { attachments: [{ name: 'shot.png', mime: 'image/png', path: imgPath }] },
  });
  const [msg, opts] = calls[0];
  assert.equal(opts.images.length, 1);
  assert.ok(opts.images[0].data, 'path source must carry real bytes');
  assert.equal(opts.images[0].mimeType, 'image/png');
  assert.ok(msg.includes(`path="${imgPath}"`), 'path attr advertises the on-disk file');
  dispose();
});

test('M139: pasted image spills to exports/attachments and advertises the path', async () => {
  const calls = [];
  fakeSessionRef = fakeSession(); listeners.clear();
  fakeSessionRef.prompt = async (m, o) => calls.push([m, o]);
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-attspill-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const core = { paths: { auditDir, root: dir }, audit: { write() {} } };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core });

  const { bmpToPng } = await import('../../host/src/core/attachments.js');
  const bmp = Buffer.alloc(54 + 16); bmp[0] = 0x42; bmp[1] = 0x4d;
  bmp.writeUInt32LE(70, 2); bmp.writeUInt32LE(54, 10);
  bmp.writeInt32LE(2, 18); bmp.writeInt32LE(2, 22);
  bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
  const png64 = bmpToPng(bmp).toString('base64');

  await ch.handle({
    type: 'prompt', message: 'pasted',
    options: { attachments: [{ name: 'clip.png', mime: 'image/png', data: png64 }] },
  });
  const [msg] = calls[0];
  const m = /path="([^"]+)"/.exec(msg);
  assert.ok(m, 'inline image must advertise a persisted path');
  assert.ok(existsSync(m[1]), `persisted file must exist: ${m[1]}`);
  dispose();
});

test('M137 image_detail: low tier halves a PNG; high tier untouched; non-PNG honest skip', async () => {
  const { bmpToPng, pngDownscale } = await import('../../host/src/core/attachments.js');
  // 64x64 PNG fixture via the existing BMP encoder
  const w = 64, h = 64, stride = Math.ceil(w * 3 / 4) * 4;
  const bmp = Buffer.alloc(54 + stride * h);
  bmp[0] = 0x42; bmp[1] = 0x4d;
  bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10);
  bmp.writeInt32LE(w, 18); bmp.writeInt32LE(h, 22);
  bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
  const png = bmpToPng(bmp);
  const halved = pngDownscale(png, 32);
  assert.ok(halved);
  assert.equal(halved.readUInt32BE(16), 32, 'IHDR width halved');
  assert.equal(halved.readUInt32BE(20), 32, 'IHDR height halved');
  assert.equal(pngDownscale(png, 1024), null, 'already-fits is a no-op');
  assert.equal(pngDownscale(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0]), 32), null, 'jpeg honestly skipped');

  const calls = [];
  fakeSessionRef = fakeSession(); listeners.clear();
  fakeSessionRef.prompt = async (m, o) => calls.push([m, o]);
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-tier-'));
  const auditDir = join(dir, 'audit'); mkdirSync(auditDir, { recursive: true });
  const audits = [];
  const core = { paths: { auditDir, root: dir }, audit: { write(e) { audits.push(e); } } };
  const imageDetail = { current: 'low' };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core, imageDetail });
  await ch.handle({
    type: 'prompt', message: 'x',
    options: { attachments: [{ name: 'big.png', mime: 'image/png', data: png.toString('base64') }] },
  });
  // 64px under 'low' (512 cap) already fits — bytes ride untouched
  const sent = Buffer.from(calls[0][1].images[0].data, 'base64');
  assert.equal(sent.readUInt32BE(16), 64);
  imageDetail.current = 'high';
  // config surface exposes the tier
  const cfg = await ch.handle({ type: 'config_set', key: 'image_detail', value: 'low' });
  assert.equal(cfg.success, true);
  assert.equal(imageDetail.current, 'low');
  dispose();
});

// candidates-open dedup-h #19: tasks category purge — closed task dirs are
// history and purgeable; an open mailbox is a live channel and survives.
test('instance_purge tasks: closed dirs deleted, open mailbox protected', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-purge-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const core = { paths: { auditDir, root: dir } };
  const { TaskStore } = await import('../../host/src/core/tasks.js');
  const store = new TaskStore(dir);
  const open = store.create({ label: 'live child' });
  const closed = store.create({ label: 'done child' });
  const torn = store.create({ label: 'torn' });
  store.postInbox(open.task_id, { body: 'x' });
  store.postInbox(closed.task_id, { body: 'x' });
  store.setState(closed.task_id, 'closed');
  // torn meta — a task.json that fails to parse must be KEPT (safer side)
  writeFileSync(join(dir, 'tasks', torn.task_id, 'task.json'), '{torn');
  store.postInbox(torn.task_id, { body: 'x' });

  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core });
  const dry = await ch.handle({ type: 'instance_purge', category: 'tasks' });
  assert.equal(dry.success, true);
  assert.equal(dry.data.dry_run, true);
  const dryPaths = dry.data.paths.join('\n');
  assert.ok(dryPaths.includes(closed.task_id), 'closed task dir in the preview');
  assert.ok(!dryPaths.includes(open.task_id), 'open task dir absent from preview');
  assert.ok(!dryPaths.includes(torn.task_id), 'torn meta kept out of the delete set');

  const real = await ch.handle({ type: 'instance_purge', category: 'tasks', dry_run: false });
  assert.equal(real.success, true);
  assert.ok(!existsSync(join(dir, 'tasks', closed.task_id, 'task.json')), 'closed task deleted');
  assert.ok(existsSync(join(dir, 'tasks', open.task_id, 'task.json')), 'open task survives');
  assert.ok(existsSync(join(dir, 'tasks', torn.task_id, 'task.json')), 'torn task survives');
  // non-purgeable evidence classes still refuse
  const bad = await ch.handle({ type: 'instance_purge', category: 'audit', dry_run: false });
  assert.equal(bad.success, false);
  dispose();
});

// dedup-h #282: models-allow.json bounds the automatic failover surface.
test('models allowlist: media fallback picks only allowed entries; malformed file fails closed', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  fakeSessionRef.model = { provider: 'cpa', id: 'text-only-1', input: ['text'] };
  const calls = [];
  fakeSessionRef.prompt = async (m, o) => calls.push([m, o]);
  const visionBad = { provider: 'evil', id: 'vision-x', input: ['text', 'image'] };
  const visionOk = { provider: 'other', id: 'vision-9', input: ['text', 'image'] };
  fakeSessionRef.modelRuntime = { getModel: (p, id) => ({ evil: visionBad, other: visionOk }[p] ?? null) };
  fakeSessionRef.setModel = async (m) => { fakeSessionRef.model = m; };
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-allow-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  const core = { paths: { auditDir: join(dir, 'audit'), root: dir }, audit: { write: () => {} } };
  const { modelsAllowPredicate } = await import('../src/adapter/modelallow.js');

  // allowlist admits only 'other/*' — 'evil/vision-x' skipped, walk continues
  writeFileSync(join(dir, 'models-allow.json'), JSON.stringify({ allow: [{ provider: 'other', model: '*' }] }));
  const fallbacks = {
    chain: [{ provider: 'evil', model: 'vision-x' }, { provider: 'other', model: 'vision-9' }],
    allowed: modelsAllowPredicate(dir),
  };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core, fallbacks });
  await ch.handle({ type: 'prompt', message: 'see', options: { attachments: [{ name: 'p.png', mime: 'image/png', data: 'aGk=' }] } });
  assert.equal(fakeSessionRef.model.id, 'vision-9', 'allowlisted vision entry selected over the earlier denied one');
  dispose();

  // malformed allowlist → fail closed: even the good entry is refused
  fakeSessionRef.model = { provider: 'cpa', id: 'text-only-1', input: ['text'] };
  writeFileSync(join(dir, 'models-allow.json'), '{oops');
  const { channel: ch2, dispose: d2 } = createChannelHost({ session: fakeSessionRef, core, fallbacks });
  await ch2.handle({ type: 'prompt', message: 'see', options: { attachments: [{ name: 'q.png', mime: 'image/png', data: 'aGk=' }] } });
  assert.equal(fakeSessionRef.model.id, 'text-only-1', 'malformed allowlist denies the whole failover surface');
  d2();

  // absent file → unrestricted
  const { rmSync } = await import('node:fs');
  rmSync(join(dir, 'models-allow.json'));
  const pred = modelsAllowPredicate(dir);
  assert.equal(pred({ provider: 'anything', model: 'm' }), true, 'absent file is unrestricted');
});

test('dedup-h #535: compact_start/compact_end hooks carry reason context', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-'));
  const fired = [];
  const hooks = { fire: (ev, payload) => { fired.push({ ev, payload }); return Promise.resolve(1); } };
  const { dispose } = createChannelHost({ session: fakeSessionRef, core: { paths: { auditDir: join(dir, 'audit') } }, hooks });
  for (const l of listeners) {
    l({ type: 'compaction_start', runId: 'r1', reason: 'threshold', startedAt: 1 });
    l({ type: 'compaction_end', runId: 'r1', reason: 'threshold', endedAt: 2, status: 'completed', entryId: 'e1' });
    l({ type: 'compaction_start', runId: 'r2', reason: 'overflow', startedAt: 3 });
    l({ type: 'compaction_end', runId: 'r2', reason: 'overflow', endedAt: 4, status: 'failed', error: { message: 'summarizer died' } });
  }
  await new Promise((r) => setTimeout(r, 30));
  const start = fired.find((f) => f.ev === 'compact_start' && f.payload.runId === 'r1');
  const end = fired.find((f) => f.ev === 'compact_end' && f.payload.runId === 'r1');
  const fail = fired.find((f) => f.ev === 'compact_end' && f.payload.runId === 'r2');
  assert.equal(start?.payload.reason, 'threshold');
  assert.equal(end?.payload.status, 'completed');
  assert.equal(fail?.payload.reason, 'overflow');
  assert.equal(fail?.payload.status, 'failed');
  assert.match(fail?.payload.error, /summarizer died/);
  dispose();
});

test('dedup-h #935: prompt_submit gate intercepts/transforms/denies; broken gate fails closed', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-gate-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const { AuditWriter } = await import('../../host/src/core/audit.js');
  const audit = new AuditWriter({ auditDir });
  const core = { paths: { auditDir }, audit };

  // transform: gate rewrites the prompt text
  const gate = { fireValue: async (ev, p) => ev === 'prompt_submit' ? { text: 'REWRITTEN' } : null };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core, preToolGate: gate });
  await ch.handle({ type: 'prompt', message: 'original' });
  assert.equal(fakeSessionRef.calls.at(-1), 'REWRITTEN');
  // context: prepended, original preserved
  gate.fireValue = async () => ({ context: 'CTX' });
  await ch.handle({ type: 'prompt', message: 'keep me' });
  assert.equal(fakeSessionRef.calls.at(-1), 'CTX\n\nkeep me');
  // deny: refuses before the session sees it
  gate.fireValue = async () => ({ deny: 'blocked input' });
  const r = await ch.handle({ type: 'prompt', message: 'nope' });
  assert.equal(r.success, false);
  assert.match(String(r.error), /denied: blocked input/);
  assert.equal(fakeSessionRef.calls.at(-1), 'CTX\n\nkeep me', 'denied prompt must not reach the session');
  // broken gate fails closed
  gate.fireValue = async () => { throw new Error('hook exploded'); };
  const r2 = await ch.handle({ type: 'prompt', message: 'x' });
  assert.equal(r2.success, false);
  assert.match(String(r2.error), /failed closed/);
  dispose();
});

test('dedup-h #1034: agent_stop gate block continues the agent; capped; continueOnBlock:false honors the stop', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-stopgate-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const { AuditWriter } = await import('../../host/src/core/audit.js');
  const audit = new AuditWriter({ auditDir });
  const core = { paths: { auditDir }, audit };

  const gate = { fireValue: async (ev) => (ev === 'agent_stop' ? { block: 'tests still failing' } : null) };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core, preToolGate: gate });
  const emitEnd = () => { for (const l of listeners) l({ type: 'agent_end' }); };
  const settle = async () => { await new Promise((r) => setTimeout(r, 80)); };

  await ch.handle({ type: 'prompt', message: 'work' });
  emitEnd();
  await settle();
  assert.equal(fakeSessionRef.calls.length, 2, 'block answer must re-prompt the agent');
  assert.match(fakeSessionRef.calls[1], /tests still failing/);

  // consecutive cap = 3 continuations; further blocks are audited, not run
  emitEnd(); emitEnd(); emitEnd(); emitEnd();
  await settle();
  assert.equal(fakeSessionRef.calls.length, 4, 'three continuations max per turn chain');
  const tail = await ch.handle({ type: 'audit_tail', n: 30 });
  const kinds = tail.data.events.map((e) => e.kind);
  assert.ok(kinds.includes('AGENT_STOP_CONTINUED'));
  assert.ok(kinds.includes('AGENT_STOP_CONTINUE_CAP'));

  // a fresh operator prompt re-arms the continuation budget
  await ch.handle({ type: 'prompt', message: 'again' });
  emitEnd();
  await settle();
  assert.equal(fakeSessionRef.calls.length, 6, 'non-continuation prompt resets the cap');
  dispose();
});

test('dedup-h #1034: continueOnBlock:false and a broken gate both let the turn end', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-stopoff-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const { AuditWriter } = await import('../../host/src/core/audit.js');
  const audit = new AuditWriter({ auditDir });
  const core = { paths: { auditDir }, audit };

  // entry flag disables continuation even though the answer blocks
  const gate = { fireValue: async (ev) => (ev === 'agent_stop'
    ? { block: 'nope', hookEntry: { continueOnBlock: false } }
    : null) };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core, preToolGate: gate });
  const emitEnd = () => { for (const l of listeners) l({ type: 'agent_end' }); };
  await ch.handle({ type: 'prompt', message: 'work' });
  emitEnd();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(fakeSessionRef.calls.length, 1, 'continueOnBlock:false must not re-prompt');

  // a throwing gate fails OPEN for stops — never manufactures work
  gate.fireValue = async () => { throw new Error('gate exploded'); };
  emitEnd();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(fakeSessionRef.calls.length, 1);
  const tail = await ch.handle({ type: 'audit_tail', n: 20 });
  assert.ok(tail.data.events.some((e) => e.kind === 'AGENT_STOP_GATE_FAILED'));
  dispose();
});

test('dedup-h #1188: message_sent hook fires on assistant message with enriched payload', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-msgsent-'));
  const fired = [];
  const hooks = { fire: (ev, payload) => { fired.push({ ev, payload }); return Promise.resolve(1); } };
  const { dispose } = createChannelHost({ session: fakeSessionRef, core: { paths: { auditDir: join(dir, 'audit') } }, hooks });
  for (const l of [...listeners]) l({
    type: 'message_end',
    message: {
      role: 'assistant', model: 'gpt-5.6-luna-max',
      content: [{ type: 'text', text: 'reply body here' }],
      usage: { input: 10, output: 5 },
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  const hit = fired.find((f) => f.ev === 'message_sent');
  assert.ok(hit, 'message_sent fired on assistant message_end');
  assert.equal(hit.payload.text, 'reply body here');
  assert.equal(hit.payload.chars, 15);
  assert.equal(hit.payload.model, 'gpt-5.6-luna-max');
  assert.equal(hit.payload.usage.input, 10);
  // a user/tool message does not fire the outbound hook
  fired.length = 0;
  for (const l of [...listeners]) l({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
  for (const l of [...listeners]) l({ type: 'message_end', message: { role: 'assistant' } }); // no usage → no fire
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!fired.some((f) => f.ev === 'message_sent'), 'non-assistant / usage-less messages do not fire');
  dispose();
});

// ── dedup-h #1406: auth_set_key secret refs route through the broker ─────────
// op://bw:// resolution must honor secrets.json opt-in + allowlist + audit —
// the previous inline execFileSync bypassed all three.

test('#1406 auth_set_key: op:// ref resolves through secretsource broker (opt-in + spawn args + audit)', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-secret-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify({
    sources: { op: { bin: 'op' } },
  }));
  const { AuditWriter } = await import('../../host/src/core/audit.js');
  const audit = new AuditWriter({ auditDir });
  const stored = [];
  fakeSessionRef.modelRuntime = {
    setRuntimeApiKey: async (p, k) => stored.push([p, k]),
    removeRuntimeApiKey: async () => {},
  };
  const spawned = [];
  const spawnFn = (bin, args) => { spawned.push([bin, ...args]); return 's3cr3t-value'; };
  const core = { paths: { auditDir, root: dir }, audit };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core, secretSpawnFn: spawnFn });

  const r = await ch.handle({ type: 'auth_set_key', provider: 'x', key: 'op://vault/item/field' });
  assert.equal(r.success, true);
  assert.equal(r.data.hasAuth, true);
  assert.deepEqual(stored, [['x', 's3cr3t-value']], 'resolved secret stored, not the ref');
  assert.deepEqual(spawned, [['op', 'read', 'op://vault/item/field']], 'broker invoked with read args');
  dispose();
  const rows = readFileSync(join(auditDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf-8')
    .trim().split('\n').map((l) => JSON.parse(l));
  const row = rows.find((e) => e.kind === 'SECRET_SOURCE_RESOLVE');
  assert.ok(row, 'resolution audited');
  assert.equal(row.data.ok, true);
  assert.equal(row.data.scheme, 'op');
  assert.ok(!JSON.stringify(row).includes('s3cr3t'), 'audit never carries the secret');
});

test('#1406 auth_set_key: op:// ref WITHOUT secrets.json enablement fails closed', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-secret2-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const { AuditWriter } = await import('../../host/src/core/audit.js');
  const audit = new AuditWriter({ auditDir });
  let stored = false;
  fakeSessionRef.modelRuntime = { setRuntimeApiKey: async () => { stored = true; }, removeRuntimeApiKey: async () => {} };
  const core = { paths: { auditDir, root: dir }, audit };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core });

  const r = await ch.handle({ type: 'auth_set_key', provider: 'x', key: 'op://vault/item/field' });
  assert.equal(r.success, true);
  assert.equal(r.data.hasAuth, false);
  assert.match(r.data.error, /not enabled/);
  assert.equal(stored, false, 'refused ref never reaches the credential store');
  dispose();
});

test('#1406 auth_set_key: item outside the secrets.json allowlist refused; malformed ref refused', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-secret3-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify({
    sources: { op: { bin: 'op', items: ['prod/'] } },
  }));
  let stored = false;
  fakeSessionRef.modelRuntime = { setRuntimeApiKey: async () => { stored = true; }, removeRuntimeApiKey: async () => {} };
  const core = { paths: { auditDir, root: dir } };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core });

  const off = await ch.handle({ type: 'auth_set_key', provider: 'x', key: 'op://dev/item/field' });
  assert.equal(off.data.hasAuth, false);
  assert.match(off.data.error, /allowlist/);
  const mal = await ch.handle({ type: 'auth_set_key', provider: 'x', key: 'op://onlyvault' });
  assert.equal(mal.data.hasAuth, false);
  assert.match(mal.data.error, /malformed secret reference/);
  assert.equal(stored, false);
  dispose();
});

// dedup-h #1867: unreadable vision codecs degrade at attach time instead of
// dying inside the provider request — bytes are ground truth, not the label.
test('vision-codec gate: heic/tiff degrade to descriptors; true codec wins', async () => {
  const calls = [];
  const auditEvents = [];
  fakeSessionRef = fakeSession(); listeners.clear();
  fakeSessionRef.model = { provider: 'cpa', id: 'vision-1', input: ['text', 'image'] };
  fakeSessionRef.prompt = async (m, o) => calls.push([m, o]);
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-codec-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const core = { paths: { auditDir }, audit: { write: (e) => auditEvents.push(e) } };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core });
  const events = [];
  ch.subscribe((m) => events.push(m));

  const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp'), Buffer.from('heic'), Buffer.alloc(16)]).toString('base64');
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 9, 9, 9, 9]).toString('base64');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString('base64');

  await ch.handle({
    type: 'prompt', message: 'look',
    options: { attachments: [
      { name: 'shot.heic', mime: 'image/heic', data: heic },
      { name: 'fake.png', mime: 'image/png', data: tiff },       // mislabeled: bytes are TIFF
      { name: 'ok.png', mime: 'image/png', data: png },
      { name: 'weird.heic', mime: 'image/heic', data: png },     // mislabeled the other way: bytes are PNG
    ] },
  });
  const [msg, opts] = calls[0];
  // heic + mislabeled tiff never reach the wire; the real png and the
  // heic-labeled-but-actually-png bytes ride under their TRUE codec
  assert.equal(opts.images.length, 2);
  assert.ok(opts.images.every((i) => i.mimeType === 'image/png'));
  assert.match(msg, /<attachment kind="image" name="shot.heic" mime="image\/heic" bytes="\d+"\/>/);
  assert.match(msg, /<attachment kind="image" name="fake.png" mime="image\/tiff" bytes="\d+"\/>/);
  assert.ok(events.some((m) => m.event?.type === 'notify' && /格式不可读/.test(m.event.message ?? '')),
    'operator is told images degraded on codec');
  assert.ok(auditEvents.some((e) => e.kind === 'ATTACHMENT_CODEC_DEGRADED' && e.data.count === 2));
  dispose();
});

// dedup-h #1922 — transform_llm_output gate: the operator-private hook
// reshapes the DELIVERED assistant text via a follow-up message_update.
// Session state + transcript keep the model's true output; deny/error
// withholds the text fail-closed (a broken filter never leaks).
test('dedup-h #1922: transform_llm_output rewrites delivered text; deny/error withholds fail-closed', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-tlo-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const { AuditWriter } = await import('../../host/src/core/audit.js');
  const audit = new AuditWriter({ auditDir });
  const core = { paths: { auditDir }, audit };

  const auditTail = (d) => readdirSync(d).filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => readFileSync(join(d, f), 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  const events = [];
  let answer = { text: 'GOVERNED OUTPUT' };
  const gate = { fireGate: async (ev, p) => ev === 'transform_llm_output' ? (typeof answer === 'function' ? answer(p) : answer) : null };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core, preToolGate: gate });
  ch.subscribe((m) => events.push(m));
  const settle = async () => { await new Promise((r) => setTimeout(r, 80)); };
  const emitAssistantEnd = () => {
    for (const l of [...listeners]) l({
      type: 'message_end',
      message: {
        role: 'assistant', model: 'stub',
        content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'raw model output' }],
        usage: { input: 10, output: 5 },
      },
    });
  };

  // 1. {text} → a follow-up message_update delivers the governed text; the
  //    thinking block survives; the original message object is untouched
  emitAssistantEnd();
  await settle();
  const upd = events.filter((m) => m.event?.type === 'message_update');
  assert.equal(upd.length, 1, `one transform update expected, got ${JSON.stringify(events.map((m) => m.event?.type))}`);
  const tblock = upd[0].event.message.content.find((c) => c.type === 'text');
  assert.equal(tblock.text, 'GOVERNED OUTPUT');
  assert.ok(upd[0].event.message.content.some((c) => c.type === 'thinking'), 'non-text blocks preserved');
  assert.ok(auditTail(auditDir).some((e) => e.kind === 'LLM_OUTPUT_TRANSFORMED'), 'transform audited');

  // 2. {deny} → delivered text withheld, never the raw output
  events.length = 0; answer = { deny: 'leaks a secret' };
  emitAssistantEnd();
  await settle();
  const upd2 = events.filter((m) => m.event?.type === 'message_update');
  assert.equal(upd2.length, 1);
  assert.match(upd2[0].event.message.content.find((c) => c.type === 'text').text, /withheld by transform gate: leaks a secret/);
  assert.ok(!JSON.stringify(upd2[0]).includes('raw model output'), 'withheld notice never carries the raw text');
  assert.ok(auditTail(auditDir).some((e) => e.kind === 'LLM_OUTPUT_WITHHELD'));

  // 3. gate throws → fail closed, withheld
  events.length = 0; answer = () => { throw new Error('hook exploded'); };
  emitAssistantEnd();
  await settle();
  const upd3 = events.filter((m) => m.event?.type === 'message_update');
  assert.equal(upd3.length, 1);
  assert.match(upd3[0].event.message.content.find((c) => c.type === 'text').text, /withheld.*failed closed/);
  dispose();
});

// dedup-h #2051: an EMPTY input declaration means "undeclared", not
// "accepts nothing" — both the carry gate and the media-fallback pick must
// treat input:[] like a missing list (upstream: two readers bypassed
// modelHasCapability and stripped image input on an empty list).
test('#2051 empty input list does not strip images; fallback pick shares the predicate', async () => {
  const calls = [];
  fakeSessionRef = fakeSession(); listeners.clear();
  fakeSessionRef.model = { provider: 'cpa', id: 'undeclared-1', input: [] };
  fakeSessionRef.prompt = async (m, o) => calls.push([m, o]);
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-emptycaps-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const core = { paths: { auditDir } };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core });
  const events = [];
  ch.subscribe((m) => events.push(m));

  await ch.handle({
    type: 'prompt', message: 'see this',
    options: { attachments: [{ name: 'p.png', mime: 'image/png', data: 'aGk=' }] },
  });
  assert.deepEqual(calls[0][1].images, [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }],
    'empty input list must NOT strip the native image carry');
  assert.ok(!events.some((m) => m.event?.type === 'notify' && /不支持图片输入/.test(m.event.message ?? '')),
    'no degrade notice for an undeclared model');
  dispose();

  // explicit text-only declaration still strips — the gate is not gone
  fakeSessionRef.model = { provider: 'cpa', id: 'text-only-9', input: ['text'] };
  const { channel: ch2, dispose: dispose2 } = createChannelHost({ session: fakeSessionRef, core });
  await ch2.handle({
    type: 'prompt', message: 'again',
    options: { attachments: [{ name: 'q.png', mime: 'image/png', data: 'aGk=' }] },
  });
  assert.ok(!calls[1][1].images?.length, 'explicit text-only still degrades');
  dispose2();

  // fallback pick shares the predicate: an empty-declaration chain entry
  // counts as vision-capable (same "undeclared = capable" contract as the
  // carry gate) instead of being skipped.
  fakeSessionRef.model = { provider: 'cpa', id: 'text-only-1', input: ['text'] };
  const undeclared = { provider: 'other', id: 'vision-0', input: [] };
  fakeSessionRef.modelRuntime = { getModel: (p, id) => (p === 'other' && id === 'vision-0' ? undeclared : null) };
  fakeSessionRef.setModel = async (m) => { fakeSessionRef.model = m; };
  const { channel: ch3, dispose: dispose3 } = createChannelHost({
    session: fakeSessionRef, core,
    fallbacks: { chain: [{ provider: 'other', model: 'vision-0' }] },
  });
  await ch3.handle({
    type: 'prompt', message: 'fallback',
    options: { attachments: [{ name: 'r.png', mime: 'image/png', data: 'aGk=' }] },
  });
  assert.equal(fakeSessionRef.model.id, 'vision-0', 'empty-declaration entry is a valid fallback pick');
  assert.deepEqual(calls[2][1].images, [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }]);
  dispose3();
});

// dedup-h #2101 — project kill switch (.zed/settings.json disable_ai):
// <workdir>/.pai/settings.json {disable_ai:true} refuses model turns,
// re-read per prompt so a live flip applies; exec/jobs untouched.
test('#2101 disable_ai refuses prompts live; removing the flag re-enables', async () => {
  const calls = [];
  fakeSessionRef = fakeSession(); listeners.clear();
  fakeSessionRef.prompt = async (m, o) => calls.push([m, o]);
  const dir = mkdtempSync(join(tmpdir(), 'pai-killproj-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  mkdirSync(join(dir, '.pai'), { recursive: true });
  const core = { paths: { auditDir }, audit: { write() {} } };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core, workdir: dir });

  // enabled by default → prompts run
  await ch.handle({ type: 'prompt', message: 'hello' });
  assert.equal(calls.length, 1);

  // flag on → refused with a named reason, no model call
  writeFileSync(join(dir, '.pai', 'settings.json'), JSON.stringify({ disable_ai: true }));
  const r = await ch.handle({ type: 'prompt', message: 'again' });
  assert.equal(r.success, false);
  assert.match(r.error, /disabled for this project/);
  assert.equal(calls.length, 1, 'disabled prompt never reaches the model');
  const r2 = await ch.handle({ type: 'steer', message: 'steer me' });
  assert.equal(r2.success, false, 'steer is a model turn — refused too');

  // live flip back → prompts run again (hot re-read, not a cached flag)
  writeFileSync(join(dir, '.pai', 'settings.json'), JSON.stringify({ disable_ai: false }));
  await ch.handle({ type: 'prompt', message: 'third' });
  assert.equal(calls.length, 2, 're-enabled project admits prompts');

  // malformed settings file = enabled (never bricks the prompt path)
  writeFileSync(join(dir, '.pai', 'settings.json'), 'not json{');
  await ch.handle({ type: 'prompt', message: 'fourth' });
  assert.equal(calls.length, 3, 'corrupt settings file does not disable');

  // non-AI surfaces unaffected by the flag at any point
  writeFileSync(join(dir, '.pai', 'settings.json'), JSON.stringify({ disable_ai: true }));
  const bare = await ch.handle({ type: 'get_state' });
  assert.equal(bare.success, true, 'get_state is not an AI turn');
  dispose();
});

// dedup-h #2118 — crush "Adaptive" default model: model-routes.json
// {adaptive:true} routes each prompt's text through the table and switches
// the session model per turn; explicit pick pins the session out.
test('#2118 adaptive routes per-turn by task text; explicit pick pins; alias un-pins', async () => {
  const calls = [];
  const switches = [];
  const sonnet = { provider: 'anthropic', id: 'claude-sonnet-5', name: 'sonnet' };
  const opus = { provider: 'anthropic', id: 'claude-opus-5', name: 'opus' };
  fakeSessionRef = fakeSession(); listeners.clear();
  fakeSessionRef.prompt = async (m, o) => calls.push([m, o]);
  fakeSessionRef.model = sonnet;
  fakeSessionRef.modelRuntime = {
    getModel: (p, id) => ([sonnet, opus].find((m) => m.provider === p && m.id === id) ?? null),
    getAvailable: async () => [sonnet, opus],
  };
  fakeSessionRef.setModel = async (m) => { switches.push(`${m.provider}/${m.id}`); fakeSessionRef.model = m; };
  const auditDir = mkdtempSync(join(tmpdir(), 'pai-adaptive-'));
  const core = { paths: { auditDir }, audit: { write() {} } };
  const modelRoutes = {
    adaptive: true,
    default: null,
    routes: [
      { name: 'deep-review', taskRe: /review|审查/i, model: 'anthropic/claude-opus-5', effort: null },
      { name: 'default-back', taskRe: /back/, model: 'anthropic/claude-sonnet-5', effort: null },
    ],
  };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core, workdir: auditDir, modelRoutes });

  // matching prompt → switches to the routed model before the model call
  await ch.handle({ type: 'prompt', message: 'review this diff' });
  assert.equal(calls.length, 1);
  assert.deepEqual(switches, ['anthropic/claude-opus-5'], 'route match switches model');
  assert.equal(fakeSessionRef.model.id, 'claude-opus-5');

  // next prompt matching a different rule → routes back
  await ch.handle({ type: 'prompt', message: 'back to normal' });
  assert.deepEqual(switches, ['anthropic/claude-opus-5', 'anthropic/claude-sonnet-5']);

  // explicit pick → pins the session out of adaptive routing
  await ch.handle({ type: 'model_set', provider: 'anthropic', model: 'claude-opus-5' });
  switches.length = 0;
  await ch.handle({ type: 'prompt', message: 'back to normal again' });
  assert.equal(calls.length, 3);
  assert.deepEqual(switches, [], 'pinned session is not re-routed');

  // 'adaptive' alias un-pins → routing resumes
  await ch.handle({ type: 'config_set', key: 'model', value: 'adaptive' });
  await ch.handle({ type: 'prompt', message: 'back once more' });
  assert.deepEqual(switches, ['anthropic/claude-sonnet-5'], 'adaptive alias re-arms routing');

  // unknown route target → prompt still runs, no switch
  const r = await ch.handle({ type: 'prompt', message: 'unmatched text' });
  assert.equal(r.success, true);
  assert.equal(calls.length, 5, 'unmatched prompt reaches the model untouched');
  dispose();
});

// dedup-h #2132 — write-target capture at tool_execution_start feeds the
// post-write delta lint at tool_execution_end (end events carry no args).
test('#2132 write tool start captures args; end lints the touched file', async () => {
  const linted = [];
  fakeSessionRef = fakeSession(); listeners.clear();
  const auditDir = mkdtempSync(join(tmpdir(), 'pai-lintwire-'));
  const core = { paths: { auditDir }, audit: { write() {} } };
  const verify = { afterWrite: async () => {}, lintPaths: async (paths) => { linted.push(paths); } };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core, verify, workdir: auditDir });

  for (const l of [...listeners]) l({ type: 'tool_execution_start', toolCallId: 'w1', toolName: 'write', args: { path: 'src/ok.json' } });
  for (const l of [...listeners]) l({ type: 'tool_execution_end', toolCallId: 'w1', toolName: 'write', isError: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(linted, [['src/ok.json']], 'end event must lint the path captured at start');

  // multi_edit carries edits[] — every edited path is linted
  for (const l of [...listeners]) l({ type: 'tool_execution_start', toolCallId: 'w2', toolName: 'multi_edit', args: { edits: [{ path: 'a.json' }, { path: 'b.py' }] } });
  for (const l of [...listeners]) l({ type: 'tool_execution_end', toolCallId: 'w2', toolName: 'multi_edit', isError: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(linted.at(-1), ['a.json', 'b.py']);

  // errored write → no lint (the file may not exist / partial state)
  for (const l of [...listeners]) l({ type: 'tool_execution_start', toolCallId: 'w3', toolName: 'write', args: { path: 'x.json' } });
  for (const l of [...listeners]) l({ type: 'tool_execution_end', toolCallId: 'w3', toolName: 'write', isError: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(linted.length, 2, 'errored write never lints');
  dispose();
});

// dedup-h #2164 — two-layer settings: <instance>/settings.json (global)
// under <workdir>/.pai/settings.json (project), project wins per key.
test('#2164 global+project settings merge: project overrides global live', async () => {
  const calls = [];
  fakeSessionRef = fakeSession(); listeners.clear();
  fakeSessionRef.prompt = async (m, o) => calls.push([m, o]);
  const dir = mkdtempSync(join(tmpdir(), 'pai-layers-'));
  const inst = mkdtempSync(join(tmpdir(), 'pai-layers-inst-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  mkdirSync(join(dir, '.pai'), { recursive: true });
  const core = { paths: { auditDir, root: inst }, audit: { write() {} } };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core, workdir: dir });

  // global layer alone can disable
  writeFileSync(join(inst, 'settings.json'), JSON.stringify({ disable_ai: true }));
  const r = await ch.handle({ type: 'prompt', message: 'a' });
  assert.equal(r.success, false, 'global disable_ai refuses');
  assert.equal(calls.length, 0);

  // project overrides global per key → re-enabled
  writeFileSync(join(dir, '.pai', 'settings.json'), JSON.stringify({ disable_ai: false }));
  await ch.handle({ type: 'prompt', message: 'b' });
  assert.equal(calls.length, 1, 'project disable_ai:false overrides global true');

  // project enables its own kill on top of a silent global
  writeFileSync(join(dir, '.pai', 'settings.json'), JSON.stringify({ disable_ai: true }));
  writeFileSync(join(inst, 'settings.json'), JSON.stringify({}));
  const r2 = await ch.handle({ type: 'prompt', message: 'c' });
  assert.equal(r2.success, false, 'project disable still fires under empty global');

  // malformed global degrades to {} — project layer still decides
  writeFileSync(join(inst, 'settings.json'), 'not json{');
  const r3 = await ch.handle({ type: 'prompt', message: 'd' });
  assert.equal(r3.success, false, 'malformed global cannot poison the merge');
  writeFileSync(join(dir, '.pai', 'settings.json'), 'also bad{');
  await ch.handle({ type: 'prompt', message: 'e' });
  assert.equal(calls.length, 2, 'both layers malformed → enabled');
  dispose();
});

test('#2194 pseudo tool call in assistant text → bounded remind via _continuation', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-tt-'));
  const auditDir = join(dir, 'audit'); mkdirSync(auditDir, { recursive: true });
  const audited = [];
  const core = { paths: { auditDir }, audit: { write: (e) => audited.push(e) } };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core });
  const emit = (ev) => { for (const l of [...listeners]) l(ev); };
  const flush = () => new Promise((r) => setTimeout(r, 60));
  const reminds = () => fakeSessionRef.calls.filter((c) => typeof c === 'string' && c.includes('工具调用'));

  // assistant serializes the call as TEXT — then the agent ends with no real call
  emit({ type: 'message_end', message: { role: 'assistant', usage: { input: 1, output: 1 }, content: [{ type: 'text', text: 'Let me run that: {"name": "bash", "arguments": {"command": "ls"}}' }] } });
  emit({ type: 'agent_end' });
  await flush();
  assert.ok(reminds().length >= 1, 'reminder prompt fired for text-serialized call');
  assert.ok(audited.some((e) => e.kind === 'TEXT_TOOLCALL_REMINDED'), 'remind audited');

  // consecutive pseudo-calls → second remind, third hits the cap (audited, no prompt)
  emit({ type: 'message_end', message: { role: 'assistant', usage: {}, content: [{ type: 'text', text: '{"name": "write", "arguments": {"path": "x"}}' }] } });
  emit({ type: 'agent_end' });
  await flush();
  emit({ type: 'message_end', message: { role: 'assistant', usage: {}, content: [{ type: 'text', text: '<tool_call>{"name":"read"}</tool_call>' }] } });
  emit({ type: 'agent_end' });
  await flush();
  assert.equal(reminds().length, 2, 'reminder capped at 2 consecutive');
  assert.ok(audited.some((e) => e.kind === 'TEXT_TOOLCALL_REMIND_CAP'), 'cap audited');

  // benign text never triggers even after cap armed
  emit({ type: 'message_end', message: { role: 'assistant', usage: {}, content: [{ type: 'text', text: 'All done — edited 3 files, tests pass.' }] } });
  emit({ type: 'agent_end' });
  await flush();
  assert.equal(reminds().length, 2, 'benign assistant text stays silent');
  dispose();
});

// dedup-h #2227 — `/model --compaction` analogue: model_compaction_set writes
// feature-models.json 'compaction' (other keys preserved), model_compaction
// reads it back, clear removes the key → native session-model summarizer.
test('#2227 compaction model: set/get/clear round-trips feature-models.json', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-comp-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const core = { paths: { auditDir, root: dir }, audit: { write: () => {} } };
  // pre-existing keys must survive a compaction pick
  writeFileSync(join(dir, 'feature-models.json'), JSON.stringify({ judge: { provider: 'p', model: 'j1' }, timeout_ms: 9000 }));
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core });

  let r = await ch.handle({ type: 'model_compaction' });
  assert.equal(r.data.compaction, null, 'absent key → null (native summarizer)');

  r = await ch.handle({ type: 'model_compaction_set', model: 'haiku-mini' });
  assert.equal(r.data.compaction.model, 'haiku-mini');
  assert.equal(r.data.compaction.provider, undefined, 'bare model rides the session provider');

  r = await ch.handle({ type: 'model_compaction_set', provider: 'anthropic', model: 'claude-haiku' });
  assert.equal(r.data.compaction.provider, 'anthropic');

  const doc = JSON.parse(readFileSync(join(dir, 'feature-models.json'), 'utf-8'));
  assert.deepEqual(doc.compaction, { provider: 'anthropic', model: 'claude-haiku' });
  assert.deepEqual(doc.judge, { provider: 'p', model: 'j1' }, 'other feature keys preserved');
  assert.equal(doc.timeout_ms, 9000);

  r = await ch.handle({ type: 'model_compaction' });
  assert.equal(r.data.compaction.model, 'claude-haiku', 'live read-back');

  r = await ch.handle({ type: 'model_compaction_set', clear: true });
  assert.equal(r.data.compaction, null);
  assert.equal(r.data.removed, true);
  assert.equal(JSON.parse(readFileSync(join(dir, 'feature-models.json'), 'utf-8')).compaction, undefined);

  r = await ch.handle({ type: 'model_compaction_set' }); // no model at all → clear path
  assert.equal(r.data.compaction, null);
  assert.equal(r.data.removed, false, 'second clear reports nothing removed');
  dispose();
});

// dedup-h #2346 — `/fast` priority-queue analogue: model_fast_set writes
// samplingParams.service_tier onto the ACTIVE model's models.json entry
// (SDK merges sampling params verbatim into the request body). Whole-entry
// replace semantics mean an absent entry is seeded from the composed model;
// other providers/models/sampling keys untouched; off removes the key.
test('#2346 fast tier: set/read/off round-trips service_tier on the active model', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-fast-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  mkdirSync(join(dir, 'pi-agent'), { recursive: true });
  const audits = [];
  const core = { paths: { auditDir, root: dir }, audit: { write: (e) => audits.push(e) } };
  let refreshed = 0;
  fakeSessionRef.modelRuntime = {
    getProvider: (p) => (p === 'cpa' ? { id: 'cpa', baseUrl: 'https://api.example', api: 'openai-responses' } : null),
    refresh: async () => { refreshed++; },
  };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core });
  const file = join(dir, 'pi-agent', 'models.json');
  const doc = () => JSON.parse(readFileSync(file, 'utf-8'));

  let r = await ch.handle({ type: 'model_fast' });
  assert.equal(r.data.enabled, false, 'no entry → default queue');

  r = await ch.handle({ type: 'model_fast_set', tier: 'priority' });
  assert.equal(r.data.enabled, true);
  assert.equal(r.data.provider, 'cpa');
  assert.equal(refreshed, 1, 'runtime reloaded after write');
  let entry = doc().providers.cpa.models.find((m) => m.id === 'gpt-5.6-luna-max');
  assert.equal(entry.samplingParams.service_tier, 'priority');
  assert.equal(doc().providers.cpa.baseUrl, 'https://api.example', 'provider seeded from runtime catalog');

  r = await ch.handle({ type: 'model_fast' });
  assert.equal(r.data.enabled, true, 'live read-back from the file entry');

  // sibling sampling keys survive an explicit tier change
  const d2 = doc();
  d2.providers.cpa.models[0].samplingParams.temperature = 0.5;
  writeFileSync(file, JSON.stringify(d2));
  r = await ch.handle({ type: 'model_fast_set', tier: 'flex' });
  assert.equal(doc().providers.cpa.models[0].samplingParams.temperature, 0.5, 'other sampling keys preserved');
  assert.equal(doc().providers.cpa.models[0].samplingParams.service_tier, 'flex');

  r = await ch.handle({ type: 'model_fast_set', off: true });
  assert.equal(r.data.enabled, false);
  entry = doc().providers.cpa.models[0];
  assert.deepEqual(entry.samplingParams, { temperature: 0.5 }, 'service_tier key removed, siblings kept');
  assert.ok(audits.some((e) => e.kind === 'MODEL_SERVICE_TIER' && e.data.tier === null), 'clear audited');

  r = await ch.handle({ type: 'model_fast_set', tier: 'bogus' });
  assert.equal(r.success, false, 'unknown tier refused');
  dispose();
});

// dedup-h #2263 — bill() stamps the live model onto the ledger row so the
// traces surface can do per-model breakdown.
test('#2263 bill stamps model onto ledger rows for the traces surface', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-bill-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const { BudgetGovernor } = await import('../../host/src/core/budget.js');
  const { AuditWriter } = await import('../../host/src/core/audit.js');
  const audit = new AuditWriter({ auditDir });
  const ledgerPath = join(dir, 'budget-ledger.jsonl');
  const budget = new BudgetGovernor({ ledgerPath, limits: {}, audit });
  const core = { paths: { auditDir }, audit };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core, budget });
  fakeSessionRef.sessionId = 's-bill';
  fakeSessionRef.sessionManager = { getSessionId: () => 's-bill' };

  for (const l of [...listeners]) l({ type: 'message_end', message: { role: 'assistant', usage: { input: 50, output: 20, cacheRead: 10, cost: { total: 0.01 } } } });
  await new Promise((r) => setTimeout(r, 20));
  const rows = readFileSync(ledgerPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  const last = rows.at(-1);
  assert.equal(last.model, 'gpt-5.6-luna-max', 'live model id stamped');
  assert.deepEqual(last.detail, { input: 50, output: 20, cacheRead: 10, cacheWrite: 0 }, 'token split persisted');
  const t = budget.traces({ scope: 's-bill' });
  assert.equal(t.shown, 1);
  assert.equal(t.byModel['gpt-5.6-luna-max'].tokens, 80);
  dispose();
});
