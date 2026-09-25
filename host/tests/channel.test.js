/**
 * M6 HostChannel — neutral UI protocol over injected facades (no harness).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HostChannel } from '../src/core/channel.js';

const fakeSession = () => {
  const s = {
    calls: [],
    listeners: new Set(),
    prompt: async (m) => { s.calls.push(['prompt', m]); },
    steer: async (m) => { s.calls.push(['steer', m]); },
    abort: async () => { s.calls.push(['abort']); },
    getState: async () => ({ model: { provider: 'x', id: 'm1' }, streaming: false }),
    subscribe: (l) => { s.listeners.add(l); return () => s.listeners.delete(l); },
  };
  return s;
};

test('prompt/steer/abort dispatch to the session facade', async () => {
  const session = fakeSession();
  const ch = new HostChannel({ session });
  const r1 = await ch.handle({ id: 'a', type: 'prompt', message: 'hi' });
  assert.equal(r1.success, true);
  assert.equal(r1.id, 'a');
  await ch.handle({ type: 'steer', message: 'now this' });
  await ch.handle({ type: 'abort' });
  assert.deepEqual(session.calls, [['prompt', 'hi'], ['steer', 'now this'], ['abort']]);
});

test('get_state returns the facade snapshot; unknown commands fail politely', async () => {
  const ch = new HostChannel({ session: fakeSession() });
  const r = await ch.handle({ type: 'get_state' });
  assert.equal(r.success, true);
  assert.equal(r.data.model.provider, 'x');
  const bad = await ch.handle({ type: 'rm_rf' });
  assert.equal(bad.success, false);
  assert.match(bad.error, /unknown command/);
});

test('session events fan out to channel subscribers; listener errors are isolated', async () => {
  const session = fakeSession();
  const ch = new HostChannel({ session });
  const got = [];
  ch.subscribe((m) => got.push(m));
  ch.subscribe(() => { throw new Error('bad listener'); });
  for (const l of session.listeners) l({ type: 'turn_end', turnIndex: 0 });
  assert.deepEqual(got, [{ type: 'event', event: { type: 'turn_end', turnIndex: 0 } }]);
});

test('job_status + audit_tail use injected host facades', async () => {
  const jobs = {
    getJob: (id) => (id === 'j1' ? { job_id: 'j1', job_state: 'RUNNING' } : null),
    getAttempts: () => [{}, {}],
    getLease: () => ({ writer_id: 'w' }),
  };
  const audit = { tail: (n) => [{ kind: 'E1' }, { kind: 'E2' }].slice(-n) };
  const ch = new HostChannel({ session: fakeSession(), jobs, audit });
  const ok = await ch.handle({ type: 'job_status', job_id: 'j1' });
  assert.equal(ok.data.attempts, 2);
  const missing = await ch.handle({ type: 'job_status', job_id: 'nope' });
  assert.equal(missing.success, false);
  const tail = await ch.handle({ type: 'audit_tail', n: 1 });
  assert.deepEqual(tail.data, [{ kind: 'E2' }]);
});

test('session facade errors become success:false, never thrown', async () => {
  const ch = new HostChannel({
    session: { ...fakeSession(), prompt: async () => { throw new Error('model blew up'); } },
  });
  const r = await ch.handle({ type: 'prompt', message: 'x' });
  assert.equal(r.success, false);
  assert.match(r.error, /model blew up/);
});

test('model/session commands route to their facades; absent facades fail politely', async () => {
  const calls = [];
  const models = {
    status: async () => ({ current: { provider: 'x', id: 'm1' }, providers: [] }),
    list: async () => [{ provider: 'x', id: 'm1' }],
    set: async ({ provider, model }) => { calls.push(['set', provider, model]); return { provider, id: model }; },
    setThinking: async (l) => { calls.push(['thinking', l]); return { thinkingLevel: l }; },
    setApiKey: async ({ provider }) => { calls.push(['key', provider]); return { provider, hasAuth: true }; },
    clearApiKey: async (p) => { calls.push(['clear', p]); return { provider: p, hasAuth: false }; },
  };
  const sessions = {
    list: async () => [{ id: 's1' }],
    create: async () => { calls.push(['new']); return { id: 's2' }; },
    open: async (p) => { calls.push(['open', p]); return { id: 's1' }; },
    rename: async (n) => { calls.push(['rename', n]); return { name: n }; },
  };
  const ch = new HostChannel({ session: fakeSession(), models, sessions });

  assert.equal((await ch.handle({ type: 'model_status' })).data.current.id, 'm1');
  assert.equal((await ch.handle({ type: 'model_list' })).data.length, 1);
  await ch.handle({ type: 'model_set', provider: 'x', model: 'm2' });
  await ch.handle({ type: 'thinking_set', level: 'high' });
  await ch.handle({ type: 'auth_set_key', provider: 'x', key: 'SECRET-DO-NOT-ECHO' });
  await ch.handle({ type: 'auth_clear', provider: 'x' });
  await ch.handle({ type: 'session_new' });
  await ch.handle({ type: 'session_switch', path: '/tmp/s1.jsonl' });
  await ch.handle({ type: 'session_rename', name: 'demo' });
  assert.equal((await ch.handle({ type: 'session_list' })).data[0].id, 's1');
  assert.deepEqual(calls, [
    ['set', 'x', 'm2'], ['thinking', 'high'], ['key', 'x'], ['clear', 'x'],
    ['new'], ['open', '/tmp/s1.jsonl'], ['rename', 'demo'],
  ]);

  // argument validation + absent-facade errors
  assert.match((await ch.handle({ type: 'model_set' })).error, /requires/);
  assert.match((await ch.handle({ type: 'auth_set_key', provider: 'x' })).error, /requires/);
  assert.match((await ch.handle({ type: 'session_switch' })).error, /requires/);
  const bare = new HostChannel({ session: fakeSession() });
  assert.equal((await bare.handle({ type: 'model_status' })).success, false);
  assert.equal((await bare.handle({ type: 'session_list' })).success, false);
});

test('pending_list/decision_resolve drive the asks facade; ask events fan out', async () => {
  const { PendingAsks } = await import('../src/core/asks.js');
  const asks = new PendingAsks({ timeoutMs: 5000 });
  const ch = new HostChannel({ session: fakeSession(), asks });
  const got = [];
  ch.subscribe((m) => got.push(m));

  const p = asks.ask({ toolName: 'bash', rule: 'risk_destructive', summary: 'command: rm -rf x' });
  assert.equal(got[0].event.type, 'governance_ask');

  const list = await ch.handle({ type: 'pending_list' });
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].toolName, 'bash');

  const bad = await ch.handle({ type: 'decision_resolve', askId: list.data[0].id, answer: 'maybe' });
  assert.equal(bad.success, false);
  const ok = await ch.handle({ type: 'decision_resolve', askId: list.data[0].id, answer: 'deny' });
  assert.equal(ok.success, true);
  assert.equal(await p, 'deny');
  assert.equal(got[1].event.type, 'governance_resolved');

  const bare = new HostChannel({ session: fakeSession() });
  assert.equal((await bare.handle({ type: 'pending_list' })).success, false);
  ch.dispose();
});

test('risk_mode get/set roundtrip; invalid mode refused', async () => {
  let mode = 'normal';
  const modes = { get: () => mode, set: (m) => { mode = m; return mode; } };
  const ch = new HostChannel({ session: fakeSession(), modes });
  const g = await ch.handle({ type: 'risk_mode' });
  assert.equal(g.data.mode, 'normal');
  const s = await ch.handle({ type: 'risk_mode_set', mode: 'plan' });
  assert.equal(s.data.mode, 'plan');
  assert.equal(mode, 'plan');
  const bad = await ch.handle({ type: 'risk_mode_set', mode: 'yolo' });
  assert.equal(bad.success, false);
});

test('M132: config_get snapshots; config_set dispatches allowlisted keys to governed facades', async () => {
  const calls = [];
  const models = {
    status: async () => ({ model: { provider: 'anthropic', id: 'claude-x' }, thinkingLevel: 'medium' }),
    set: async (t) => { calls.push(['model.set', t]); return { provider: t.provider ?? 'via-alias', id: t.model ?? t.alias }; },
    setThinking: async (lvl) => { calls.push(['setThinking', lvl]); return { thinkingLevel: lvl }; },
  };
  const modes = { get: () => 'normal', setMode: (n) => (n === 'plan' ? { mode: 'plan' } : null) };
  const ch = new HostChannel({ session: fakeSession(), models, modes });

  const g = await ch.handle({ type: 'config_get' });
  assert.equal(g.success, true);
  assert.equal(g.data.model.id, 'claude-x');
  assert.equal(g.data.thinking, 'medium');
  assert.equal(g.data.mode, 'normal');

  // provider/model splits on the slash; bare words resolve as aliases
  const s1 = await ch.handle({ type: 'config_set', key: 'model', value: 'openai/gpt-x' });
  assert.deepEqual(calls.at(-1), ['model.set', { provider: 'openai', model: 'gpt-x' }]);
  await ch.handle({ type: 'config_set', key: 'model', value: 'fast' });
  assert.deepEqual(calls.at(-1), ['model.set', { alias: 'fast' }]);
  await ch.handle({ type: 'config_set', key: 'thinking', value: 'high' });
  assert.deepEqual(calls.at(-1), ['setThinking', 'high']);
  const s3 = await ch.handle({ type: 'config_set', key: 'mode', value: 'plan' });
  assert.equal(s3.data.mode, 'plan');

  // unknown key + unknown mode refuse honestly
  const bad = await ch.handle({ type: 'config_set', key: 'shell_access', value: 'root' });
  assert.equal(bad.success, false);
  assert.match(bad.error, /unknown key/);
  const badMode = await ch.handle({ type: 'config_set', key: 'mode', value: 'yolo' });
  assert.equal(badMode.success, false);
  // missing facades fail closed
  const bare = new HostChannel({ session: fakeSession() });
  assert.equal((await bare.handle({ type: 'config_set', key: 'model', value: 'x' })).success, false);
});

test('session_rewind restoreFiles undoes receipts newer than the anchor', async () => {
  const session = fakeSession();
  session.entries = async () => [
    { entryId: 'e-old', text: 'first', ts: '2026-01-01T00:00:00.000Z' },
    { entryId: 'e-new', text: 'second', ts: '2026-01-02T00:00:00.000Z' },
  ];
  session.rewind = async (id, opts) => ({ cancelled: false, editorText: 'second', id, opts });
  const restoredCalls = [];
  const fileops = {
    // newest-first, as the real facade returns
    list: async () => [
      { receiptId: 'r3', op: 'write', at: Date.parse('2026-01-03T00:00:00Z'), recoverable: true },
      { receiptId: 'r2', op: 'delete', at: Date.parse('2026-01-02T12:00:00Z'), recoverable: true },
      { receiptId: 'r1', op: 'write', at: Date.parse('2026-01-01T12:00:00Z'), recoverable: true },
      { receiptId: 'r0', op: 'write', at: Date.parse('2026-01-04T00:00:00Z'), recoverable: false },
    ],
    restore: async (receiptId) => { restoredCalls.push(receiptId); return { restored: 'x' }; },
  };
  const ch = new HostChannel({ session, fileops });
  const r = await ch.handle({ type: 'session_rewind', entryId: 'e-new', restoreFiles: true });
  assert.equal(r.success, true);
  // r1 predates the anchor — untouched; r0 unrecoverable — skipped; r2/r3 undone newest-first
  assert.deepEqual(restoredCalls, ['r3', 'r2']);
  assert.deepEqual(r.data.restoredFiles, ['r3', 'r2']);
  // plain rewind without restoreFiles leaves fileops alone
  restoredCalls.length = 0;
  await ch.handle({ type: 'session_rewind', entryId: 'e-new' });
  assert.equal(restoredCalls.length, 0);
});

test('todos_list reads the session todo file; session_delete routes to the facade', async () => {
  const ch = new HostChannel({
    session: fakeSession(),
    todos: { list: async () => [{ content: 'do thing', status: 'in_progress' }] },
    sessions: { remove: async (p) => ({ removed: p }) },
  });
  const t = await ch.handle({ type: 'todos_list' });
  assert.equal(t.success, true);
  assert.equal(t.data[0].content, 'do thing');
  const d = await ch.handle({ type: 'session_delete', path: 'sessions/x.jsonl' });
  assert.equal(d.success, true);
  assert.equal(d.data.removed, 'sessions/x.jsonl');
  const bad = await ch.handle({ type: 'session_delete' });
  assert.equal(bad.success, false);
});

test('session_rewind restoreFiles uses uncapped scan, undoes tombstones, reports partial failures', async () => {
  const session = fakeSession();
  session.entries = async () => [
    { entryId: 'e-anchor', text: 'go', ts: '2026-01-01T00:00:00.000Z' },
  ];
  session.rewind = async () => ({ cancelled: false });
  const restoredCalls = [];
  const fileops = {
    // listAll only — proves the rewind path does not depend on the capped UI list
    listAll: async () => [
      { receiptId: 'new-created', op: 'create', at: Date.parse('2026-01-02T00:00:00Z'), recoverable: false, undoable: true },
      { receiptId: 'boom', op: 'write', at: Date.parse('2026-01-02T00:00:00Z'), recoverable: true, undoable: true },
      { receiptId: 'old', op: 'write', at: Date.parse('2025-12-31T00:00:00Z'), recoverable: true, undoable: true },
    ],
    restore: async (receiptId) => {
      restoredCalls.push(receiptId);
      if (receiptId === 'boom') throw new Error('artifact gone');
      return { restored: 'x' };
    },
  };
  const ch = new HostChannel({ session, fileops });
  const r = await ch.handle({ type: 'session_rewind', entryId: 'e-anchor', restoreFiles: true });
  assert.equal(r.success, true);
  assert.deepEqual(restoredCalls, ['new-created', 'boom']);
  assert.deepEqual(r.data.restoredFiles, ['new-created']);
  assert.equal(r.data.partial, true);
  assert.equal(r.data.failedFiles[0].receiptId, 'boom');
});

test('session_rewind scope=files restores without moving the chat head', async () => {
  const session = fakeSession();
  session.entries = async () => [
    { entryId: 'e-a', text: 'x', ts: '2026-01-01T00:00:00.000Z' },
  ];
  let rewindCalls = 0;
  session.rewind = async () => { rewindCalls += 1; return { cancelled: false }; };
  const restoredCalls = [];
  const fileops = {
    listAll: async () => [
      { receiptId: 'r1', op: 'write', at: Date.parse('2026-01-02T00:00:00Z'), recoverable: true },
    ],
    restore: async (id) => { restoredCalls.push(id); return { restored: 'x' }; },
  };
  const ch = new HostChannel({ session, fileops });
  const r = await ch.handle({ type: 'session_rewind', entryId: 'e-a', scope: 'files' });
  assert.equal(r.success, true);
  assert.equal(rewindCalls, 0);                       // conversation head unmoved
  assert.deepEqual(restoredCalls, ['r1']);            // files still restored
  assert.equal(r.data.filesOnly, true);
  // unknown anchor on a file-scoped request fails loudly, not silent no-op
  const bad = await ch.handle({ type: 'session_rewind', entryId: 'ghost', scope: 'files' });
  assert.equal(bad.success, false);
});

test('session_fork forwards entryId for fork-at-point', async () => {
  const calls = [];
  const ch = new HostChannel({
    session: fakeSession(),
    sessions: { fork: async (path, opts) => { calls.push([path, opts?.entryId]); return { id: 's2' }; } },
  });
  const r = await ch.handle({ type: 'session_fork', path: 'sessions/a.jsonl', entryId: 'e-mid' });
  assert.equal(r.success, true);
  assert.deepEqual(calls, [['sessions/a.jsonl', 'e-mid']]);
});

test('task_list flags open tasks whose bound job is terminal as stale', async () => {
  const { TaskStore } = await import('../src/core/tasks.js');
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-task-'));
  const tasks = new TaskStore(dir);
  const open = tasks.create({ label: 'running child', kind: 'delegation' });
  const done = tasks.create({ label: 'finished child', kind: 'delegation' });
  tasks.bindJob(done.task_id, 'job-terminal');
  const jobs = {
    getJob: (id) => id === 'job-terminal' ? { job_state: 'COMPLETED' } : null,
  };
  const ch = new HostChannel({ session: fakeSession(), tasks, jobs });
  const r = await ch.handle({ type: 'task_list' });
  const staleRow = r.data.find((t) => t.task_id === done.task_id);
  const liveRow = r.data.find((t) => t.task_id === open.task_id);
  assert.equal(staleRow.stale, true);
  assert.equal(liveRow.stale, undefined);
});

test('verify_run/verify_status dispatch to the verify facade; absent facade fails closed', async () => {
  const calls = [];
  const verify = {
    status: () => ({ armed: true, command: 'npm test' }),
    runNow: async () => { calls.push('run'); return { ran: true, ok: true, code: 0 }; },
  };
  const ch = new HostChannel({ session: fakeSession(), verify });
  const s = await ch.handle({ type: 'verify_status' });
  assert.equal(s.data.armed, true);
  const r = await ch.handle({ type: 'verify_run' });
  assert.equal(r.data.ran, true);
  assert.equal(calls.length, 1);
  const bare = new HostChannel({ session: fakeSession() });
  assert.equal((await bare.handle({ type: 'verify_run' })).success, false);
});

test('stop_all aborts the turn and cancels every non-terminal job', async () => {
  const session = fakeSession();
  const cancelled = [];
  const jobs = {
    listRecent: () => [
      { job_id: 'j1', job_state: 'RUNNING' },
      { job_id: 'j2', job_state: 'COMPLETED' },
      { job_id: 'j3', job_state: 'QUEUED' },
    ],
    cancelJob: (id) => cancelled.push(id),
  };
  const events = [];
  const audit = { write: (e) => events.push(e) };
  const ch = new HostChannel({ session, jobs, audit });
  const r = await ch.handle({ type: 'stop_all' });
  assert.equal(r.success, true);
  assert.equal(r.data.aborted, true);
  assert.deepEqual(r.data.cancelled.sort(), ['j1', 'j3']);
  assert.deepEqual(session.calls, [['abort']]);
  assert.equal(events.at(-1).kind, 'STOP_ALL');
});

test('stop_all with no jobs facade still aborts the live turn', async () => {
  const session = fakeSession();
  const ch = new HostChannel({ session });
  const r = await ch.handle({ type: 'stop_all' });
  assert.equal(r.success, true);
  assert.equal(r.data.aborted, true);
  assert.deepEqual(r.data.cancelled, []);
});

test('goal_list/goal_set route to the goalStore facade; absent fails politely', async () => {
  const goalStore = {
    list: () => [{ goal_id: 'goal-1', state: 'open', task_ids: ['t1'], statement: 'x' }],
    setState: (id, state) => id === 'goal-1' ? { goal_id: id, state } : null,
  };
  const ch = new HostChannel({ session: fakeSession(), goalStore });
  const r = await ch.handle({ type: 'goal_list' });
  assert.equal(r.success, true);
  assert.equal(r.data[0].goal_id, 'goal-1');
  const set = await ch.handle({ type: 'goal_set', id: 'goal-1', state: 'paused' });
  assert.equal(set.data.state, 'paused');
  const missing = await ch.handle({ type: 'goal_set', id: 'goal-nope', state: 'done' });
  assert.equal(missing.success, false);
  const bare = new HostChannel({ session: fakeSession() });
  assert.equal((await bare.handle({ type: 'goal_list' })).success, false);
});

test('auth_set_key strips invisible characters; never echoes key material', async () => {
  let got = null;
  const models = { setApiKey: async ({ provider, key }) => { got = { provider, key }; return { ok: true }; } };
  const ch = new HostChannel({ session: fakeSession(), models });
  const dirty = `﻿ sk-abc​‎123﻿  `;
  const r = await ch.handle({ type: 'auth_set_key', provider: 'openai', key: dirty });
  assert.equal(r.success, true);
  assert.equal(got.key, 'sk-abc123');
  // a key that is ONLY invisible chars is refused, not stored
  const r2 = await ch.handle({ type: 'auth_set_key', provider: 'openai', key: '﻿ ​‎' });
  assert.match(r2.error, /invisible/);
  // response surface must not contain the key
  assert.ok(!JSON.stringify(r).includes('sk-abc123'));
});

test('M64: instance_purge defaults to dry-run; explicit dry_run:false deletes; evidence classes refused', async () => {
  const calls = [];
  const instance = {
    inventory: () => ({ root: '/r', categories: { exports: { files: 2, bytes: 10 } } }),
    purge: (opts) => {
      calls.push(opts);
      if (opts.category === 'audit') return { ok: false, error: 'not purgeable' };
      return { ok: true, dry_run: opts.dry_run !== false, category: opts.category, files: 2, bytes: 10 };
    },
  };
  const ch = new HostChannel({ session: fakeSession(), instance });
  // default → preview only
  const pre = await ch.handle({ type: 'instance_purge', category: 'exports' });
  assert.equal(pre.success, true);
  assert.equal(pre.data.dry_run, true);
  assert.equal(calls[0].dry_run, undefined, 'absent dry_run forwarded as absent — the facade defaults to preview');
  // explicit false → real delete
  const real = await ch.handle({ type: 'instance_purge', category: 'exports', dry_run: false });
  assert.equal(real.data.dry_run, false);
  // enforcement evidence refused at the facade
  const bad = await ch.handle({ type: 'instance_purge', category: 'audit', dry_run: false });
  assert.equal(bad.success, false);
  assert.match(bad.error, /not purgeable/);
  // absent facade fails closed
  const bare = new HostChannel({ session: fakeSession() });
  assert.equal((await bare.handle({ type: 'instance_purge', category: 'exports' })).success, false);
});

test('M71: session_new ephemeral routes to createEphemeral; absent fails closed', async () => {
  const calls = [];
  const sessions = {
    create: async () => { calls.push('persisted'); return { id: 's1', file: '/s/1.jsonl' }; },
    createEphemeral: async () => { calls.push('ephemeral'); return { id: 's2', file: null, ephemeral: true }; },
  };
  const ch = new HostChannel({ session: fakeSession(), sessions });
  const eph = await ch.handle({ type: 'session_new', ephemeral: true });
  assert.equal(eph.success, true);
  assert.equal(eph.data.ephemeral, true);
  assert.equal(eph.data.file, null);
  const normal = await ch.handle({ type: 'session_new' });
  assert.equal(normal.data.file, '/s/1.jsonl');
  assert.deepEqual(calls, ['ephemeral', 'persisted']);
  const bare = new HostChannel({ session: fakeSession(), sessions: { create: sessions.create } });
  assert.equal((await bare.handle({ type: 'session_new', ephemeral: true })).success, false);
});

test('M90/M92: job_restart re-spawns terminal command; job_delete removes terminal only', async () => {
  const calls = [];
  const jobDetail = {
    restart: async (id) => { calls.push(['restart', id]); return { job_id: 'job-new', attempt_id: 'a1' }; },
    remove: (id) => { calls.push(['remove', id]); return { ok: true, job_id: id }; },
  };
  const ch = new HostChannel({ session: fakeSession(), jobDetail });
  const rr = await ch.handle({ type: 'job_restart', job_id: 'job-1' });
  assert.equal(rr.success, true);
  assert.equal(rr.data.job_id, 'job-new');
  const dr = await ch.handle({ type: 'job_delete', job_id: 'job-1' });
  assert.equal(dr.success, true);
  // refusal surfaces honestly
  const refusing = { restart: async () => ({ refused: true, reason: 'job is RUNNING' }), remove: () => ({ ok: false, error: 'job is RUNNING — cancel first' }) };
  const ch2 = new HostChannel({ session: fakeSession(), jobDetail: refusing });
  assert.equal((await ch2.handle({ type: 'job_restart', job_id: 'j' })).success, false);
  assert.equal((await ch2.handle({ type: 'job_delete', job_id: 'j' })).success, false);
  // absent facade fails closed
  const bare = new HostChannel({ session: fakeSession() });
  assert.equal((await bare.handle({ type: 'job_restart', job_id: 'j' })).success, false);
  assert.equal((await bare.handle({ type: 'job_delete', job_id: 'j' })).success, false);
});

test('M81: profile_save/apply/list/delete route to the profiles facade', async () => {
  const store = new Map();
  const profiles = {
    save: ({ name }) => { store.set(name, { model: { provider: 'p', id: 'm' }, mode: 'fast' }); return { name, saved: true }; },
    apply: async ({ name }) => store.has(name) ? { ok: true, name, applied: { model: 'm', mode: 'fast' } } : { ok: false, error: `no profile '${name}'` },
    list: () => [...store.keys()].map((name) => ({ name, ...store.get(name) })),
    remove: ({ name }) => ({ removed: store.delete(name) }),
  };
  const ch = new HostChannel({ session: fakeSession(), profiles });
  await ch.handle({ type: 'profile_save', name: 'work' });
  assert.equal((await ch.handle({ type: 'profile_list' })).data.length, 1);
  const ap = await ch.handle({ type: 'profile_apply', name: 'work' });
  assert.equal(ap.data.applied.mode, 'fast');
  assert.equal((await ch.handle({ type: 'profile_apply', name: 'nope' })).success, false);
  await ch.handle({ type: 'profile_delete', name: 'work' });
  assert.equal((await ch.handle({ type: 'profile_list' })).data.length, 0);
  const bare = new HostChannel({ session: fakeSession() });
  assert.equal((await bare.handle({ type: 'profile_list' })).success, false);
});

test('M81: profile_export/import route with path confinement enforced in facade', async () => {
  const calls = [];
  const profiles = {
    export: ({ path }) => { calls.push(['export', path]); return { ok: true, path: '/i/profiles-export.json' }; },
    import: ({ path }) => { calls.push(['import', path]); return { ok: true, imported: 2 }; },
  };
  const ch = new HostChannel({ session: fakeSession(), profiles });
  const ex = await ch.handle({ type: 'profile_export' });
  assert.equal(ex.success, true);
  assert.deepEqual(calls[0], ['export', null]);
  const im = await ch.handle({ type: 'profile_import', path: 'profiles-export.json' });
  assert.equal(im.data.imported, 2);
  // import without path refuses; facade error propagates honestly
  assert.equal((await ch.handle({ type: 'profile_import' })).success, false);
  const bad = new HostChannel({ session: fakeSession(), profiles: { ...profiles, export: () => ({ ok: false, error: 'nope' }) } });
  assert.equal((await bad.handle({ type: 'profile_export' })).success, false);
  const bare = new HostChannel({ session: fakeSession() });
  assert.equal((await bare.handle({ type: 'profile_export' })).success, false);
  assert.equal((await bare.handle({ type: 'profile_import', path: 'x.json' })).success, false);
});

test('D7: lease_status reports writer + workspace-write holders; absent fails closed', async () => {
  const leases = { status: () => ({ writer: { owner: 'pi:r1', generation: 3 }, workspaceWrite: { holder: 'job:j9' } }) };
  const ch = new HostChannel({ session: fakeSession(), leases });
  const r = await ch.handle({ type: 'lease_status' });
  assert.equal(r.success, true);
  assert.equal(r.data.writer.owner, 'pi:r1');
  assert.equal(r.data.workspaceWrite.holder, 'job:j9');
  const bare = new HostChannel({ session: fakeSession() });
  assert.equal((await bare.handle({ type: 'lease_status' })).success, false);
});

test('governance_dryrun routes to the governance facade; validates input', async () => {
  const seen = [];
  const governance = {
    dryRun: async (tool, args) => { seen.push([tool, args]); return { action: 'ask', rule: 'risk_mutating', reason: 'x' }; },
  };
  const ch = new HostChannel({ session: fakeSession(), governance });
  const r = await ch.handle({ type: 'governance_dryrun', tool: 'bash', args: { command: 'npm run build' } });
  assert.equal(r.success, true);
  assert.equal(r.data.action, 'ask');
  assert.deepEqual(seen, [['bash', { command: 'npm run build' }]]);
  // args may arrive as a JSON string (UI form) — parsed at the boundary
  const r2 = await ch.handle({ type: 'governance_dryrun', tool: 'bash', args: '{"command":"ls"}' });
  assert.equal(r2.success, true);
  assert.deepEqual(seen[1], ['bash', { command: 'ls' }]);
  const badJson = await ch.handle({ type: 'governance_dryrun', tool: 'bash', args: '{nope' });
  assert.equal(badJson.success, false);
  assert.match(badJson.error, /not valid JSON/);
  const noTool = await ch.handle({ type: 'governance_dryrun' });
  assert.equal(noTool.success, false);
  assert.match(noTool.error, /requires \{tool\}/);
  const noFacade = await new HostChannel({ session: fakeSession() })
    .handle({ type: 'governance_dryrun', tool: 'bash' });
  assert.equal(noFacade.success, false);
  assert.match(noFacade.error, /unavailable/);
});

test('budget_rollup: window translation, facade passthrough, honest validation', async () => {
  const calls = [];
  const budget = {
    rollup: (opts) => { calls.push(opts); return { rows: 0, total: { tokens: 0, cost: 0, calls: 0 }, byScope: {}, byDay: {} }; },
  };
  const ch = new HostChannel({ session: fakeSession(), budget });
  const all = await ch.handle({ type: 'budget_rollup' });
  assert.equal(all.success, true);
  assert.deepEqual(calls.at(-1), {}, 'no window args = all-time');

  const win = await ch.handle({ type: 'budget_rollup', since: 1000, until: 2000 });
  assert.equal(win.success, true);
  assert.deepEqual(calls.at(-1), { since: 1000, until: 2000 });

  const hrs = await ch.handle({ type: 'budget_rollup', hours: 24 });
  assert.equal(hrs.success, true);
  assert.ok(Math.abs((Date.now() - calls.at(-1).since) - 86_400_000) < 5000, 'hours translates to a since bound');

  const bad = await ch.handle({ type: 'budget_rollup', hours: -3 });
  assert.equal(bad.success, false);
  const bad2 = await ch.handle({ type: 'budget_rollup', since: 'not-a-number' });
  assert.equal(bad2.success, false);

  const noFacade = new HostChannel({ session: fakeSession() });
  const r = await noFacade.handle({ type: 'budget_rollup' });
  assert.equal(r.success, false);
  assert.match(r.error, /unavailable/);
});

test('provider_add/provider_models_add: cost declaration validated and passed through', async () => {
  const added = [];
  const models = {
    addProvider: async (spec) => { added.push(spec); return { provider: spec.provider, model: spec.model }; },
    addModels: async (args) => { added.push(args); return { ok: true, added: args.modelIds } },
  };
  const ch = new HostChannel({ session: fakeSession(), models });

  const ok = await ch.handle({ type: 'provider_add', provider: 'cpa', baseUrl: 'http://127.0.0.1:8317/v1', api: 'openai-completions', model: 'gpt-5.6', cost: { input: 2.5, output: 10 } });
  assert.equal(ok.success, true);
  assert.deepEqual(added.at(-1).cost, { input: 2.5, output: 10 }, 'declared pricing reaches the body');

  const none = await ch.handle({ type: 'provider_add', provider: 'cpa', baseUrl: 'http://x', api: 'openai-completions', model: 'm2' });
  assert.equal(none.success, true);
  assert.equal(added.at(-1).cost, undefined, 'no cost key when undeclared (facade zero-fills)');

  for (const bad of [{ input: -1 }, { output: 'lots' }, ['not-an-object']]) {
    const r = await ch.handle({ type: 'provider_add', provider: 'cpa', baseUrl: 'http://x', api: 'a', model: 'm', cost: bad });
    assert.equal(r.success, false, `bad cost rejected: ${JSON.stringify(bad)}`);
    assert.match(r.error, /cost/);
  }

  // dedup-h #1402 — the self-hosted opt-in flag passes through to the body;
  // absent flag contributes no key (facade never invents an opt-in)
  const priv = await ch.handle({ type: 'provider_add', provider: 'cpa', baseUrl: 'http://127.0.0.1:8317/v1', api: 'a', model: 'm', allowPrivateNetwork: true });
  assert.equal(priv.success, true);
  assert.equal(added.at(-1).allowPrivateNetwork, true);
  const pub = await ch.handle({ type: 'provider_add', provider: 'cpa', baseUrl: 'http://x', api: 'a', model: 'm' });
  assert.equal(pub.success, true);
  assert.equal(added.at(-1).allowPrivateNetwork, undefined);

  const ml = await ch.handle({ type: 'provider_models_add', provider: 'cpa', models: ['a', 'b'], cost: { input: 1 } });
  assert.equal(ml.success, true);
  assert.deepEqual(added.at(-1).cost, { input: 1 });
  const mlBad = await ch.handle({ type: 'provider_models_add', provider: 'cpa', models: ['c'], cost: { input: NaN } });
  assert.equal(mlBad.success, false);
});

test('M144 unicode_mode: ascii tier degrades event symbols, auto/unicode pass through', async (t) => {
  // `auto` resolves from TERM (charset.js: 'dumb'/'cons25' → ascii). The test
  // used to assume the ambient terminal was not dumb — which held on some
  // machines and silently failed on others (a dumb TERM is exactly what a CI
  // runner or a piped shell reports). Control the input instead of inheriting
  // it: the product is right either way, only the expectation was ambient.
  const savedTerm = process.env.TERM;
  process.env.TERM = 'xterm';
  t.after(() => {
    if (savedTerm === undefined) delete process.env.TERM; else process.env.TERM = savedTerm;
  });

  const session = fakeSession();
  const ch = new HostChannel({ session });
  const seen = [];
  ch.subscribe((m) => seen.push(m));
  const fire = (message) => session.listeners.forEach((l) => l({ type: 'notify', message }));

  // default auto resolves unicode when the terminal is capable — symbols pass through
  fire('── done → ok ✓');
  assert.equal(seen.at(-1).event.message, '── done → ok ✓');

  const bad = await ch.handle({ type: 'config_set', key: 'unicode_mode', value: 'emoji' });
  assert.equal(bad.success, false);

  const set = await ch.handle({ type: 'config_set', key: 'unicode_mode', value: 'ascii' });
  assert.equal(set.success, true);
  assert.equal(set.data.charset, 'ascii');
  fire('── done → ok ✓');
  assert.equal(seen.at(-1).event.message, '-- done -> ok ok');
  // CJK content is never stripped — degrade covers chrome only
  fire('完成 ──');
  assert.equal(seen.at(-1).event.message, '完成 --');

  const back = await ch.handle({ type: 'config_set', key: 'unicode_mode', value: 'unicode' });
  assert.equal(back.success, true);
  fire('── again ──');
  assert.equal(seen.at(-1).event.message, '── again ──');

  const g = await ch.handle({ type: 'config_get' });
  assert.equal(g.data.unicode_mode, 'unicode');
});

test('#1392 command_rewrite — wand action routes to the assist facade; fail-closed without one', async () => {
  const bare = new HostChannel({ session: fakeSession() });
  const noFacade = await bare.handle({ type: 'command_rewrite', command: 'rm -rf a', instruction: 'only logs' });
  assert.equal(noFacade.success, false);
  assert.match(noFacade.error, /facade unavailable/);

  const ch = new HostChannel({
    session: fakeSession(),
    assist: {
      rewrite: async ({ command, instruction }) =>
        instruction === 'boom'
          ? { error: 'no model available for command rewrite' }
          : { command: `${command} | head` },
    },
  });
  const ok = await ch.handle({ type: 'command_rewrite', command: 'cat big.log', instruction: 'first lines only' });
  assert.equal(ok.success, true);
  assert.equal(ok.data.command, 'cat big.log | head');
  const err = await ch.handle({ type: 'command_rewrite', command: 'cat big.log', instruction: 'boom' });
  assert.equal(err.success, false);
  assert.match(err.error, /no model available/);
});

test('mcp_resource_read routes to the mcp facade; unavailable facade + refused reads fail honestly', async () => {
  const bare = new HostChannel({ session: fakeSession() });
  const noFacade = await bare.handle({ type: 'mcp_resource_read', server: 'apps', uri: 'ui://x' });
  assert.equal(noFacade.success, false);
  assert.match(noFacade.error, /resource read unavailable/);

  const seen = [];
  const ch = new HostChannel({
    session: fakeSession(),
    mcp: {
      readResource: async (server, uri) => {
        seen.push([server, uri]);
        if (uri === 'ui://ok') return { ok: true, contents: [{ uri, mimeType: 'text/html', text: '<b>hi</b>' }] };
        return { ok: false, error: 'mcp server \'nope\' is not connected' };
      },
    },
  });
  const ok = await ch.handle({ type: 'mcp_resource_read', server: 'apps', uri: 'ui://ok' });
  assert.equal(ok.success, true);
  assert.equal(ok.data.contents[0].mimeType, 'text/html');
  assert.deepEqual(seen, [['apps', 'ui://ok']]);
  const denied = await ch.handle({ type: 'mcp_resource_read', server: 'nope', uri: 'ui://x' });
  assert.equal(denied.success, false);
  assert.match(denied.error, /not connected/);
});

// dedup-h #1978 — project_trust_set scope: 'exact'|'recursive'|'parent'
// validated then passed to the facade; unknown scope degrades to 'exact'.
test('project_trust_set validates scope and passes it to the facade', async () => {
  const calls = [];
  const ch = new HostChannel({
    session: fakeSession(),
    projectTrust: {
      status: () => ({ trusted: false }),
      set: (v, scope) => { calls.push({ v, scope }); return { workdir: '/w', trusted: v, scope }; },
    },
  });
  let r = await ch.handle({ type: 'project_trust_set', trusted: true, scope: 'recursive' });
  assert.equal(r.success, true);
  assert.equal(calls[0].scope, 'recursive');
  r = await ch.handle({ type: 'project_trust_set', trusted: true, scope: 'parent' });
  assert.equal(calls[1].scope, 'parent');
  r = await ch.handle({ type: 'project_trust_set', trusted: true, scope: 'everything!!' });
  assert.equal(calls[2].scope, 'exact', 'unknown scope degrades to exact, never honored raw');
  r = await ch.handle({ type: 'project_trust_set', trusted: true });
  assert.equal(calls[3].scope, 'exact', 'absent scope keeps the default');
  ch.dispose();
});

// dedup-h #2263 — usage_traces: scope defaults to the live session id when
// the facade can name one, explicit scope wins, absent facade fails closed.
test('#2263 usage_traces: session-scope default, explicit scope, facade passthrough', async () => {
  const calls = [];
  const budget = { traces: (o) => { calls.push(o); return { shown: 0, rows: [], cacheHitRate: null, byModel: {} }; } };
  const session = fakeSession();
  session.getState = async () => ({ session: { id: 'sess-9' } });
  const ch = new HostChannel({ session, budget });

  const r = await ch.handle({ type: 'usage_traces' });
  assert.equal(r.success, true);
  assert.deepEqual(calls.at(-1), { scope: 'sess-9', n: undefined }, 'default scope = live session id');

  await ch.handle({ type: 'usage_traces', scope: 'other-scope', n: 5 });
  assert.deepEqual(calls.at(-1), { scope: 'other-scope', n: 5 }, 'explicit scope+n pass through');

  const bare = new HostChannel({ session: fakeSession() });
  const r2 = await bare.handle({ type: 'usage_traces' });
  assert.equal(r2.success, false, 'absent budget facade fails closed');
});
