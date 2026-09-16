import { mkdtempSync, mkdirSync } from 'node:fs';
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
