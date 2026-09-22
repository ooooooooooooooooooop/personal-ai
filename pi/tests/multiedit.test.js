/**
 * M143: multi_edit — batch exact-match edits across files, all-or-nothing.
 *
 * Covers: atomic preflight (one bad edit refuses the whole batch with zero
 * writes), per-file fileOps receipts under one toolCallId (batch-undoable),
 * replace_all semantics, workdir boundary + .paiignore exclusion, mid-apply
 * rollback, and the decide chain treating the tool as mutating (write lease)
 * with the U4 secret scan covering edits[].new_string.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { multiEditTool } from '../src/adapter/multiedit.js';
import { FileOpsGuard } from '../src/adapter/fileops.js';
import { makeDecide } from '../src/bootstrap/decide.js';
import { WorkspaceWriteLease } from '../src/adapter/writelease.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pai-medit-'));
  const inst = mkdtempSync(join(tmpdir(), 'pai-medit-inst-'));
  const fileOps = new FileOpsGuard(inst);
  const tool = multiEditTool({ workdir: dir, fileOps });
  return { dir, fileOps, tool };
}

test('M143: multi_edit applies edits across files atomically — batch undoable', async () => {
  const { dir, fileOps, tool } = setup();
  writeFileSync(join(dir, 'a.txt'), 'alpha ONE omega');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'b.txt'), 'beta ONE gamma ONE');

  const r = await tool.execute('tc-batch', {
    edits: [
      { path: 'a.txt', old_string: 'ONE', new_string: 'TWO' },
      { path: 'sub/b.txt', old_string: 'ONE', new_string: 'TWO', replace_all: true },
    ],
  });
  assert.equal(r.isError, undefined);
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf-8'), 'alpha TWO omega');
  assert.equal(readFileSync(join(dir, 'sub', 'b.txt'), 'utf-8'), 'beta TWO gamma TWO');
  assert.equal(r.details.files.length, 2);

  // every file got its own receipt under this call → undoCall reverts all
  const undo = await fileOps.undoCall('tc-batch');
  assert.equal(undo.restored.length, 2);
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf-8'), 'alpha ONE omega');
  assert.equal(readFileSync(join(dir, 'sub', 'b.txt'), 'utf-8'), 'beta ONE gamma ONE');
});

test('M143: a single bad edit refuses the whole batch — nothing is written', async () => {
  const { dir, tool } = setup();
  writeFileSync(join(dir, 'ok.txt'), 'hello WORLD');
  const r = await tool.execute('tc-x', {
    edits: [
      { path: 'ok.txt', old_string: 'WORLD', new_string: 'EARTH' },
      { path: 'missing.txt', old_string: 'x', new_string: 'y' },
      { path: 'ok.txt', old_string: 'NOPE', new_string: 'z' },
    ],
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /nothing was written/);
  assert.match(r.content[0].text, /missing\.txt.*does not exist/s);
  assert.match(r.content[0].text, /not found/s);
  // untouched — including the edit that WOULD have applied
  assert.equal(readFileSync(join(dir, 'ok.txt'), 'utf-8'), 'hello WORLD');
});

test('M143: ambiguous match refused unless replace_all; outside-workdir + .paiignore refused', async () => {
  const { dir, tool } = setup();
  writeFileSync(join(dir, 'dup.txt'), 'x and x and x');
  writeFileSync(join(dir, 'ignored.log'), 'keep me');

  const amb = await tool.execute('tc', { edits: [{ path: 'dup.txt', old_string: 'x', new_string: 'y' }] });
  assert.equal(amb.isError, true);
  assert.match(amb.content[0].text, /matches 3 locations/);

  const outside = await tool.execute('tc', { edits: [{ path: '../escape.txt', old_string: 'a', new_string: 'b' }] });
  assert.equal(outside.isError, true);
  assert.match(outside.content[0].text, /outside the workdir/);

  const ignored = multiEditTool({ workdir: dir, fileOps: new FileOpsGuard(mkdtempSync(join(tmpdir(), 'i-'))), getIgnored: (p) => p.endsWith('.log') });
  const r = await ignored.execute('tc', { edits: [{ path: 'ignored.log', old_string: 'keep', new_string: 'change' }] });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /paiignore/);
});

test('M143: mid-apply write failure rolls back earlier files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-medit-'));
  writeFileSync(join(dir, 'first.txt'), 'aaa');
  writeFileSync(join(dir, 'second.txt'), 'bbb');
  // a fileOps that fails on the second write — exercises the rollback path
  const real = new FileOpsGuard(mkdtempSync(join(tmpdir(), 'pai-medit-inst-')));
  let calls = 0;
  const failing = {
    write: async (p, c, o) => (++calls === 2 ? Promise.reject(new Error('disk full')) : real.write(p, c, o)),
    restore: (rid) => real.restore(rid),
  };
  const tool = multiEditTool({ workdir: dir, fileOps: failing });
  const r = await tool.execute('tc-fail', {
    edits: [
      { path: 'first.txt', old_string: 'aaa', new_string: 'AAA' },
      { path: 'second.txt', old_string: 'bbb', new_string: 'BBB' },
    ],
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /disk full/);
  assert.match(r.content[0].text, /rolled back 1/);
  // the earlier file's write was reverted — not left half-applied
  assert.equal(readFileSync(join(dir, 'first.txt'), 'utf-8'), 'aaa');
});

test('M143: decide treats multi_edit as mutating (write lease) and scans edits[].new_string for secrets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-lease-'));
  const lease = new WorkspaceWriteLease(join(dir, 'lease.json'));
  const decide = makeDecide({
    core: {
      kernel: { decideToolCall: async () => undefined },
      audit: { write() {} },
    },
    executor: { spawnCommandJob: async () => ({ refused: true, reason: 'n/a' }) },
    fileOps: { backup: async () => ({ backup: null }), delete: async () => { throw new Error('n/a'); } },
    getSurface: () => null,
    workdir: '/tmp',
    writeLease: lease,
  });
  const acq = lease.acquire('job:test');
  assert.equal(acq.ok, true);
  const r = await decide({
    toolCall: { id: 'tc', name: 'multi_edit' },
    toolName: 'multi_edit',
    args: { edits: [{ path: 'a.txt', old_string: 'x', new_string: 'y' }] },
  });
  assert.equal(r?.block, true);
  assert.equal(r?.rule, 'workspace_lease');
  lease.release('job:test');

  // secret scan covers the batch payload — a credential in ANY new_string blocks
  const fakeKey = 'ghp_' + 'a'.repeat(36);
  const r2 = await decide({
    toolCall: { id: 'tc2', name: 'multi_edit' },
    toolName: 'multi_edit',
    args: { edits: [{ path: 'a.txt', old_string: 'x', new_string: `key = ${fakeKey}` }] },
  });
  assert.equal(r2?.block, true);
  assert.equal(r2?.rule, 'secret_scan');
});
