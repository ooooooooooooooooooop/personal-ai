/**
 * D08 C21-b defect A regression — `abort` deadlocked whenever the turn was
 * parked in an ask.
 *
 * Field evidence (run-20261023-1030): a turn blocked inside
 * `request_permission`'s `await asks.ask()`; `abort` returned
 * `ms=60034 success=false 'body command timed out'` and the turn kept
 * streaming (69 -> 185 events, messageCount 18 -> 23) because the facade
 * awaited `box.s.abort()` BEFORE releasing the ask that the turn was parked
 * on — and afterToolCall never runs while the tool is still awaiting.
 *
 * The fake session below encodes exactly that dependency: `abort()` does not
 * resolve until the pending ask is released. Order is therefore the whole
 * subject of this test — with the old order it cannot resolve at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChannelHost } from '../src/adapter/channel.js';

const fakeSession = () => ({
  prompt: async () => {},
  steer: async () => {},
  abort: async () => {},
  subscribe: () => () => {},
  model: { provider: 'p', id: 'm' },
  isStreaming: false,
  messages: [],
});

test('abort releases a pending ask BEFORE waiting for the turn', async () => {
  const session = fakeSession();
  const order = [];
  let released = false;
  const parked = []; // resolvers that only fire when the ask is released

  const asks = {
    ask: () => new Promise((resolve) => { parked.push(resolve); }),
    abortPending: () => {
      order.push('abortPending');
      released = true;
      for (const resolve of parked.splice(0)) resolve('aborted');
    },
  };

  // The turn is parked in asks.ask(); the session can only finish aborting
  // once that ask is released — i.e. the abort signal alone cannot free it.
  session.abort = () => new Promise((resolve) => {
    order.push('session.abort');
    if (released) { resolve(); return; }
    parked.push(resolve);
  });

  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-abort-'));
  const { channel: ch, dispose } = createChannelHost({
    session,
    core: { paths: { root: dir, auditDir: join(dir, 'audit') } },
    asks,
  });

  const outcome = await Promise.race([
    ch.handle({ type: 'abort' }).then(() => 'resolved'),
    new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 400)),
  ]);

  assert.notEqual(
    outcome,
    'TIMEOUT',
    'abort must not wait on a turn that can only end after its ask is released',
  );
  assert.deepEqual(
    order,
    ['abortPending', 'session.abort'],
    'the ask must be released first, then the session aborted',
  );
  dispose();
});
