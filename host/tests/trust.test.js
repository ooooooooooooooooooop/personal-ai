import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTrusted, setTrust, hasInjectableContent } from '../src/core/trust.js';

const dir = () => mkdtempSync(join(tmpdir(), 'pai-trust-'));

test('absent or malformed trust file → untrusted (fail-closed)', () => {
  const inst = dir(); const w = dir();
  assert.equal(isTrusted(inst, w), false);
  writeFileSync(join(inst, 'project-trust.json'), '{not json');
  assert.equal(isTrusted(inst, w), false);
  writeFileSync(join(inst, 'project-trust.json'), JSON.stringify({ workdirs: { [w]: 'yes' } }));
  assert.equal(isTrusted(inst, w), false); // only literal true counts
});

test('setTrust round-trips per workdir; false removes the grant', () => {
  const inst = dir(); const w1 = dir(); const w2 = dir();
  assert.deepEqual(setTrust(inst, w1, true), { workdir: w1, trusted: true, scope: 'exact' });
  assert.equal(isTrusted(inst, w1), true);
  assert.equal(isTrusted(inst, w2), false); // grant is per-workdir
  setTrust(inst, w2, true);
  setTrust(inst, w1, false);
  assert.equal(isTrusted(inst, w1), false);
  assert.equal(isTrusted(inst, w2), true);
});

test('hasInjectableContent only true when .pai/microagents/*.md exists', () => {
  const w = dir();
  assert.equal(hasInjectableContent(w), false);
  mkdirSync(join(w, '.pai', 'microagents'), { recursive: true });
  assert.equal(hasInjectableContent(w), false); // empty dir
  writeFileSync(join(w, '.pai', 'microagents', 'deploy.md'), '---\ntriggers: [deploy]\n---\nnotes');
  assert.equal(hasInjectableContent(w), true);
});

// dedup-h #228 worktree trust (Zed session.trust_all_worktrees analogue):
// a linked worktree is its own trust scope by default; opt-in inheritance
// follows the main checkout's grant only when trustAllWorktrees is set.
test('worktree trust: own scope by default, inherits under trustAllWorktrees', async () => {
  const inst = dir();
  const { spawnSync } = await import('node:child_process');
  const { writeFileSync: wfs, mkdirSync: mkd, existsSync: exs } = await import('node:fs');
  const repo = join(inst, 'repo');
  mkd(repo, { recursive: true });
  for (const args of [
    ['init', '-q'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't'],
  ]) spawnSync('git', args, { cwd: repo });
  wfs(join(repo, 'f.txt'), 'x');
  spawnSync('git', ['add', 'f.txt'], { cwd: repo });
  spawnSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  const wt = join(inst, 'wt1');
  const r = spawnSync('git', ['worktree', 'add', wt, '-b', 'wtb'], { cwd: repo, encoding: 'utf-8' });
  assert.equal(r.status, 0, r.stderr);

  const { worktreeInfo, setTrustAllWorktrees } = await import('../src/core/trust.js');
  const info = worktreeInfo(wt);
  assert.ok(info, 'linked worktree detected from the .git file');
  assert.equal(info.mainRoot, repo);

  // default: a worktree does NOT inherit the main checkout's grant
  setTrust(inst, repo, true);
  assert.equal(isTrusted(inst, wt), false, 'worktree is its own trust scope by default');

  // opt-in: trustAllWorktrees lets the worktree inherit
  setTrustAllWorktrees(inst, true);
  assert.equal(isTrusted(inst, wt), true, 'inherits the trusted main checkout');

  // ...but never invents trust for an untrusted main root
  const wt2 = join(inst, 'wt2');
  spawnSync('git', ['worktree', 'add', wt2, '-b', 'wtb2'], { cwd: repo });
  setTrust(inst, repo, false);
  assert.equal(isTrusted(inst, wt2), false, 'untrusted main → untrusted worktree');

  // the flag survives later setTrust writes (doc merge, not rewrite)
  setTrust(inst, repo, true);
  assert.equal(isTrusted(inst, wt), true, 'flag preserved across setTrust');
});

// dedup-h #1978 — trust scopes: exact covers only this dir; recursive
// covers descendants (never siblings/parents); a parent grant is just an
// exact grant recorded on the ancestor path.
test('trust scopes: recursive covers children only; exact never leaks; parent grant via ancestor path', async () => {
  const inst = dir();
  const parent = join(inst, 'proj');
  const child = join(parent, 'sub', 'deep');
  const sibling = join(inst, 'other');
  mkdirSync(child, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  const { trustDetail } = await import('../src/core/trust.js');

  // exact grant does NOT cover a child dir
  setTrust(inst, parent, true);
  assert.equal(isTrusted(inst, parent), true);
  assert.equal(isTrusted(inst, child), false, 'exact grant must not leak into children');
  assert.equal(isTrusted(inst, sibling), false);

  // recursive grant covers the descendant, reports inheritance honestly
  setTrust(inst, parent, true, 'recursive');
  const d = trustDetail(inst, child);
  assert.equal(d.trusted, true);
  assert.equal(d.scope, 'recursive');
  assert.equal(d.grantedBy, parent);
  assert.equal(isTrusted(inst, sibling), false, 'recursive never covers siblings');
  // self reports scope recursive too
  assert.equal(trustDetail(inst, parent).scope, 'recursive');

  // a recursive grant on the CHILD does not reach back up
  setTrust(inst, parent, false);
  setTrust(inst, child, true, 'recursive');
  assert.equal(isTrusted(inst, parent), false, 'child grant never covers its parent');
  assert.equal(isTrusted(inst, child), true);

  // 'parent' choice = a RECURSIVE grant on the ancestor path (facade
  // resolves it) — the workdir ends up covered, which is the point.
  setTrust(inst, child, false);
  setTrust(inst, parent, true, 'recursive');
  const dp = trustDetail(inst, child);
  assert.equal(dp.trusted, true);
  assert.equal(dp.grantedBy, parent, 'grant attributed to the ancestor, not the child');
});
