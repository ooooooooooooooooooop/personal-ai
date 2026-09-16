import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveInstanceRoot } from '../src/core/instance.js';

test('instance_root inside a git worktree fails closed', () => {
  const dir = join(tmpdir(), `pai-test-${Date.now()}`);
  const nested = join(dir, 'deep', 'root');
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(nested, { recursive: true });
  try {
    assert.throws(() => resolveInstanceRoot(nested), /git worktree/);
    const free = join(tmpdir(), `pai-free-${Date.now()}`);
    assert.equal(resolveInstanceRoot(free), resolve(free));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
