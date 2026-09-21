/**
 * M6 pi channel facade — real AgentSession subscribe + real audit file tail.
 * Asserts the facade translates Pi state into plain-data snapshots.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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

test('M71: ephemeral session refuses session_export in every format', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  // in-memory session: no file, but exportToHtml WOULD still write one —
  // the guard must refuse before it ever runs.
  fakeSessionRef.ephemeral = true;
  let htmlCalled = false;
  fakeSessionRef.exportToHtml = async () => { htmlCalled = true; return 'x'; };
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-eph-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const core = { paths: { auditDir } };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core });
  for (const format of ['html', 'jsonl', 'debug']) {
    const r = await ch.handle({ type: 'session_export', format });
    assert.equal(r.success, true);
    assert.equal(r.data.refused, true, format);
    assert.equal(r.data.file, null, format);
  }
  assert.equal(htmlCalled, false);
  // a persistent session still exports normally (guard doesn't over-fire)
  fakeSessionRef.ephemeral = false;
  fakeSessionRef.sessionFile = join(dir, 'live.jsonl');
  writeFileSync(fakeSessionRef.sessionFile, '{"a":1}\n');
  const ok = await ch.handle({ type: 'session_export', format: 'jsonl' });
  assert.equal(ok.success, true);
  assert.ok(ok.data.file, 'persistent export produces a file');
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
