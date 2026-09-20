/**
 * M6 pi channel facade — real AgentSession subscribe + real audit file tail.
 * Asserts the facade translates Pi state into plain-data snapshots.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelHost } from '../src/adapter/channel.js';

const fakeSession = () => ({
  calls: [],
  prompt: async (m) => { fakeSessionRef.calls.push(m); },
  steer: async (m) => { fakeSessionRef.calls.push(['steer', m]); },
  abort: async () => { fakeSessionRef.calls.push(['abort']); },
  subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
  model: { provider: 'cpa', id: 'gpt-5.6-luna-max' },
  isStreaming: false,
  messages: [{ role: 'user' }, { role: 'assistant' }],
});
let fakeSessionRef; const listeners = new Set();

test('facade exposes plain-data get_state and dispatches prompt/steer/abort', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(join(auditDir, `${new Date().toISOString().slice(0, 10)}.jsonl`),
    `${JSON.stringify({ kind: 'HOST_STARTED' })}\n${JSON.stringify({ kind: 'TURN_ACCOUNTING', data: { input: 10 } })}\n`);
  const core = { paths: { auditDir } };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core });

  const state = await ch.handle({ type: 'get_state' });
  assert.equal(state.data.model.id, 'gpt-5.6-luna-max');
  assert.equal(state.data.messageCount, 2);

  await ch.handle({ type: 'prompt', message: 'go' });
  assert.deepEqual(fakeSessionRef.calls[0], 'go');

  const tail = await ch.handle({ type: 'audit_tail', n: 1 });
  assert.equal(tail.data[0].kind, 'TURN_ACCOUNTING');
  dispose();
});

test('budget gate: over-limit prompt is refused and billed events emit budget_exceeded', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-budget-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const { BudgetGovernor } = await import('../../host/src/core/budget.js');
  const { AuditWriter } = await import('../../host/src/core/audit.js');
  const audit = new AuditWriter({ auditDir });
  const budget = new BudgetGovernor({
    ledgerPath: join(dir, 'budget-ledger.jsonl'),
    limits: { maxTokensPerSession: 100 },
    audit,
  });
  const core = { paths: { auditDir }, audit };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core, budget });
  fakeSessionRef.sessionId = 's-test';
  fakeSessionRef.sessionManager = { getSessionId: () => 's-test' };

  // bill the session over the cap via a usage-bearing assistant event
  const events = [];
  ch.subscribe((m) => events.push(m));
  for (const l of [...listeners]) l({ type: 'message_end', message: { role: 'assistant', usage: { input: 80, output: 40, cost: { total: 0.01 } } } });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(events.some((m) => m.event?.type === 'budget_exceeded'), 'budget_exceeded emitted');
  assert.ok(fakeSessionRef.calls.some((c) => c[0] === 'abort'), 'run aborted on breach');

  // next prompt is refused at admission — the model never gets to spend more
  const r = await ch.handle({ type: 'prompt', message: 'again' });
  assert.equal(r.success, false);
  assert.match(r.error, /budget/);
  dispose();
});

test('U5 attachments: images ride options.images, media degrade to descriptors', async () => {
  const calls = [];
  fakeSessionRef = fakeSession(); listeners.clear();
  fakeSessionRef.prompt = async (m, o) => calls.push([m, o]);
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-att-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const audit = { events: [], write(e) { this.events.push(e); } };
  const core = { paths: { auditDir }, audit };
  const { channel: ch, dispose } = createChannelHost({ session: fakeSessionRef, core });

  await ch.handle({
    type: 'prompt', message: 'look at these',
    options: { attachments: [
      { name: 'p.png', mime: 'image/png', data: 'aGk=' },
      { name: 's.mp3', mime: 'audio/mpeg', data: 'aGk=' },
      { name: 'bad' }, // rejected — must not eat the prompt
    ] },
  });
  const [msg, opts] = calls[0];
  assert.deepEqual(opts.images, [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }]);
  assert.match(msg, /look at these/);
  assert.match(msg, /<attachment kind="audio" name="s.mp3"/);
  assert.ok(audit.events.some((e) => e.kind === 'ATTACHMENT_REJECTED'));
  dispose();
});

test('fileops_diff and session_btw dispatch to their facades; unavailable surfaces fail closed', async () => {
  fakeSessionRef = fakeSession(); listeners.clear();
  const dir = mkdtempSync(join(tmpdir(), 'pai-chan-ops-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const core = { paths: { auditDir } };
  const calls = [];
  const { channel: ch, dispose } = createChannelHost({
    session: fakeSessionRef, core,
    fileops: { diff: async (n) => (calls.push(['diff', n]), { diffs: [], skipped: [] }) },
    sessions: { btw: async (m) => (calls.push(['btw', m]), { answer: 'side' }) },
  });
  const d = await ch.handle({ type: 'fileops_diff', n: 5 });
  assert.equal(d.success, true);
  const b = await ch.handle({ type: 'session_btw', message: 'side q' });
  assert.equal(b.data.answer, 'side');
  const bad = await ch.handle({ type: 'session_btw' });
  assert.equal(bad.success, false);
  assert.deepEqual(calls, [['diff', 5], ['btw', 'side q']]);
  dispose();

  // no facades → fail closed, not crash
  const bare = createChannelHost({ session: fakeSessionRef, core });
  const r1 = await bare.channel.handle({ type: 'fileops_diff' });
  const r2 = await bare.channel.handle({ type: 'session_btw', message: 'x' });
  assert.equal(r1.success, false);
  assert.equal(r2.success, false);
  bare.dispose();
});
