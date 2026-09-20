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
