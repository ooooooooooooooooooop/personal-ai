/** dedup-h #333 — backup create/verify: allowlisted durable state +
 * sha256 manifest; secrets excluded; tampering detected honestly. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackup, verifyBackup } from '../src/core/backup.js';

const rig = () => {
  const inst = mkdtempSync(join(tmpdir(), 'pai-bk-'));
  mkdirSync(join(inst, 'sessions'), { recursive: true });
  mkdirSync(join(inst, 'memory'), { recursive: true });
  writeFileSync(join(inst, 'registry.json'), '{"bodies":{"pi":{}}}');
  writeFileSync(join(inst, 'sessions', 's1.jsonl'), '{"type":"session","id":"s1"}\n');
  writeFileSync(join(inst, 'memory', 'm1.json'), '{"facts":1}');
  writeFileSync(join(inst, 'auth.json'), '{"key":"secret"}'); // must NOT be bundled
  writeFileSync(join(inst, 'mcp-oauth.json'), '{"t":"x"}');   // must NOT be bundled
  return inst;
};

test('backup create: allowlisted state bundled, secrets excluded + recorded', () => {
  const inst = rig();
  const r = createBackup(inst);
  assert.ok(existsSync(join(r.dir, 'backup-manifest.json')));
  assert.ok(existsSync(join(r.dir, 'sessions', 's1.jsonl')));
  assert.ok(existsSync(join(r.dir, 'memory', 'm1.json')));
  assert.ok(existsSync(join(r.dir, 'registry.json')));
  assert.ok(!existsSync(join(r.dir, 'auth.json')), 'secret file must not be bundled');
  assert.ok(!existsSync(join(r.dir, 'mcp-oauth.json')));
  assert.ok(r.skippedSecrets.length >= 2, 'exclusions recorded honestly');
});

test('backup verify: intact passes; missing/mismatch/extra all reported', () => {
  const inst = rig();
  const { dir } = createBackup(inst);
  assert.equal(verifyBackup(dir).ok, true);
  // tamper: modify, delete, add
  writeFileSync(join(dir, 'memory', 'm1.json'), '{"facts":2}');
  rmSync(join(dir, 'registry.json'));
  writeFileSync(join(dir, 'rogue.txt'), 'x');
  const v = verifyBackup(dir);
  assert.equal(v.ok, false);
  assert.deepEqual(v.missing, ['registry.json']);
  assert.deepEqual(v.mismatched, ['memory/m1.json']);
  assert.deepEqual(v.extra, ['rogue.txt']);
});

test('verify on a mangled manifest fails honestly, never throws', () => {
  const inst = rig();
  const { dir } = createBackup(inst);
  writeFileSync(join(dir, 'backup-manifest.json'), '{oops');
  const v = verifyBackup(dir);
  assert.equal(v.ok, false);
  assert.match(v.error, /manifest unreadable/);
});
