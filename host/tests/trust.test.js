import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTrusted, setTrust, hasInjectableContent } from '../src/core/trust.js';

const dir = () => mkdtempSync(join(tmpdir(), 'pai-trust-'));

test('absent or malformed trust file → untrusted (fail-closed)', () => {
  const inst = dir(); const w = dir();
  assert.equal(isTrusted(inst, w), false);
  writeFileSync(join(inst, 'project-trust.json'), '{not json');
  assert.equal(isTrusted(inst, w), false);
  writeFileSync(join(inst, 'project-trust.json'), JSON.stringify({ workdirs: { [w]: 'yes' } }));
  assert.equal(isTrusted(inst, w), false); // only literal true counts
});

test('setTrust round-trips per workdir; false removes the grant', () => {
  const inst = dir(); const w1 = dir(); const w2 = dir();
  assert.deepEqual(setTrust(inst, w1, true), { workdir: w1, trusted: true });
  assert.equal(isTrusted(inst, w1), true);
  assert.equal(isTrusted(inst, w2), false); // grant is per-workdir
  setTrust(inst, w2, true);
  setTrust(inst, w1, false);
  assert.equal(isTrusted(inst, w1), false);
  assert.equal(isTrusted(inst, w2), true);
});

test('hasInjectableContent only true when .pai/microagents/*.md exists', () => {
  const w = dir();
  assert.equal(hasInjectableContent(w), false);
  mkdirSync(join(w, '.pai', 'microagents'), { recursive: true });
  assert.equal(hasInjectableContent(w), false); // empty dir
  writeFileSync(join(w, '.pai', 'microagents', 'deploy.md'), '---\ntriggers: [deploy]\n---\nnotes');
  assert.equal(hasInjectableContent(w), true);
});
