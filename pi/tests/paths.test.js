import { lstatSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathInsideRoot, pathInsideRootReal, pathInsideRootForWrite } from '../src/adapter/paths.js';

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
    // A filesystem shim (or a platform without the privilege) can make
    // symlinkSync a SILENT no-op: it does not throw, but no link exists. The
    // try/catch alone would then proceed and fail on a link that isn't there.
    if (!lstatSync(link).isSymbolicLink()) return;
  } catch {
    return; // platform without symlink privilege — lexical checks still hold
  }
  assert.equal(pathInsideRoot(root, link), true);            // lexical: inside
  assert.equal(pathInsideRootReal(root, link), false);       // realpath: escape
  // nonexistent export target stays allowed by the lexical check
  assert.equal(pathInsideRootReal(root, join(root, 'new-export.json')), true);
});

test('M96 export: a symlinked PARENT directory cannot carry a write outside root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-path-'));
  const root = join(dir, 'pai');
  const outside = join(dir, 'outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const escapeDir = join(root, 'escape');
  try {
    symlinkSync(outside, escapeDir, 'dir');
  } catch {
    return; // platform without symlink privilege
  }
  // lexical containment is fooled: root/escape/out.json looks inside
  assert.equal(pathInsideRoot(root, join(escapeDir, 'out.json')), true);
  // write-target check follows the parent link and refuses
  assert.equal(pathInsideRootForWrite(root, join(escapeDir, 'out.json')), false);
  // honest writes still pass: real parent inside, new or existing target
  assert.equal(pathInsideRootForWrite(root, join(root, 'out.json')), true);
  const real = join(root, 'exists.json');
  writeFileSync(real, '{}');
  assert.equal(pathInsideRootForWrite(root, real), true);
  // an existing target that is itself an escape symlink is refused
  const outFile = join(outside, 'stolen.json');
  writeFileSync(outFile, '{}');
  const linkFile = join(root, 'stolen.json');
  try {
    symlinkSync(outFile, linkFile);
    assert.equal(pathInsideRootForWrite(root, linkFile), false);
  } catch { /* no symlink privilege */ }
});
