/**
 * FileOpsGuard — recoverable-mutation store: collision-proof artifact names,
 * torn ops-log tolerance, retention sweep, restore-never-clobbers.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { FileOpsGuard } from '../src/adapter/fileops.js';

const rig = (opts) => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-fo-'));
  return { dir, fo: new FileOpsGuard(dir, opts) };
};

test('write backup → undoCall restores original bytes', async () => {
  const { dir, fo } = rig();
  const target = join(dir, 'a.txt');
  writeFileSync(target, 'original');
  await fo.write(target, 'mutated', { toolCallId: 'tc1' });
  assert.equal(readFileSync(target, 'utf-8'), 'mutated');
  const r = await fo.undoCall('tc1');
  assert.deepEqual(r.skipped, []);
  assert.equal(readFileSync(target, 'utf-8'), 'original');
});

test('same-basename mutations in the same millisecond keep DISTINCT artifacts', async () => {
  const { dir, fo } = rig();
  const d1 = join(dir, 'one'); const d2 = join(dir, 'two');
  mkdirSync(d1); mkdirSync(d2);
  const f1 = join(d1, 'index.js'); const f2 = join(d2, 'index.js');
  writeFileSync(f1, 'bytes-one'); writeFileSync(f2, 'bytes-two');
  const realNow = Date.now;
  Date.now = () => 1700000000000; // force the collision window
  try {
    await fo.write(f1, 'mut-1', { toolCallId: 'c1' });
    await fo.write(f2, 'mut-2', { toolCallId: 'c2' });
  } finally { Date.now = realNow; }
  // both restores must recover THEIR OWN pre-mutation bytes — a name clobber
  // would cross-contaminate (restore of f1 copying f2's backup bytes)
  await fo.undoCall('c1');
  await fo.undoCall('c2');
  assert.equal(readFileSync(f1, 'utf-8'), 'bytes-one');
  assert.equal(readFileSync(f2, 'utf-8'), 'bytes-two');
});

test('a torn ops-log tail row does not kill the undo surface', async () => {
  const { dir, fo } = rig();
  const target = join(dir, 'b.txt');
  writeFileSync(target, 'keepme');
  const { receiptId } = await fo.write(target, 'v2', { toolCallId: 'c9' });
  appendFileSync(fo.opsLog, '{"receiptId":"fo-torn","op":"wri'); // crash mid-append
  assert.equal(fo.list().length, 1, 'torn row skipped, valid rows survive');
  fo.restore(receiptId);
  assert.equal(readFileSync(target, 'utf-8'), 'keepme');
});

test('retention cap evicts oldest artifacts; list() reports them unrecoverable', async () => {
  const { dir, fo } = rig({ artifactCap: 3 });
  const target = join(dir, 'c.txt');
  writeFileSync(target, 'v0');
  for (let i = 1; i <= 5; i++) {
    await fo.write(target, `v${i}`, { toolCallId: `c${i}` });
    await new Promise((r) => setTimeout(r, 5)); // distinct mtimes
  }
  assert.ok(readdirSync(fo.backupDir).length <= 3, 'cap enforced');
  const ops = fo.list(10);
  assert.equal(ops.filter((o) => o.op === 'write').length, 5, 'receipts survive artifact eviction');
  assert.ok(ops.some((o) => o.recoverable === false), 'evicted receipts degrade honestly');
  // newest receipts still undo
  await fo.undoCall('c5');
  assert.equal(readFileSync(target, 'utf-8'), 'v4');
});

test('restore never clobbers: current bytes are recycled before the overwrite', async () => {
  const { dir, fo } = rig();
  const target = join(dir, 'd.txt');
  writeFileSync(target, 'v1');
  const { receiptId } = await fo.write(target, 'v2', { toolCallId: 'c1' });
  writeFileSync(target, 'unreceipted-work'); // external change after the mutation
  fo.restore(receiptId);
  assert.equal(readFileSync(target, 'utf-8'), 'v1');
  const recycled = readdirSync(fo.recycleDir);
  assert.ok(recycled.length >= 1, 'displaced current bytes preserved in recycle/');
  const found = recycled.some((f) => readFileSync(join(fo.recycleDir, f), 'utf-8') === 'unreceipted-work');
  assert.ok(found, 'un-receipted work recoverable, not destroyed');
});

test('create tombstone undo removes the created file', async () => {
  const { dir, fo } = rig();
  const target = join(dir, 'new.txt');
  await fo.write(target, 'fresh', { toolCallId: 'cn' });
  assert.ok(existsSync(target));
  await fo.undoCall('cn');
  assert.ok(!existsSync(target), 'creation undone by removal');
  // and the removal itself is recoverable (it went to recycle, not rm)
  assert.ok(readdirSync(fo.recycleDir).length >= 1);
});
