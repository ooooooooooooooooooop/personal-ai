/**
 * Subagent profiles — frontmatter-defined delegation personas
 * (Claude Code .claude/agents analogue, reduced to what our delegation bridge
 * actually consumes: a switchboard target + a task preamble).
 *
 * Discovery order (first hit wins on name collision):
 *   <workdir>/.pai/agents/*.md   project-local profiles
 *   <instance>/agents/*.md       user-level profiles
 *   compat dirs from other harnesses (Cursor .cursor/agents, Kiro
 *   .kiro/agents, Claude Code .claude/agents, Devin .devin/agents) — same
 *   md+frontmatter shape; a file without `target:` only loads when
 *   PAI_DELEGATE_DEFAULT_TARGET is set (their agents ran in-process; ours
 *   must name a body to spawn).
 *
 * File shape:
 *   ---
 *   name: reviewer          (defaults to filename stem)
 *   target: claude          (switchboard target id — REQUIRED)
 *   description: ...        (shown to the model in the tool listing)
 *   env: FOO=1,BAR=2        (extra env vars injected into the delegate child)
 *   env_deny: AWS_SECRET    (env keys stripped from the delegate child)
 *   max_minutes: 30         (wall-clock ceiling — deadline kill, audited)
 *   model: sonnet           (model hint — fills the {model} template slot)
 *   effort: high            (effort hint — fills the {effort} template slot)
 *   isolate_steering: true  (child skips workdir steering files entirely)
 *   ---
 *   System preamble prepended to every delegated task.
 *
 * env/env_deny/max_minutes/model/effort/isolate_steering shape the child
 * process, so they are honored ONLY for operator-private profiles
 * (<instance>/agents) or when the workdir is project-trusted — a repo-planted
 * profile must never steer the child env, its model choice, or blind it to
 * steering. PAI_* keys can never be set or denied through a profile:
 * enforcement channels (budget, spawn depth, task dir) are not negotiable.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Minimal frontmatter parse — flat `key: value` pairs only. */
function parseProfile(text, fallbackName, { envCapable = false } = {}) {
  const m = FRONT.exec(text);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) fields[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  const name = (fields.name || fallbackName).toLowerCase();
  const target = fields.target ?? process.env.PAI_DELEGATE_DEFAULT_TARGET ?? '';
  if (!target) return null; // a profile without a delegation target is dead config
  const env = {};
  const envDeny = [];
  if (envCapable) {
    for (const pair of String(fields.env ?? '').split(',')) {
      const kv = /^([A-Za-z_][\w]*)=(.*)$/.exec(pair.trim());
      // PAI_* is the enforcement channel — a profile must never set it
      if (kv && !kv[1].startsWith('PAI_')) env[kv[1]] = kv[2];
    }
    for (const k of String(fields.env_deny ?? '').split(',')) {
      const key = k.trim();
      if (/^[A-Za-z_]\w*$/.test(key) && !key.startsWith('PAI_')) envDeny.push(key);
    }
  }
  const maxMin = Number(fields.max_minutes);
  return {
    name,
    target,
    description: fields.description ?? '',
    preamble: m[2].trim(),
    ...(envCapable && Object.keys(env).length ? { env } : {}),
    ...(envCapable && envDeny.length ? { envDeny } : {}),
    ...(envCapable && fields.model ? { model: fields.model } : {}),
    ...(envCapable && fields.effort ? { effort: fields.effort } : {}),
    ...(envCapable && /^(1|true|yes)$/i.test(fields.isolate_steering ?? '') ? { isolateSteering: true } : {}),
    maxMinutes: Number.isFinite(maxMin) && maxMin > 0 ? Math.min(maxMin, 24 * 60) : null,
  };
}

/**
 * Load all profiles from workdir + instance dirs.
 * @returns {Map<string, {name,target,description,preamble}>}
 */
export function loadAgentProfiles({ workdir, instanceRoot, workdirTrusted = false }) {
  const dirs = [
    { dir: join(workdir, '.pai', 'agents'), envCapable: workdirTrusted },
    { dir: join(instanceRoot, 'agents'), envCapable: true }, // operator-private
    // compat: other harnesses' agent dirs, same file shape — workdir-side,
    // env fields gated on project trust like .pai/agents
    { dir: join(workdir, '.cursor', 'agents'), envCapable: workdirTrusted },
    { dir: join(workdir, '.kiro', 'agents'), envCapable: workdirTrusted },
    { dir: join(workdir, '.claude', 'agents'), envCapable: workdirTrusted },
    { dir: join(workdir, '.devin', 'agents'), envCapable: workdirTrusted },
  ];
  const profiles = new Map();
  for (const { dir, envCapable } of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      try {
        const p = parseProfile(readFileSync(join(dir, f), 'utf-8'), basename(f, '.md'), { envCapable });
        if (p && !profiles.has(p.name)) profiles.set(p.name, p);
      } catch { /* unreadable profile files are skipped, not fatal */ }
    }
  }
  return profiles;
}
