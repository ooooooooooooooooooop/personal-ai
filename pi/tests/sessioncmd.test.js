import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionCommandTool } from '../src/adapter/sessioncmd.js';

const make = (emit) => sessionCommandTool(() => emit);

test('session_command emits command_request and acks deferred execution', async () => {
  const sent = [];
  const tool = make((ev) => sent.push(ev));
  const r = await tool.execute('c1', { name: 'model', arg: 'fake/fake-1' });
  assert.equal(r.isError, undefined);
  assert.deepEqual(sent, [{ type: 'command_request', name: 'model', arg: 'fake/fake-1' }]);
  assert.match(r.content[0].text, /when this turn ends/);
});

test('session_command whitelist: unknown names are refused before emitting', async () => {
  const sent = [];
  const tool = make((ev) => sent.push(ev));
  const r = await tool.execute('c2', { name: 'exec' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /allowed: clear, model, resume, config, new/);
  assert.equal(sent.length, 0);
});

test('session_command covers the five builtin commands', async () => {
  const sent = [];
  const tool = make((ev) => sent.push(ev));
  for (const name of ['clear', 'model', 'resume', 'config', 'new']) {
    const r = await tool.execute(`c-${name}`, { name, arg: '' });
    assert.equal(r.isError, undefined, name);
  }
  assert.deepEqual(sent.map((e) => e.name), ['clear', 'model', 'resume', 'config', 'new']);
});

test('session_command fails closed with no operator surface', async () => {
  const tool = sessionCommandTool(() => null);
  const r = await tool.execute('c3', { name: 'clear' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no operator surface/);
});

test('session_command bounds the arg it forwards', async () => {
  const sent = [];
  const tool = make((ev) => sent.push(ev));
  await tool.execute('c4', { name: 'config', arg: 'x'.repeat(500) });
  assert.equal(sent[0].arg.length, 300);
});

// dedup-h #571: 'new' (Cline new_task) — a fresh session whose first message
// is the model's context-handoff briefing, capped at 1000 not 300.
test('session_command new carries the handoff briefing at the wider cap', async () => {
  const sent = [];
  const tool = make((ev) => sent.push(ev));
  const r = await tool.execute('c5', { name: 'new', arg: 'continue: fix parser, see src/parse.js' });
  assert.equal(r.isError, undefined);
  assert.deepEqual(sent, [{ type: 'command_request', name: 'new', arg: 'continue: fix parser, see src/parse.js' }]);
  sent.length = 0;
  await tool.execute('c6', { name: 'new', arg: 'y'.repeat(1500) });
  assert.equal(sent[0].arg.length, 1000);
});
