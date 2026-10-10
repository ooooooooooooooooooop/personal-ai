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

/**
 * Where does the canonical live?
 *
 * Invariant 5 (above) says canonical state / instance runtime / source tree are
 * physically separated. The default below — `<instanceRoot>/canonical` — puts the
 * canonical INSIDE the instance runtime, which is exactly what invariant 5
 * forbids; the world-model repo states the same boundary from its side
 * ("canonical 禁止出现在实例根内"; the research repo is its sole owner and the
 * product must not assume a path into it). So the mount has to be expressible,
 * and it was not: the path was hardcoded with no override anywhere in the repo.
 *
 * Precedence, and nothing is guessed:
 *   1. `PAI_CANONICAL_DIR`      — the canonical directory itself
 *   2. `WORLD_MODEL_HOME`       — ALSO the canonical directory itself, not a repo
 *                                 root. This is the meaning documented on the
 *                                 other side of the boundary — the research repo's
 *                                 README ("通过 WORLD_MODEL_HOME env 挂载试点
 *                                 canonical（本机：~/world-model/pilot/personal-ai/canonical)"),
 *                                 `skills/world-model-runtime/SKILL.md` ("WORLD_MODEL_HOME
 *                                 指向的目录") and `dsh/world-model/README.md`. An
 *                                 earlier revision read it as a repo root and threw
 *                                 whenever `PAI_PILOT` was unset, which made every
 *                                 machine that had already set it the documented way
 *                                 fail to boot (host suite: 67 failures; `startHost`
 *                                 threw inside `instancePaths`).
 *   3. `WORLD_MODEL_REPO` + `PAI_PILOT`
 *                               — the research-repo LAYOUT, under its own name so
 *                                 that no variable carries two meanings:
 *                                 <WORLD_MODEL_REPO>/pilot/<PAI_PILOT>/canonical
 *                                 REPO without PILOT THROWS rather than guess which
 *                                 pilot you meant.
 *   4. none of the above        — `<instanceRoot>/canonical` (the old behaviour,
 *                                 kept so existing instances do not break; the
 *                                 doctor's canonical_separated check flags it)
 *
 * @param {string} root resolved instance root
 * @param {{canonicalDir?: string, env?: object}} [opts]
 */
export function resolveCanonicalDir(root, opts = {}) {
  const env = opts.env ?? process.env;
  if (opts.canonicalDir) return resolve(opts.canonicalDir);
  if (env.PAI_CANONICAL_DIR) return resolve(env.PAI_CANONICAL_DIR);
  if (env.WORLD_MODEL_HOME) return resolve(env.WORLD_MODEL_HOME);
  if (env.WORLD_MODEL_REPO) {
    const pilot = String(env.PAI_PILOT ?? '').trim();
    if (!pilot) {
      throw new Error('WORLD_MODEL_REPO is set but PAI_PILOT is not — name the pilot '
        + 'rather than have the canonical resolved against a guess');
    }
    return resolve(join(env.WORLD_MODEL_REPO, 'pilot', pilot, 'canonical'));
  }
  return join(root, 'canonical');
}

/** @returns {import('./contracts.js').InstancePaths} */
export function instancePaths(instanceRoot, opts = {}) {
  const root = resolveInstanceRoot(instanceRoot);
  return {
    root,
    auditDir: join(root, 'audit'),
    jobsDir: join(root, 'jobs'),
    checkpointsDir: join(root, 'checkpoints'),
    soulDir: join(root, 'soul'),
    canonicalDir: resolveCanonicalDir(root, opts),
    // Runtime world-model state (observations / open predictions) lives under the
    // instance root, NOT in canonicalDir: canonical is governed artifact state
    // (freeze + U1 proposals); runtime evidence stores are instance runtime state.
    // Boundary adjudicated by owner 2026-10-10 (world-model repo incident record
    // 2026-09-25-canonical-overwrite-incident.md §6.3, option 1).
    worldModelDir: join(root, 'world-model'),
  };
}
