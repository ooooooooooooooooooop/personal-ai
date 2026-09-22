import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('a junction/symlink pin target pointing outside the workdir is refused and never renders (A1 parity)', (t) => {
  const w = mkdtempSync(join(tmpdir(), 'pai-pins-'));
  const outside = mkdtempSync(join(tmpdir(), 'pai-pins-out-'));
  writeFileSync(join(outside, 'secret.txt'), 'outside-secret-content');
  const link = join(w, 'linked-out');
  try { symlinkSync(outside, link, 'junction'); } catch { t.skip('no symlink privilege'); return; }
  const r = editPins(w, 'add', 'linked-out/secret.txt');
  assert.match(r.error ?? '', /escapes the workdir/, 'junction pin add must refuse');
  // even if the pin was planted directly in pins.json, render skips it
  mkdirSync(join(w, '.pai'), { recursive: true });
  writeFileSync(join(w, '.pai', 'pins.json'), JSON.stringify({ paths: ['linked-out/secret.txt'] }));
  const out = loadPins(w);
  assert.ok(!JSON.stringify(out).includes('outside-secret-content'));
});

test('truncation is visible: oversized pin body and total-cap overflow are marked, never silent', () => {
  const w = mkdtempSync(join(tmpdir(), 'pai-pins-'));
  writeFileSync(join(w, 'big.txt'), 'pin-head\n' + 'x'.repeat(20 * 1024));
  editPins(w, 'add', 'big.txt');
  const out = loadPins(w);
  assert.match(out, /pin-head/);
  assert.match(out, /\[truncated: file exceeds the 16KB per-pin cap\]/);

  const w2 = mkdtempSync(join(tmpdir(), 'pai-pins-'));
  for (let i = 0; i < 6; i++) writeFileSync(join(w2, `p${i}.txt`), `pin-${i}\n` + 'y'.repeat(12 * 1024));
  for (let i = 0; i < 6; i++) editPins(w2, 'add', `p${i}.txt`);
  const out2 = loadPins(w2);
  assert.match(out2, /<pins-truncated>\d+ pinned file\(s\) omitted/);
});

test('pins.json persists atomically — no tmp debris, and a stale pin to a deleted file stays removable', () => {
  const w = mkdtempSync(join(tmpdir(), 'pai-pins-'));
  writeFileSync(join(w, 'a.txt'), 'alpha');
  editPins(w, 'add', 'a.txt');
  assert.ok(!readdirSync(join(w, '.pai')).some((f) => f.includes('.tmp-')), 'no tmp debris');
  rmSync(join(w, 'a.txt'));
  // target gone: realpath cannot resolve — lexical verdict stands, remove works
  assert.deepEqual(editPins(w, 'remove', 'a.txt').paths, []);
});
