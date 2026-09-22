/**
 * sessionManagers open/remove confinement — a crafted path must never make
 * an outside file the live session store (open) or the unlink target
 * (remove). Lexical startsWith is not enough: junctions inside sessionDir
 * resolve outside (A1 realpath parity).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sessionManagers } from '../src/adapter/index.js';

test('sessionManagers: a junction inside sessionDir pointing outside is refused for open AND remove', (t) => {
  const sd = mkdtempSync(join(tmpdir(), 'pai-sm-'));
  const outside = mkdtempSync(join(tmpdir(), 'pai-sm-out-'));
  writeFileSync(join(outside, 's1.jsonl'), '{"message":{"role":"user","content":"x"}}\n');
  const linkDir = join(sd, 'linked');
  try { symlinkSync(outside, linkDir, 'junction'); } catch { t.skip('no symlink privilege'); return; }
  const viaLink = join(linkDir, 's1.jsonl'); // lexically inside, really outside
  assert.throws(() => sessionManagers.remove(viaLink, sd), /outside sessionDir/);
  assert.ok(existsSync(join(outside, 's1.jsonl')), 'refused remove must not unlink the outside file');
  assert.throws(() => sessionManagers.open(viaLink, sd), /outside sessionDir/);
});

test('sessionManagers: lexical traversal and unresolvable paths both refuse closed', () => {
  const sd = mkdtempSync(join(tmpdir(), 'pai-sm-'));
  assert.throws(() => sessionManagers.remove(join(sd, '..', 'x.jsonl'), sd), /outside sessionDir/);
  assert.throws(() => sessionManagers.open(join(sd, '..', 'x.jsonl'), sd), /outside sessionDir/);
  // passes the lexical gate but does not exist — realpath fails closed
  assert.throws(() => sessionManagers.remove(join(sd, 'missing.jsonl'), sd), /unresolvable/);
});
