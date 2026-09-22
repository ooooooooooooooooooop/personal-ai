import { mkdtempSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ObservationStore } from '../src/core/observation.js';
import { buildContextEnvelope, renderContext } from '../src/core/envelopes.js';

function store() {
  const dir = join(mkdtempSync(join(tmpdir(), 'pai-obs-')), 'canonical');
  mkdirSync(dir, { recursive: true });
  return { dir, observations: new ObservationStore(dir) };
}

test('observations append to canonical and survive reopen', () => {
  const { dir, observations } = store();
  observations.record({ kind: 'tool_result', subject: 'bash', detail: { isError: false }, actor: 'pi' });
  observations.record({ kind: 'runtime_fact', subject: 'cwd', detail: { path: '/x' } });
  const reopened = new ObservationStore(dir);
  assert.equal(reopened.list().length, 2);
  assert.equal(reopened.list()[0].subject, 'bash');
});

test('recent() bounds the projection window', () => {
  const { observations } = store();
  for (let i = 0; i < 25; i++) {
    observations.record({ kind: 'tool_result', subject: `tool-${i}` });
  }
  const recent = observations.recent(20);
  assert.equal(recent.length, 20);
  assert.equal(recent.at(-1).subject, 'tool-24');
  assert.equal(recent[0].subject, 'tool-5'); // window slid — oldest dropped
});

test('context envelope renders observation subjects into the channel text', () => {
  const env = buildContextEnvelope({
    briefing: 'b',
    observations: [{ kind: 'tool_result', subject: 'edit', detail: { isError: false } }],
  });
  const text = renderContext(env);
  assert.ok(text.includes('<observations>'));
  assert.ok(text.includes('[tool_result] edit'));
});

test('read-path cache invalidates on external append (cross-process writer) and tolerates a torn tail row', () => {
  const { dir, observations } = store();
  observations.record({ kind: 'tool_result', subject: 'first' });
  assert.equal(observations.list().length, 1); // populates the cache
  assert.equal(observations.list().length, 1); // cache hit
  // a delegate child (separate process) appends directly to the shared file
  appendFileSync(join(dir, 'observations', 'observations.jsonl'),
    `${JSON.stringify({ id: 'obs-ext', kind: 'tool_result', subject: 'external', at: 1 })}\n`);
  const rows = observations.list();
  assert.equal(rows.length, 2);
  assert.equal(rows.at(-1).subject, 'external');
  // a torn final row (crash mid-append) is skipped, not fatal
  appendFileSync(join(dir, 'observations', 'observations.jsonl'), '{"id":"obs-torn","kind":');
  assert.equal(observations.list().length, 2);
});

test('M5 parity: subject + detail are secret-scrubbed before landing in the durable JSONL', () => {
  const { dir, observations } = store();
  const key = `sk-${'a'.repeat(24)}`;
  observations.record({ kind: 'tool_result', subject: `fetch with ${key}`, detail: { out: `token ${key}`, n: 1 } });
  const raw = readFileSync(join(dir, 'observations', 'observations.jsonl'));
  assert.ok(!raw.includes(key), 'secret-shaped span must not reach disk');
  const row = observations.list().at(-1);
  assert.match(row.subject, /\[REDACTED:openai_key\]/);
  assert.match(row.detail.out, /\[REDACTED:openai_key\]/);
  assert.equal(row.detail.n, 1); // structure preserved
});
