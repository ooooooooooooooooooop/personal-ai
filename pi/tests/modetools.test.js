import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modeRequestTool } from '../src/adapter/modetools.js';

const fixture = ({ catalog = ['normal', 'plan', 'review', 'careful'], answer = 'allow', applyResult = { mode: 'plan' }, noAsks = false } = {}) => {
  const calls = { asked: null, applied: [] };
  const tool = modeRequestTool({
    catalogModes: () => catalog,
    applyMode: (n) => { calls.applied.push(n); return applyResult; },
    asks: noAsks ? null : { ask: async (a) => { calls.asked = a; return answer; } },
  });
  return { tool, calls };
};

test('operator allow → applyMode through the governed path', async () => {
  const { tool, calls } = fixture();
  const r = await tool.execute('c1', { name: 'plan', reason: 'design first' });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /switched to 'plan'/);
  assert.deepEqual(calls.applied, ['plan']);
  assert.equal(calls.asked.toolName, 'mode_request');
  assert.equal(calls.asked.detail, 'design first');
});

test('deny/timeout verdicts refuse — mode never applied', async () => {
  for (const answer of ['deny', 'timeout', 'aborted']) {
    const { tool, calls } = fixture({ answer });
    const r = await tool.execute('c', { name: 'plan' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /refused/);
    assert.deepEqual(calls.applied, []);
  }
});

test('unknown mode rejected before any ask; no operator channel → error', async () => {
  const { tool, calls } = fixture();
  const bad = await tool.execute('c', { name: 'yolo' });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /unknown mode/);
  assert.equal(calls.asked, null); // catalog check precedes the ask

  const noAsks = fixture({ noAsks: true }).tool;
  const r = await noAsks.execute('c', { name: 'plan' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no operator channel/);
});

// ---- request_permission (Codex request_permissions analogue) ----
import { requestPermissionTool } from '../src/adapter/modetools.js';

const permFixture = ({ answer = 'allow', noAsks = false } = {}) => {
  const calls = { asked: null, granted: [] };
  const tool = requestPermissionTool({
    asks: noAsks ? null : {
      ask: async (a) => { calls.asked = a; return answer; },
      grantSession: (t) => calls.granted.push(t),
    },
  });
  return { tool, calls };
};

test('request_permission: operator allow grants the tool session-wide', async () => {
  const { tool, calls } = permFixture({ answer: 'allow' });
  const r = await tool.execute('c1', { tool: 'bash', reason: 'many build commands' });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /allowed for this session/);
  assert.deepEqual(calls.granted, ['bash']);
  assert.equal(calls.asked.rule, 'permission_request');
});

test('request_permission: refusal never grants; missing channel errors', async () => {
  for (const answer of ['deny', 'timeout', 'aborted']) {
    const { tool, calls } = permFixture({ answer });
    const r = await tool.execute('c', { tool: 'write_file' });
    assert.equal(r.isError, true);
    assert.deepEqual(calls.granted, []);
  }
  const { tool } = permFixture({ noAsks: true });
  const r2 = await tool.execute('c', { tool: 'bash' });
  assert.equal(r2.isError, true);
  assert.match(r2.content[0].text, /no operator channel/);
});

test('dedup-h #146: requestModelSwitch asks → model_set via channel; denial refuses', async () => {
  const { requestModelSwitch } = await import('../src/adapter/modetools.js');
  const sent = [];
  const asksAllow = { ask: async (a) => { sent.push(a); return 'allow'; } };
  const chan = async (cmd) => { sent.push(cmd); return { success: true }; };
  const r = await requestModelSwitch({ spec: 'fake/fake-2', asks: asksAllow, runChannel: chan, toolCallId: 'tc9' });
  assert.equal(r.ok, true);
  assert.deepEqual(sent[0].args, { model: 'fake/fake-2' });
  assert.deepEqual(sent[1], { type: 'model_set', provider: 'fake', model: 'fake-2' });

  // alias spec (no slash) → alias command shape
  const sent2 = [];
  await requestModelSwitch({ spec: 'work-cheap', asks: asksAllow, runChannel: async (c) => { sent2.push(c); return { success: true }; } });
  assert.deepEqual(sent2[0], { type: 'model_set', alias: 'work-cheap' });

  // denial never dispatches model_set
  const sent3 = [];
  const r2 = await requestModelSwitch({
    spec: 'x/y', asks: { ask: async () => 'deny' },
    runChannel: async (c) => { sent3.push(c); return { success: true }; },
  });
  assert.equal(r2.ok, false);
  assert.match(r2.text, /refused \(deny\)/);
  assert.equal(sent3.length, 0);

  // no operator channel / no dispatch → honest failure, never silent
  const r3 = await requestModelSwitch({ spec: 'x/y', asks: null, runChannel: chan });
  assert.equal(r3.ok, false);
  assert.match(r3.text, /no operator channel/);
  const r4 = await requestModelSwitch({ spec: 'x/y', asks: asksAllow, runChannel: null });
  assert.equal(r4.ok, false);
  assert.match(r4.text, /no channel dispatch/);

  // failed model_set surfaces the channel error
  const r5 = await requestModelSwitch({
    spec: 'x/y', asks: asksAllow,
    runChannel: async () => ({ success: false, error: 'model not registered' }),
  });
  assert.equal(r5.ok, false);
  assert.match(r5.text, /model not registered/);
});
