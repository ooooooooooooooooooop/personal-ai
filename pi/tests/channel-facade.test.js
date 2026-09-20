/**
 * M6 pi channel facade — real AgentSession subscribe + real audit file tail.
 * Asserts the facade translates Pi state into plain-data snapshots.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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
  assert.equal(tail.data[0].kind, 'TURN_ACCOUNTING');
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
