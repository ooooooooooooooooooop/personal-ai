/**
 * repo_map — bounded structural outline of the workspace (Aider repo-map
 * analogue, dependency-free edition): directory-scoped file tree with
 * top-level symbol extraction via per-language declaration regexes.
 *
 * No PageRank, no tree-sitter — the honest v1: the model gets the same
 * "where do things live" skeleton a human builds by skimming the tree,
 * inside a token budget, with .paiignore exclusions honored.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, extname, sep } from 'node:path';

const SRC_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs',
  '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php', '.swift', '.kt',
]);
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', '__pycache__',
  '.venv', 'venv', '.next', '.turbo', 'coverage', '.taskflow',
]);
const MAX_FILES = 400;
const MAX_FILE_BYTES = 256 * 1024;

// Top-level declaration patterns per language family. Intentionally
// conservative — a missed symbol costs little, a false-positive line lies.
const DEFS = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm, tag: 'fn' },
  { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm, tag: 'class' },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/gm, tag: 'fn' },
  { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm, tag: 'iface' },
  { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/gm, tag: 'type' },
  { re: /^\s*(?:export\s+)?(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, tag: 'fn' },
  { re: /^\s*class\s+([A-Za-z_]\w*)[\s(:]/gm, tag: 'class' },
  { re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm, tag: 'fn' },
  { re: /^\s*(?:pub\s+)?(?:struct|enum|trait|impl)\s+([A-Za-z_]\w*)/gm, tag: 'type' },
  { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, tag: 'fn' },
  { re: /^\s*(?:public|private|protected|static|final|abstract|\s)*\s*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/gm, tag: 'class' },
];

function symbolsFor(file) {
  let src;
  try {
    const st = statSync(file);
    if (st.size > MAX_FILE_BYTES) return [];
    src = readFileSync(file, 'utf-8');
  } catch { return []; }
  const out = [];
  for (const { re, tag } of DEFS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) && out.length < 24) out.push(`${tag} ${m[1]}`);
  }
  return out;
}

/**
 * @param {string} workdir
 * @param {object} [opts]
 * @param {(rel:string)=>boolean} [opts.isIgnored] .paiignore predicate
 * @param {string} [opts.subdir] limit the map to a subtree
 * @param {number} [opts.maxChars] output budget (~4 chars/token)
 * @returns {{text:string, files:number, symbols:number, truncated:boolean}}
 */
export function buildRepoMap(workdir, { isIgnored = null, subdir = null, maxChars = 12000 } = {}) {
  const base = subdir ? join(workdir, subdir) : workdir;
  // confinement: the operator channel also accepts subdir — never walk outside
  const resolved = resolve(base);
  if (subdir && resolved !== resolve(workdir) && !resolved.startsWith(resolve(workdir) + sep)) {
    return { text: '', files: 0, symbols: 0, truncated: false, error: 'subdir escapes the workspace' };
  }
  if (!existsSync(base)) return { text: '', files: 0, symbols: 0, truncated: false, error: `not found: ${subdir}` };
  const lines = [];
  let files = 0, symbols = 0, truncated = false;
  const walk = (dir, depth) => {
    if (files >= MAX_FILES || truncated || depth > 8) return;
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      if (files >= MAX_FILES) { truncated = true; return; }
      if (e.name.startsWith('.') && e.name !== '.pai') continue;
      const p = join(dir, e.name);
      const rel = relative(workdir, p).split(sep).join('/');
      if (isIgnored?.(rel)) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(p, depth + 1);
      } else if (SRC_EXT.has(extname(e.name).toLowerCase())) {
        files += 1;
        const syms = symbolsFor(p);
        symbols += syms.length;
        lines.push(syms.length ? `${rel}: ${syms.join(', ')}` : rel);
      }
    }
  };
  walk(base, 0);
  let text = lines.join('\n');
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n… (map truncated at ${maxChars} chars — narrow with a subdir)`;
    truncated = true;
  }
  return { text, files, symbols, truncated };
}
