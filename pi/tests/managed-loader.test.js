import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveManagedExtensions } from '../src/extensions/loader.js';

function ext(content = 'export default () => {}') {
  const dir = mkdtempSync(join(tmpdir(), 'pai-ext-'));
  const rel = 'ext/sample.js';
  mkdirSync(join(dir, 'ext'), { recursive: true });
  writeFileSync(join(dir, rel), content);
  return { dir, rel, sha: createHash('sha256').update(content).digest('hex') };
}

test('managed loader verifies sha256 and returns ordered paths', () => {
  const { dir, rel, sha } = ext();
  const manifest = {
    version: 1,
    extensions: [{ id: 'sample', path: rel, sha256: sha }],
  };
  const out = resolveManagedExtensions(manifest, { baseDir: dir });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'sample');
  assert.ok(out[0].path.endsWith('sample.js'));
});

test('hash mismatch fails closed — tampered extension never loads', () => {
  const { dir, rel } = ext('tampered');
  const manifest = {
    version: 1,
    extensions: [{ id: 'sample', path: rel, sha256: '0'.repeat(64) }],
  };
  assert.throws(
    () => resolveManagedExtensions(manifest, { baseDir: dir }),
    /integrity mismatch/,
  );
});
