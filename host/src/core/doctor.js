/**
 * doctor — M120 environment health-check subsystem (Cline/venv-doctor
 * analogue): an ordered battery of checks over the runtime, each returning
 * {status: pass|warn|fail, detail, fix}. `fix` is the actionable suggestion
 * a doctor exists for — a bare "broken" is not a diagnosis.
 *
 * Zero dependencies beyond node builtins; every check is best-effort — a
 * check that itself throws reports `fail` with the error, never crashes the
 * battery. Dep-injected so the same checks run under tests and the pi tool.
 */
import { existsSync, readFileSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyExtensionIntegrity, loadManagedManifest } from './manifest.js';

const ok = (detail, extra = {}) => ({ status: 'pass', detail, ...extra });
const warn = (detail, fix, extra = {}) => ({ status: 'warn', detail, fix, ...extra });
const fail = (detail, fix, extra = {}) => ({ status: 'fail', detail, fix, ...extra });

function tryJson(path) {
  try { return { doc: JSON.parse(readFileSync(path, 'utf-8')) }; }
  catch (e) { return { error: String(e?.message ?? e) }; }
}

/** Individual checks — each receives the dep bundle, returns a verdict. */
export const DOCTOR_CHECKS = [
  {
    id: 'instance_dirs',
    run({ paths }) {
      const missing = [];
      for (const [name, dir] of Object.entries(paths ?? {})) {
        if (name === 'root') continue;
        try {
          if (!existsSync(dir)) { missing.push(name); continue; }
          accessSync(dir, constants.W_OK);
        } catch { missing.push(`${name} (unwritable)`); }
      }
      return missing.length
        ? fail(`instance dirs missing/unwritable: ${missing.join(', ')}`, 'recreate the instance root or fix permissions — runtime state cannot persist')
        : ok('instance dirs present and writable');
    },
  },
  {
    id: 'instance_outside_git',
    run({ paths }) {
      let cur = paths?.root;
      try {
        while (cur) {
          if (existsSync(join(cur, '.git'))) return fail(`instance root '${paths.root}' sits inside a git worktree`, 'move the instance root — runtime state must never live inside a source tree');
          const parent = join(cur, '..');
          if (parent === cur) break;
          cur = parent;
        }
      } catch { /* best effort */ }
      return ok('instance root is outside any git worktree');
    },
  },
  {
    id: 'hooks_config',
    run({ workdir, paths }) {
      const bad = [];
      for (const p of [join(workdir ?? '', '.pai', 'hooks.json'), join(paths?.root ?? '', 'hooks.json')]) {
        if (!existsSync(p)) continue;
        const r = tryJson(p);
        if (r.error) bad.push(`${p}: ${r.error}`);
        else if (r.doc?.hooks && typeof r.doc.hooks !== 'object') bad.push(`${p}: 'hooks' is not an object`);
      }
      return bad.length
        ? fail(`hooks config invalid: ${bad.join(' | ')}`, 'fix or remove the file — a malformed observational config is ignored (audited), a malformed gate file refuses at load')
        : ok('hooks configs parse (or absent)');
    },
  },
  {
    id: 'policy',
    run({ policy }) {
      if (!policy?.doc) return fail('no attested policy loaded', 're-attest the canonical policy — the kernel should have failed closed before you could run this');
      const ra = policy.doc?.riskActions;
      if (!ra || typeof ra !== 'object') return warn('policy has no riskActions map', 'default risk posture applies — confirm that is intended');
      return ok(`policy loaded (riskActions: ${Object.keys(ra).length} classes)`);
    },
  },
  {
    id: 'managed_extensions',
    run({ extRoot }) {
      if (!extRoot) return ok('no managed extension surface configured');
      let manifest;
      try { manifest = loadManagedManifest(join(extRoot, 'managed-manifest.json')); }
      catch (e) { return fail(`managed manifest unreadable: ${e.message}`, 'restore managed-manifest.json — extension loading fails closed without it'); }
      const bad = [];
      for (const e of manifest.extensions ?? []) {
        try { verifyExtensionIntegrity(e, join(extRoot, e.path)); }
        catch (err) { bad.push(`${e.id}: ${err.message}`); }
      }
      return bad.length
        ? fail(`extension integrity: ${bad.join(' | ')}`, 'the file drifted from its pinned sha256 — re-pin only if the change is yours')
        : ok(`${(manifest.extensions ?? []).length} managed extensions verified`);
    },
  },
  {
    id: 'paiignore',
    run({ workdir, ignored }) {
      if (typeof ignored === 'function') {
        try {
          const probe = ignored('.pai');
          if (probe !== true) return warn('.paiignore does not exclude .pai/', 'usually intentional — but instruction/protection files should stay out of retrieval tools');
        } catch (e) { return warn(`.paiignore probe threw: ${e.message}`, 'check the ignore file syntax'); }
      }
      return ok('.paiignore predicate live');
    },
  },
  {
    id: 'git_repo',
    run({ workdir }) {
      try {
        execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: workdir, timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        return warn('workdir is not a git repo (or git missing)', 'workspace-delta notices and diff surfaces are degraded — nothing is broken');
      }
      return ok('workdir is a git worktree');
    },
  },
  {
    id: 'node_version',
    run() {
      const major = Number(process.versions.node.split('.')[0]);
      return major >= 20
        ? ok(`node ${process.versions.node}`)
        : fail(`node ${process.versions.node} is below the v20 floor`, 'upgrade node — sqlite/test-runner/builtin fetch all assume v20+');
    },
  },
  {
    id: 'env_overlay',
    run({ sessionEnv }) {
      if (!sessionEnv) return ok('no session env overlay');
      const n = sessionEnv.vars?.size ?? 0;
      return n ? ok(`session env overlay: ${n} keys`) : ok('session env overlay empty');
    },
  },
];

/**
 * Run the battery. @param deps {paths, workdir, policy, extRoot, ignored, sessionEnv}
 * @returns {{checks: Array<{id,status,detail,fix?}>, pass:number, warn:number, fail:number}}
 */
export async function runDoctor(deps = {}) {
  const checks = [];
  for (const c of DOCTOR_CHECKS) {
    try {
      checks.push({ id: c.id, ...await c.run(deps) });
    } catch (e) {
      checks.push({ id: c.id, status: 'fail', detail: `check threw: ${String(e?.message ?? e)}`, fix: 'the check itself failed — report this' });
    }
  }
  const count = (s) => checks.filter((x) => x.status === s).length;
  return { checks, pass: count('pass'), warn: count('warn'), fail: count('fail') };
}
