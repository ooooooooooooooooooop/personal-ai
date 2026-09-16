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
