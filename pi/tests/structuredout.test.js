/** dedup-h #238 — structured output gate: armed schema → agent_end
 * conformance check → bounded re-steer on violation; conforming/exhausted
 * verdict disarms and falls through to normal flow. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loopGovernanceExtension } from '../src/adapter/loop.js';

const rig = (schema) => {
  const events = {};
  const sent = [];
  const auditEvents = [];
  const structured = { schema, retries: 0, maxRetries: 2 };
  const pi = {
    on: (n, fn) => { events[n] = fn; },
    setModel: async () => true,
  };
  loopGovernanceExtension({
    audit: { write: (e) => auditEvents.push(e) },
    fallbacks: { chain: [] },
    structured,
  }).factory(pi);
  return { events, sent, auditEvents, structured };
};

test('structured output: violation re-steers bounded, conforming disarms', async () => {
  const { events, sent, auditEvents, structured } = rig({
    type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } }, additionalProperties: false,
  });
  // wire the shared sent list into the ctx used by end()
  const ctx = { sendUserMessage: (t) => sent.push(t), model: null, modelRegistry: null };
  const run = async (text) => {
    events.agent_start();
    await events.agent_end(
      { messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] }] },
      ctx,
    );
  };

  await run('sure! here is your answer'); // not JSON
  assert.equal(sent.length, 1, 'violation re-steers');
  assert.match(sent[0], /structured-output/);
  assert.equal(structured.retries, 1);
  assert.equal(structured.schema != null, true, 'schema stays armed during retries');

  await run('{"ok":true}'); // conforms
  assert.equal(sent.length, 1, 'conforming answer needs no steer');
  assert.equal(structured.schema, null, 'conforming verdict disarms');
  assert.ok(auditEvents.some((e) => e.kind === 'STRUCTURED_OUTPUT' && e.data.ok === true));
});

test('structured output: retries exhausted disarms + audits honestly', async () => {
  const { events, sent, auditEvents, structured } = rig({ type: 'array' });
  const ctx = { sendUserMessage: (t) => sent.push(t), model: null, modelRegistry: null };
  const run = async (text) => {
    events.agent_start();
    await events.agent_end(
      { messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] }] },
      ctx,
    );
  };
  await run('nope'); await run('still nope'); await run('nope again');
  assert.equal(sent.length, 2, 'two retries max');
  assert.equal(structured.schema, null, 'exhausted verdict disarms');
  assert.ok(auditEvents.some((e) => e.kind === 'STRUCTURED_OUTPUT' && e.data.exhausted === true));
});
