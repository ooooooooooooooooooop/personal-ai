/**
 * Subagent profiles — frontmatter-defined delegation personas
 * (Claude Code .claude/agents analogue, reduced to what our delegation bridge
 * actually consumes: a switchboard target + a task preamble).
 *
 * Discovery order (first hit wins on name collision):
 *   <workdir>/.pai/agents/*.md   project-local profiles
 *   <instance>/agents/*.md       user-level profiles
 *
 * File shape:
 *   ---
 *   name: reviewer          (defaults to filename stem)
 *   target: claude          (switchboard target id — REQUIRED)
 *   description: ...        (shown to the model in the tool listing)
 *   ---
 *   System preamble prepended to every delegated task.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Minimal frontmatter parse — flat `key: value` pairs only. */
function parseProfile(text, fallbackName) {
  const m = FRONT.exec(text);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) fields[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  const name = (fields.name || fallbackName).toLowerCase();
  const target = fields.target ?? '';
  if (!target) return null; // a profile without a delegation target is dead config
  return {
    name,
    target,
    description: fields.description ?? '',
    preamble: m[2].trim(),
  };
}

/**
 * Load all profiles from workdir + instance dirs.
 * @returns {Map<string, {name,target,description,preamble}>}
 */
export function loadAgentProfiles({ workdir, instanceRoot }) {
  const dirs = [
    join(workdir, '.pai', 'agents'),
    join(instanceRoot, 'agents'),
  ];
  const profiles = new Map();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      try {
        const p = parseProfile(readFileSync(join(dir, f), 'utf-8'), basename(f, '.md'));
        if (p && !profiles.has(p.name)) profiles.set(p.name, p);
      } catch { /* unreadable profile files are skipped, not fatal */ }
    }
  }
  return profiles;
}
