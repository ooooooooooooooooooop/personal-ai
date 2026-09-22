/**
 * A1 boundary hardening sentinels — the workdir boundary must be realpath-
 * aware on BOTH directions:
 *
 *  - reads: an in-workdir symlink to outside must trip read_outside
 *  - writes: file-mutation tools had NO workdir check at all — absolute
 *    outside paths and symlinked parents must raise write_outside
 *  - shell writeTargets: `> ../out` escapes lexically; `> link/x` where
 *    link -> .git evades the kernel's lexical GIT_INTERNAL_RE — the real
 *    path is what the filesystem writes, so resolved paths are re-checked.
 */
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDecide } from '../src/bootstrap/decide.js';
import { FileOpsGuard } from '../src/adapter/fileops.js';
import { parseShellCommand } from '../src/adapter/command-parse.js';
import { AuditWriter } from '../../host/src/core/audit.js';

/** No operator channel — boundary questions fail closed. */
function rig({ withClassifier = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pai-wb-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  const audit = new AuditWriter({ auditDir: join(dir, 'audit') });
  const fileOps = new FileOpsGuard(dir);
  const core = { audit, kernel: { decideToolCall: async () => null } };
  const decide = makeDecide({
    core, executor: null, fileOps, getSurface: () => null,
    workdir: dir, asks: null,
    classifier: withClassifier ? parseShellCommand : null,
  });
  return { dir, decide };
}

/** With a recording ask channel answering `answer` to every question. */
const rig2 = (opts = {}, answer = 'deny') => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-wb-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  const audit = new AuditWriter({ auditDir: join(dir, 'audit') });
  const fileOps = new FileOpsGuard(dir);
  const core = { audit, kernel: { decideToolCall: async () => null } };
  const seen = [];
  const asks = { ask: async (p) => { seen.push(p.rule); return answer; } };
  const decide = makeDecide({
    core, executor: null, fileOps, getSurface: () => null,
    workdir: dir, asks,
    classifier: opts.withClassifier ? parseShellCommand : null,
  });
  return { dir, decide, seen };
};

test('write to an absolute path outside workdir is blocked when no operator channel', async () => {
  const { decide } = rig();
  const outside = mkdtempSync(join(tmpdir(), 'pai-wb-out-'));
  const r = await decide({ toolCall: { name: 'write', id: 't1' }, args: { path: join(outside, 'evil.txt'), content: 'x' } });
  assert.equal(r.block, true);
  assert.equal(r.rule, 'write_outside');
});

test('write outside with operator allow proceeds; deny latches session-wide', async () => {
  const { decide, seen } = rig2({}, 'deny');
  const outside = mkdtempSync(join(tmpdir(), 'pai-wb-out-'));
  const r1 = await decide({ toolCall: { name: 'write', id: 't1' }, args: { path: join(outside, 'a.txt'), content: 'x' } });
  assert.equal(r1.rule, 'write_outside');
  // latch: a second, different outside write is blocked WITHOUT re-asking
  const r2 = await decide({ toolCall: { name: 'write', id: 't2' }, args: { path: join(outside, 'b.txt'), content: 'x' } });
  assert.equal(r2.rule, 'write_outside');
  assert.equal(seen.length, 1); // asked once only
});

test('write inside workdir admits (gate does not over-fire)', async () => {
  const { dir, decide } = rig();
  const target = join(dir, 'ok.txt');
  writeFileSync(target, 'orig');
  const r = await decide({ toolCall: { name: 'write', id: 't1' }, args: { path: target, content: 'x' } });
  assert.equal(r, undefined); // admitted — fileOps backup path runs
});

test('in-workdir symlink escapes the read boundary gate', async (t) => {
  const { dir, decide, seen } = rig2({}, 'deny');
  const outside = mkdtempSync(join(tmpdir(), 'pai-wb-out-'));
  writeFileSync(join(outside, 'secret.txt'), 'shh');
  const link = join(dir, 'linkout');
  try { symlinkSync(outside, link, 'junction'); } catch { t.skip('no symlink privilege'); return; }
  const r = await decide({ toolCall: { name: 'read', id: 't1' }, args: { path: join(link, 'secret.txt') } });
  assert.equal(r.rule, 'read_outside');
  assert.deepEqual(seen, ['read_outside']);
});

test('write through a symlinked parent directory is caught (not just lexical)', async (t) => {
  const { dir, decide } = rig();
  const outside = mkdtempSync(join(tmpdir(), 'pai-wb-out-'));
  const escape = join(dir, 'escape');
  try { symlinkSync(outside, escape, 'junction'); } catch { t.skip('no symlink privilege'); return; }
  const r = await decide({ toolCall: { name: 'write', id: 't1' }, args: { path: join(escape, 'x.txt'), content: 'x' } });
  assert.equal(r.block, true);
  assert.equal(r.rule, 'write_outside');
});

test('shell redirect to ../ outside path raises write_outside', async () => {
  const { decide, seen } = rig2({ withClassifier: true }, 'deny');
  const r = await decide({ toolCall: { name: 'bash', id: 't1' }, args: { command: 'echo hi > ../outside.txt' } });
  assert.equal(r.block, true);
  assert.equal(r.rule, 'write_outside');
});

test('shell redirect through symlink into .git is caught on the real path', async (t) => {
  const { dir, decide, seen } = rig2({ withClassifier: true }, 'deny');
  mkdirSync(join(dir, '.git'), { recursive: true });
  const link = join(dir, 'gitlink');
  try { symlinkSync(join(dir, '.git'), link, 'junction'); } catch { t.skip('no symlink privilege'); return; }
  // 'echo' is not in NAME_RISK → parsed.hasUnknown → but writeTargets carry
  // 'gitlink/config' — lexical form has no '.git', real path does.
  const r = await decide({ toolCall: { name: 'bash', id: 't1' }, args: { command: 'echo x > gitlink/config' } });
  assert.equal(r.block, true);
  assert.equal(r.rule, 'git_internal');
  assert.deepEqual(seen, ['git_internal']);
});

test('multi_edit with any outside edit path is refused', async () => {
  const { dir, decide } = rig();
  const outside = mkdtempSync(join(tmpdir(), 'pai-wb-out-'));
  const inFile = join(dir, 'a.txt');
  writeFileSync(inFile, 'hello');
  const r = await decide({
    toolCall: { name: 'multi_edit', id: 't1' },
    args: { edits: [
      { path: inFile, old_string: 'hello', new_string: 'hi' },
      { path: join(outside, 'b.txt'), old_string: 'x', new_string: 'y' },
    ] },
  });
  assert.equal(r.block, true);
  assert.equal(r.rule, 'write_outside');
});

test('device sinks (> NUL) do not trip the boundary', async () => {
  const { decide, seen } = rig2({ withClassifier: true }, 'deny');
  // NUL resolves nowhere — if the gate fired this would block.
  const r = await decide({ toolCall: { name: 'bash', id: 't1' }, args: { command: 'echo hi > NUL' } });
  assert.notEqual(r?.rule, 'write_outside');
});
