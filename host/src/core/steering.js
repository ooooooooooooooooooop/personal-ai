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
  const manual = [];
  for (const f of files) {
    if (out.length >= TOTAL_MAX) break;
    let body = '';
    try { body = readFileSync(f.path, 'utf-8').slice(0, PER_FILE_MAX); } catch { continue; }
    const fm = parseFrontmatter(body);
    // Trae/Kiro apply modes: 'manual' rules are not auto-injected — they are
    // indexed by name so the model reads them on demand. 'globs' rules are
    // injected with their declared scope attribute; conditional injection by
    // touched path is the v2 refinement (declared scope is honest about it).
    if (fm.apply === 'manual') { manual.push(f.name); continue; }
    const scope = fm.globs?.length ? ` scope="${fm.globs.join(', ')}"` : '';
    out += `\n<steering-file name="${f.name}"${scope}>\n${fm.body}\n</steering-file>\n`;
  }
  if (manual.length) {
    out += `\n<manual-rules>${manual.join(', ')}</manual-rules>\n`;
  }
  return out.trim() || null;
}

/**
 * Minimal YAML-frontmatter reader for steering apply modes.
 *   ---
 *   apply: always|manual     (default always)
 *   globs: ["src/**"]  or  globs: src/**, tests/**
 *   ---
 * Returns { apply, globs, body } — body has the frontmatter block removed.
 */
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { apply: 'always', globs: null, body: raw };
  const fm = m[1];
  const apply = (fm.match(/^apply:\s*(\w+)/m)?.[1] ?? 'always').toLowerCase();
  let globs = null;
  const inline = fm.match(/^globs:\s*\[([^\]]*)\]/m);
  const plain = fm.match(/^globs:\s*(.+)$/m);
  const rawGlobs = inline ? inline[1] : plain?.[1];
  if (rawGlobs) {
    globs = rawGlobs.split(',')
      .map((g) => g.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean).slice(0, 20);
  }
  return { apply, globs, body: raw.slice(m[0].length) };
}
