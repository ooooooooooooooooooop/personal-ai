import test from 'node:test';
import assert from 'node:assert/strict';
import { askStructuredTool } from '../src/adapter/askuser.js';
import { PendingAsks } from '../../host/src/core/asks.js';

const mk = () => {
  const asks = new PendingAsks({ timeoutMs: 5000 });
  const tool = askStructuredTool(() => asks);
  return { asks, tool };
};
const FIELDS = [
  { key: 'env', label: '环境', type: 'select', options: ['dev', 'prod'], required: true },
  { key: 'count', type: 'number' },
];

// candidates-open dedup-h #33: schema→form structured ask — the tool declares
// fields, the pending ask carries them, the answer resolves to an object.
test('ask_structured: invalid schemas refused at admission', async () => {
  const { tool } = mk();
  const bad = async (fields, re) => {
    const r = await tool.execute('c1', { fields });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, re);
  };
  await bad([], /1-12 fields/);
  await bad([{ key: 'a', type: 'text' }, { key: 'a', type: 'text' }], /duplicate field key/);
  await bad([{ key: 'a', type: 'wizard' }], /unknown type/);
  await bad([{ key: 'a', type: 'select' }], /requires options/);
  await bad([{ type: 'text' }], /non-empty key/);
});

test('ask_structured: valid schema suspends on a form ask; object answer returns', async () => {
  const { asks, tool } = mk();
  const p = tool.execute('c1', { title: '部署参数', fields: FIELDS });
  await new Promise((r) => setTimeout(r, 30));
  const pend = asks.list()[0];
  assert.equal(pend.kind, 'form');
  assert.equal(pend.summary, '部署参数');
  assert.equal(pend.fields.length, 2);
  const ok = asks.resolve(pend.id, { env: 'prod', count: 3 });
  assert.equal(ok.ok, true);
  const r = await p;
  assert.equal(r.isError, undefined);
  assert.deepEqual(r.details.answer, { env: 'prod', count: 3 });
  assert.match(r.content[0].text, /prod/);
});

test('ask_structured: timeout maps to an honest unanswered result', async () => {
  const asks = new PendingAsks({ timeoutMs: 20 });
  const tool = askStructuredTool(() => asks);
  const r = await tool.execute('c1', { fields: FIELDS });
  assert.match(r.content[0].text, /unanswered|did not answer/);
});
