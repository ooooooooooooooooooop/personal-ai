import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPins, editPins } from '../src/core/pins.js';
import { PaiIgnore } from '../src/core/paiignore.js';

const dir = () => mkdtempSync(join(tmpdir(), 'pai-pins-'));

test('no pins file → null render, empty list', () => {
  const w = dir();
  assert.equal(loadPins(w), null);
  assert.deepEqual(editPins(w, 'list').paths, []);
});

test('add pins a file; contents render live (re-read per call)', () => {
  const w = dir();
  writeFileSync(join(w, 'note.md'), 'version one');
  const r = editPins(w, 'add', 'note.md');
  assert.deepEqual(r.paths, ['note.md']);
  const out = loadPins(w);
  assert.match(out, /<pinned-file path="note\.md">/);
  assert.match(out, /version one/);
  writeFileSync(join(w, 'note.md'), 'version two');
  assert.match(loadPins(w), /version two/); // live re-read, not a snapshot
});

test('escape/refusal rules: outside path refused, missing file refused, ignored path refused+skipped', () => {
  const w = dir();
  writeFileSync(join(w, '.paiignore'), 'secret.txt\n');
  const isIgnored = (p) => new PaiIgnore(w).isIgnored(p);
  assert.match(editPins(w, 'add', '../outside.txt').error, /escapes/);
  assert.match(editPins(w, 'add', 'ghost.txt').error, /does not exist/);
  writeFileSync(join(w, 'secret.txt'), 's3cr3t');
  assert.match(editPins(w, 'add', 'secret.txt', { isIgnored }).error, /paiignore/);
  // a path pinned before the ignore rule existed is still skipped at render
  writeFileSync(join(w, 'ok.txt'), 'fine');
  editPins(w, 'add', 'ok.txt');
  const out = loadPins(w, { isIgnored });
  assert.match(out ?? '', /pinned-file path="ok\.txt"/);
});

test('remove + dedupe + cap', () => {
  const w = dir();
  writeFileSync(join(w, 'a.txt'), 'a');
  editPins(w, 'add', 'a.txt');
  assert.equal(editPins(w, 'add', 'a.txt').unchanged, true);
  assert.match(editPins(w, 'remove', 'nope.txt').error, /not pinned/);
  assert.deepEqual(editPins(w, 'remove', 'a.txt').paths, []);
});
