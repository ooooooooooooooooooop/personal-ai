/**
 * Steering files (Kiro steering equivalent) — `.pai/steering/*.md` (and
 * `.pai/{product,structure,tech}.md` conventions) loaded into the live
 * context envelope every turn, so they survive compaction like the rest
 * of the world-model projection.
 *
 * Compat paths (Devin multi-source loading analogue): `.claude/rules/*.md`,
 * `.cursor/rules/*.md`, `.cursor/rules/*.mdc`, `.windsurf/rules/*.md`,
 * `.devin/rules/*.md` are read as additional steering files — teams migrating
 * off other harnesses keep their rule docs working without copying.
 *
 * Steering is project guidance — context-channel content, NOT instruction
 * channel: it rides the same untrusted-ish envelope the rest of the
 * briefing does and cannot weaken policy. Bounded per file and in total —
 * a giant steering doc must not eat the context window.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PER_FILE_MAX = 16 * 1024;
const TOTAL_MAX = 32 * 1024;
const NAMED = ['product.md', 'structure.md', 'tech.md'];
// Rule directories other harnesses planted — read as compat steering sources.
const COMPAT_DIRS = ['.claude/rules', '.cursor/rules', '.windsurf/rules', '.devin/rules'];

/**
 * @param {string} workdir
 * @returns {string|null} rendered steering block, or null when no files.
 */
export function loadSteering(workdir) {
  const files = [];
  const steeringDir = join(workdir, '.pai', 'steering');
  if (existsSync(steeringDir)) {
    for (const f of readdirSync(steeringDir).filter((x) => x.endsWith('.md')).sort()) {
      files.push({ name: `steering/${f}`, path: join(steeringDir, f) });
    }
  }
  for (const f of NAMED) {
    const p = join(workdir, '.pai', f);
    if (existsSync(p)) files.push({ name: f, path: p });
  }
  // Compat rule dirs from other harnesses — same context-channel semantics,
  // files stay read-only guidance, never authority.
  for (const d of COMPAT_DIRS) {
    const dir = join(workdir, d);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => /\.(md|mdc)$/i.test(x)).sort()) {
      files.push({ name: `${d}/${f}`, path: join(dir, f) });
    }
  }
  if (!files.length) return null;

  let out = '';
  for (const f of files) {
    if (out.length >= TOTAL_MAX) break;
    let body = '';
    try { body = readFileSync(f.path, 'utf-8').slice(0, PER_FILE_MAX); } catch { continue; }
    out += `\n<steering-file name="${f.name}">\n${body}\n</steering-file>\n`;
  }
  return out.trim() || null;
}
