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

// recent() tail-reads a bounded window instead of scanning the whole file: the
// context provider calls it EVERY turn and the loop appends a row per tool
// result, so the fingerprint cache misses every turn and a full scan would put
// an O(file) synchronous read on the hot path. These guard the edge cases the
// tail-read introduces (a window that starts mid-row, and a window too small to
// hold `limit` rows).
test('recent() is correct on a large file (tail window starts mid-row)', () => {
  const { dir, observations } = store();
  const lines = [];
  for (let i = 0; i < 5000; i++) {
    lines.push(JSON.stringify({ id: `obs-${i}`, kind: 'tool_result', subject: `t-${i}`, at: i }));
  }
  appendFileSync(join(dir, 'observations', 'observations.jsonl'), `${lines.join('\n')}\n`);
  const recent = observations.recent(20);
  assert.equal(recent.length, 20);
  assert.equal(recent[0].subject, 't-4980');
  assert.equal(recent.at(-1).subject, 't-4999');
});

test('recent() grows the window when rows are larger than the initial window', () => {
  const { observations } = store();
  // one row carries a ~200 KB detail — far beyond the 64 KB initial window
  observations.record({ kind: 'tool_result', subject: 'huge', detail: { tail: 'x'.repeat(200 * 1024) } });
  for (let i = 0; i < 5; i++) observations.record({ kind: 'tool_result', subject: `after-${i}` });
  const recent = observations.recent(6);
  assert.equal(recent.length, 6);
  assert.equal(recent[0].subject, 'huge');
  assert.equal(recent.at(-1).subject, 'after-4');
});

test('recent() on an absent file is empty, and list() still reports the full count', () => {
  const { dir, observations } = store();
  assert.deepEqual(observations.recent(20), []);
  for (let i = 0; i < 30; i++) observations.record({ kind: 'tool_result', subject: `t-${i}` });
  assert.equal(observations.recent(5).length, 5);
  assert.equal(observations.list().length, 30); // list() keeps the exact count
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
