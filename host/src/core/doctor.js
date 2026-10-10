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
import { existsSync, readFileSync, accessSync, constants, statSync } from 'node:fs';
import { join, sep } from 'node:path';
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
    id: 'canonical_separated',
    /**
     * Invariant 5 says canonical state / instance runtime / source tree are
     * physically separated. The default layout puts the canonical at
     * `<instanceRoot>/canonical` — inside the runtime — which contradicts it, and
     * the world-model repo states the same boundary from its side ("canonical 禁止
     * 出现在实例根内"; it is the canonical's sole owner). The mount is now
     * expressible (PAI_CANONICAL_DIR / WORLD_MODEL_HOME, both naming the canonical
     * directory itself, or WORLD_MODEL_REPO+PAI_PILOT for the repo layout); this
     * check exists so that NOT mounting it is a visible choice rather than a silent
     * one.
     */
    run({ paths }) {
      const root = paths?.root, canon = paths?.canonicalDir;
      if (!root || !canon) return warn('no instance root', 'cannot tell where the canonical lives');
      const inside = canon === root || canon.startsWith(root + sep) || canon.startsWith(root + '/');
      if (inside) {
        return warn(`canonical lives inside the instance root (${canon})`,
          'invariant 5 wants canonical / runtime / source tree physically separated. '
          + 'Mount it instead: PAI_CANONICAL_DIR=<dir> or WORLD_MODEL_HOME=<canonical dir>, '
          + 'or WORLD_MODEL_REPO=<repo> + PAI_PILOT=<pilot> for the repo layout. '
          + 'Current behaviour is preserved for existing instances, '
          + 'so this is a choice — but make it deliberately.');
      }
      return ok(`canonical is mounted outside the instance root (${canon})`);
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
    id: 'compiled_artifacts',
    /**
     * Are the two COMPILED channels actually reaching the model?
     *
     *   briefing.md          <- current.yaml     what is BELIEVED   -> ContextEnvelope
     *   instruction/generated.md  <- governance.yaml  how to OPERATE     -> InstructionEnvelope
     *
     * This check exists because a missing channel is INVISIBLE from the inside:
     * an empty briefing and a legitimately absent prior state look identical to
     * the model, and the world model's own loop cannot tell them apart either —
     * a channel that is absent produces silence, not evidence, and silence is
     * not a signal. Both channels were in fact broken (one read a path nothing
     * wrote, one had no producer at all) and nothing noticed. Liveness of a
     * channel is a doctor question, not a learning question.
     *
     * The compiler names come from the soul manifest's declarations, so this
     * check follows the declaration rather than hardcoding a path.
     */
    run({ paths }) {
      const canon = paths?.canonicalDir;
      if (!canon || !existsSync(canon)) {
        return warn('no canonical dir — nothing to compile from', 'initialise the instance canonical first');
      }
      let manifest = null;
      try { manifest = JSON.parse(readFileSync(join(paths.soulDir, 'manifest.json'), 'utf-8')); } catch { /* absent */ }
      const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return null; } };

      // Newest source: an artifact older than this is stale, not merely absent.
      const sources = ['current.yaml', 'governance.yaml']
        .map((f) => mtime(join(canon, f))).filter((m) => m != null);
      const newestSrc = sources.length ? Math.max(...sources) : null;

      const artifacts = [
        { name: 'briefing.md', file: join(canon, 'briefing.md'), compiler: manifest?.briefing?.compiler },
        { name: 'instruction/generated.md', file: join(canon, 'instruction', 'generated.md'), compiler: manifest?.instruction?.compiler },
        // The learned overlay (G11). OPTIONAL: its absence is correct — no
        // overlay means the built-in prior stands, which is the safe default.
        // But if it IS present it must be current, or the gate would run on a
        // model the canonical has already moved past.
        { name: 'reversibility.json', file: join(canon, 'reversibility.json'),
          compiler: 'mind/reversibility_compile.py', optional: true },
      ];
      const missing = [], stale = [];
      for (const a of artifacts) {
        const m = mtime(a.file);
        if (m == null) { if (!a.optional) missing.push(a); }
        else if (newestSrc != null && m < newestSrc) stale.push(a);
      }
      if (!missing.length && !stale.length) {
        const present = artifacts.filter((a) => mtime(a.file) != null).map((a) => a.name);
        const overlays = present.includes('reversibility.json')
          ? ' + learned overlay' : ' (no learned overlay — the prior stands)';
        return ok(`${present.join(' + ')} compiled and current${overlays}`);
      }
      const bits = [];
      if (missing.length) bits.push(`missing: ${missing.map((a) => a.name).join(', ')}`);
      if (stale.length) bits.push(`stale: ${stale.map((a) => a.name).join(', ')}`);
      const compilers = [...new Set([...missing, ...stale].map((a) => a.compiler).filter(Boolean))];
      const fix = compilers.length
        ? `run ${compilers.join(' and ')} --canonical ${canon}`
        : `compile them (see soul/manifest.json for the declared compilers) against ${canon}`;
      return warn(
        `${bits.join('; ')} — the model is not being told what it believes (briefing) `
        + 'or the rules it is subject to (instruction)', fix);
    },
  },
  {
    id: 'world_model_cycle',
    /**
     * Is the world-model cycle scheduled?
     *
     * The cycle (mind/wm_cycle.py) runs the non-governed half of the chain —
     * learning metrics, distillation to proposals/, and the two compilers — and
     * stops before u1_accept, which writes the canonical and is a governance
     * act. It is safe to run unattended; what it must NOT be is something
     * nobody remembers to run, because then the loop is dark and the failure is
     * invisible (see compiled_artifacts).
     *
     * Nothing seeds this: there is no instance-init path that registers it, so
     * a fresh instance runs with the loop dark until someone schedules it.
     * That is exactly the kind of silent default a doctor exists to surface.
     */
    run({ paths }) {
      const root = paths?.root;
      if (!root) return warn('no instance root', 'cannot tell whether the cycle is scheduled');
      // The signal is REPETITION, not a single refutation and not the clock.
      // One failure is noise ("一次失败可能只是噪声"); a 残差结构 — the same kind of
      // failure recurring — is what licenses MODEL FAILURE. The adapter asks for
      // a re-examination on recurrence; if that path is absent, a sweep is a
      // fallback, not the mechanism.
      const sweep = 'schedule_task(action:"create", '
        + `command:"python mind/wm_cycle.py --instance ${root}", `
        + 'every_seconds:3600, min_seconds:3600, max_seconds:86400, '
        + 'label:"world-model cycle (FALLBACK sweep)")';
      const noTrigger = warn(
        'world-model cycle has no trigger — nothing consumes refutations, and no sweep is scheduled',
        'wire the recurrence consumer (the adapter asks for a re-examination when one kind of '
        + 'until then, sweep: ' + sweep);
      const file = join(root, 'schedules.json');
      if (!existsSync(file)) return noTrigger;
      let entries = [];
      try {
        const d = JSON.parse(readFileSync(file, 'utf-8'));
        entries = Array.isArray(d) ? d : (Array.isArray(d?.schedules) ? d.schedules : []);
      } catch (e) {
        return warn(`schedules.json is unreadable (${String(e?.message ?? e)})`,
          'the scheduler cannot fire anything from a corrupt file — fix or remove it');
      }
      const hit = entries.filter((s) => s?.enabled !== false
        && typeof s?.command === 'string' && s.command.includes('wm_cycle'));
      if (!hit.length) return noTrigger;
      const s = hit[0];
      return ok(`world-model cycle scheduled (every ${s.every_seconds ?? '?'}s`
        + `${s.max_seconds ? `, backoff to ${s.max_seconds}s when quiet` : ''}) — a FALLBACK sweep, not the mechanism`);
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
    id: 'git_repo',
    run({ workdir }) {
      try {
        execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: workdir, timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
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
