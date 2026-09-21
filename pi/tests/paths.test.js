import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathInsideRoot, pathInsideRootReal } from '../src/adapter/paths.js';

test('M96: containment is real — sibling-prefix paths do not pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-path-'));
  const root = join(dir, 'pai');
  mkdirSync(root, { recursive: true });
  // the classic escape: root '/x/pai' must NOT accept '/x/pai-evil/...'
  assert.equal(pathInsideRoot(root, join(dir, 'pai-evil', 'x.json')), false);
  assert.equal(pathInsideRoot(root, join(dir, 'pai', 'x.json')), true);
  assert.equal(pathInsideRoot(root, root), true);
  assert.equal(pathInsideRoot(root, join(root, '..', 'pai-evil', 'x.json')), false);
  assert.equal(pathInsideRoot(root, join(root, 'sub', '..', 'x.json')), true);
  assert.equal(pathInsideRoot(root, join(root, '..', '..', 'outside.json')), false);
});

test('M96: an in-root symlink pointing outside fails the real-path check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-path-'));
  const root = join(dir, 'pai');
  const outside = join(dir, 'secret.json');
  mkdirSync(root, { recursive: true });
  writeFileSync(outside, '{}');
  const link = join(root, 'linked.json');
  try {
    symlinkSync(outside, link);
  } catch {
    return; // platform without symlink privilege — lexical checks still hold
  }
  assert.equal(pathInsideRoot(root, link), true);            // lexical: inside
  assert.equal(pathInsideRootReal(root, link), false);       // realpath: escape
  // nonexistent export target stays allowed by the lexical check
  assert.equal(pathInsideRootReal(root, join(root, 'new-export.json')), true);
});
