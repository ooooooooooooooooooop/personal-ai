/** dedup-h #333 — backup create/verify: allowlisted durable state +
 * sha256 manifest; secrets excluded; tampering detected honestly. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackup, verifyBackup, listBackups, restoreBackup } from '../src/core/backup.js';

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

// ── dedup-h #544: sqlite snapshots + list + restore ─────────────────────

test('sqlite state gets a consistent VACUUM snapshot, not a raw byte copy', async () => {
  const inst = rig();
  mkdirSync(join(inst, 'jobs'), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(inst, 'jobs', 'durable_jobs.db'));
  db.exec('CREATE TABLE jobs (id TEXT, state TEXT)');
  db.exec("INSERT INTO jobs VALUES ('j1','RUNNING')");
  db.close();
  const r = createBackup(inst);
  const entry = r.manifest.files.find((f) => f.path === 'jobs/durable_jobs.db');
  assert.ok(entry, 'sqlite db bundled');
  assert.ok(!entry.rawCopy, 'consistent snapshot, not a raw byte copy');
  // the bundled image is a REAL database with the rows
  const check = new DatabaseSync(join(r.dir, 'jobs', 'durable_jobs.db'));
  assert.equal(check.prepare('SELECT state FROM jobs WHERE id=?').get('j1').state, 'RUNNING');
  check.close();
});

test('backup list reads manifests newest-first; unreadable flagged', () => {
  const inst = rig();
  const a = createBackup(inst);
  writeFileSync(join(inst, 'commands.json'), '{"x":1}');
  const b = createBackup(inst);
  const rows = listBackups(join(inst, 'backups'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].dir, b.dir, 'newest first');
  assert.ok(rows.every((r) => r.manifestOk && typeof r.files === 'number'));
  writeFileSync(join(a.dir, 'backup-manifest.json'), '{oops');
  assert.equal(listBackups(join(inst, 'backups')).find((r) => r.dir === a.dir).manifestOk, false);
});

test('restore: verified bundle round-trips; existing state refuses without force; force snapshots first', () => {
  const inst = rig();
  const { dir } = createBackup(inst);
  // drift the live state, then restore the bundle over it
  writeFileSync(join(inst, 'registry.json'), '{"bodies":{"pi":{},"other":{}}}');
  const refuse = restoreBackup(dir, inst);
  assert.equal(refuse.ok, false, 'existing state must not be clobbered silently');
  assert.ok(refuse.existing.includes('registry.json'));
  const r = restoreBackup(dir, inst, { force: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.preRestore, 'pre-restore snapshot taken before clobbering');
  assert.ok(existsSync(join(r.preRestore, 'backup-manifest.json')));
  assert.equal(readFileSync(join(inst, 'registry.json'), 'utf-8'), '{"bodies":{"pi":{}}}');
});

test('restore refuses a corrupt bundle and a path-escaping manifest', async () => {
  const inst = rig();
  const { dir } = createBackup(inst);
  writeFileSync(join(dir, 'registry.json'), '{"tampered":true}');
  const inst2 = mkdtempSync(join(tmpdir(), 'pai-bk-restore-'));
  const r = restoreBackup(dir, inst2, { force: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /failed verification/);

  // forged manifest: '../escape.txt' resolves OUTSIDE the bundle dir, but
  // if that outside file exists with a matching hash verify still passes —
  // so restore's own path-confinement is the gate that must bite.
  const dir2 = mkdtempSync(join(tmpdir(), 'pai-bk-forged-'));
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update('x').digest('hex');
  writeFileSync(join(dir2, '..', 'escape.txt'), 'x'); // sits beside dir2 → '../escape.txt' resolves here
  writeFileSync(join(dir2, 'backup-manifest.json'), JSON.stringify({
    version: 1, files: [{ path: '../escape.txt', sha256: sha, bytes: 1 }],
  }));
  assert.equal(verifyBackup(dir2).ok, true, 'verify alone cannot see the escape — the restore gate must');
  const inst3 = mkdtempSync(join(tmpdir(), 'pai-bk-restore3-'));
  const r2 = restoreBackup(dir2, inst3, { force: true });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /escapes the instance root/);
  assert.ok(!existsSync(join(inst3, '..', 'escape.txt')) || readFileSync(join(inst3, '..', 'escape.txt'), 'utf-8') === 'x' && !existsSync(join(inst3, 'escape.txt')));
  rmSync(join(dir2, '..', 'escape.txt'));
});
