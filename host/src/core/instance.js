import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Resolve the instance root fail-closed.
 *
 * Invariant 5: canonical state / instance runtime / source tree are physically
 * separated. If `instanceRoot` resolves inside any git worktree we throw —
 * runtime state must never be able to land inside a source tree, and we do not
 * rely on .gitignore for that boundary.
 */
export function resolveInstanceRoot(instanceRoot) {
  const root = resolve(instanceRoot);
  let cur = root;
  for (;;) {
    if (existsSync(join(cur, '.git'))) {
      throw new Error(`instance_root inside git worktree, refusing: ${root}`);
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return root;
}

/** @returns {import('./contracts.js').InstancePaths} */
export function instancePaths(instanceRoot) {
  const root = resolveInstanceRoot(instanceRoot);
  return {
    root,
    auditDir: join(root, 'audit'),
    jobsDir: join(root, 'jobs'),
    checkpointsDir: join(root, 'checkpoints'),
    soulDir: join(root, 'soul'),
    canonicalDir: join(root, 'canonical'),
  };
}
