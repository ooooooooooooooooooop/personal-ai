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
