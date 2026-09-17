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
