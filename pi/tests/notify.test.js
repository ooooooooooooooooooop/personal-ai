import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyUserTool } from '../src/adapter/notify.js';

const make = (emit) => notifyUserTool(() => emit);

test('notify_user emits a notify event without suspending the turn', async () => {
  const sent = [];
  const tool = make((ev) => sent.push(ev));
  const r = await tool.execute('n1', { message: 'build finished', level: 'warn' });
  assert.equal(r.isError, undefined);
  assert.deepEqual(sent, [{ type: 'notify', message: 'build finished', level: 'warn' }]);
});

test('notify_user: empty message errors; unknown level falls back to info', async () => {
  const sent = [];
  const tool = make((ev) => sent.push(ev));
  const bad = await tool.execute('n2', { message: '   ' });
  assert.equal(bad.isError, true);
  assert.equal(sent.length, 0);
  const ok = await tool.execute('n3', { message: 'hi', level: 'bogus' });
  assert.equal(ok.isError, undefined);
  assert.equal(sent[0].level, 'info');
});

test('notify_user fails closed when the channel is not ready', async () => {
  const tool = notifyUserTool(() => null);
  const r = await tool.execute('n4', { message: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /unavailable/);
});

test('notify_user truncates oversize messages', async () => {
  const sent = [];
  const tool = make((ev) => sent.push(ev));
  await tool.execute('n5', { message: 'x'.repeat(900) });
  assert.equal(sent[0].message.length, 500);
});
