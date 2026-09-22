/**
 * repo_map — bounded structural outline of the workspace (Aider repo-map
 * analogue, dependency-free edition): directory-scoped file tree with
 * top-level symbol extraction via per-language declaration regexes.
 *
 * Importance ranking (Aider's core insight, ported without tree-sitter):
 * files are nodes in an IMPORT GRAPH — a file many others import is load-
 * bearing context; a leaf nobody references is detail. PageRank over that
 * graph decides what survives when the token budget squeezes: symbols of
 * low-rank files degrade to bare paths first, then the lowest-ranked files
 * drop out entirely. Alphabetical tail-cutting used to silently drop a
 * pivotal z-file while keeping an unreferenced a-file — that lie is gone.
 *
 * Edge extraction is deliberately conservative: JS/TS import/require,
 * Python import/from, C-family quoted #include, Rust mod. Unresolvable
 * specifiers (node_modules, stdlib) simply contribute no edge.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, extname, dirname, sep } from 'node:path';

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

// Import-edge patterns: capture the raw specifier; resolution decides if it
// names another workspace file. Bare package names never resolve — fine.
const IMPORTS = [
  /(?:import|export)\s+(?:[\w${}*,\s]+\s+from\s+)?['"]([^'"]+)['"]/g, // ES import/export-from
  /require\(\s*['"]([^'"]+)['"]\s*\)/g,                              // CJS require
  /^\s*from\s+([\w.]+)\s+import\s/gm,                                // python from a.b import c
  /^\s*import\s+([\w.]+)/gm,                                         // python import a.b
  /^\s*#\s*include\s+"([^"]+)"/gm,                                   // C-family quoted include
  /^\s*(?:pub\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm,                       // rust mod x;
];

function readSource(file) {
  try {
    const st = statSync(file);
    if (st.size > MAX_FILE_BYTES) return null;
    return readFileSync(file, 'utf-8');
  } catch { return null; }
}

function symbolsFrom(src) {
  const out = [];
  for (const { re, tag } of DEFS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) && out.length < 24) out.push(`${tag} ${m[1]}`);
  }
  return out;
}

/** Extract raw import specifiers from source text. */
function importSpecs(src) {
  const out = [];
  for (const re of IMPORTS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) out.push(m[1]);
  }
  return out;
}

/**
 * Resolve one specifier to a workspace-relative file path, or null.
 * Only same-workspace resolutions count as edges — external packages and
 * stdlib modules contribute nothing to the importance graph.
 */
function resolveSpec(spec, fromRel, fileSet) {
  const tryCandidates = (baseNoExt) => {
    const cands = [baseNoExt];
    for (const ext of SRC_EXT) cands.push(baseNoExt + ext);
    for (const ext of SRC_EXT) cands.push(`${baseNoExt}/index${ext}`);
    for (const c of cands) if (fileSet.has(c)) return c;
    return null;
  };
  if (spec.startsWith('./') || spec.startsWith('../')) {
    // relative to the importing file's directory
    const base = join(dirname(fromRel), spec).split(sep).join('/');
    return tryCandidates(base);
  }
  if (/^[\w-]+(\.[\w-]+)+$/.test(spec)) {
    // python dotted module: a.b.c → a/b/c(.py), tried from the repo root and
    // from the importer's directory (both conventions exist in the wild)
    const asPath = spec.replace(/\./g, '/');
    return tryCandidates(asPath) ?? tryCandidates(join(dirname(fromRel), asPath).split(sep).join('/'));
  }
  return null; // bare package / stdlib / alias — no edge
}

/**
 * PageRank over the import graph. d=0.85, fixed 30 iterations — at ≤400
 * nodes this is microseconds; convergence epsilon is not worth the branch.
 * Returns Map(rel → score). Isolated files share the teleport mass evenly,
 * so a no-edge repo degrades to uniform scores (selection falls back to
 * tree order among equals).
 */
function pageRank(nodes, edges) {
  const n = nodes.length;
  const scores = new Map(nodes.map((r) => [r, 1 / n]));
  if (!edges.length) return scores;
  const out = new Map(); // rel → [targets]
  for (const [a, b] of edges) {
    if (!out.has(a)) out.set(a, []);
    out.get(a).push(b);
  }
  const d = 0.85;
  for (let iter = 0; iter < 30; iter++) {
    const next = new Map(nodes.map((r) => [r, (1 - d) / n]));
    let dangling = 0;
    for (const r of nodes) {
      const targets = out.get(r);
      const s = scores.get(r);
      if (!targets?.length) { dangling += s; continue; }
      const share = (d * s) / targets.length;
      for (const t of targets) next.set(t, next.get(t) + share);
    }
    const dShare = (d * dangling) / n;
    for (const r of nodes) next.set(r, next.get(r) + dShare);
    for (const [k, v] of next) scores.set(k, v);
  }
  return scores;
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

  // pass 1: walk + read once (symbols AND import edges come from the same read)
  const entries = []; // {rel, src, syms}
  let truncated = false;
  const walk = (dir, depth) => {
    if (entries.length >= MAX_FILES || truncated || depth > 8) return;
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      if (entries.length >= MAX_FILES) { truncated = true; return; }
      if (e.name.startsWith('.') && e.name !== '.pai') continue;
      const p = join(dir, e.name);
      const rel = relative(workdir, p).split(sep).join('/');
      if (isIgnored?.(rel)) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(p, depth + 1);
      } else if (SRC_EXT.has(extname(e.name).toLowerCase())) {
        const src = readSource(p) ?? '';
        entries.push({ rel, src, syms: src ? symbolsFrom(src) : [] });
      }
    }
  };
  walk(base, 0);

  // pass 2: importance graph — import edges between walked files, PageRank
  const fileSet = new Set(entries.map((e) => e.rel));
  const edges = [];
  for (const e of entries) {
    for (const spec of importSpecs(e.src)) {
      const target = resolveSpec(spec, e.rel, fileSet);
      if (target && target !== e.rel) edges.push([e.rel, target]);
    }
  }
  const rank = pageRank(entries.map((e) => e.rel), edges);

  // pass 3: budget-aware emission. Lines stay in tree order (the map is a
  // "where do things live" skeleton), but WHAT survives is rank-decided:
  // over budget → low-rank files lose symbol detail first, then the lowest-
  // ranked files drop out entirely. The truncated flag now means "rank-
  // filtered", and the notice says how much was dropped.
  const withLines = entries.map((e) => ({
    ...e,
    score: rank.get(e.rel) ?? 0,
    full: e.syms.length ? `${e.rel}: ${e.syms.join(', ')}` : e.rel,
  }));
  const totalFull = withLines.reduce((s, e) => s + e.full.length + 1, 0);
  let text;
  let droppedDetail = 0;
  let droppedFiles = 0;
  if (totalFull <= maxChars) {
    text = withLines.map((e) => e.full).join('\n');
  } else {
    // degrade: strip symbols from the LOWEST-ranked files until the budget fits
    const byRankAsc = [...withLines].sort((a, b) => a.score - b.score);
    const stripped = new Set();
    let size = totalFull;
    for (const e of byRankAsc) {
      if (size <= maxChars) break;
      if (e.full !== e.rel) {
        stripped.add(e.rel);
        size -= e.full.length - e.rel.length;
        droppedDetail += 1;
      }
    }
    let lines = withLines.map((e) => (stripped.has(e.rel) ? e.rel : e.full));
    // still over → drop the lowest-ranked FILES entirely (a bare path whose
    // rank is negligible informs nobody)
    if (lines.join('\n').length > maxChars) {
      const keep = new Set();
      let budget = maxChars;
      for (const e of [...withLines].sort((a, b) => b.score - a.score)) {
        const line = stripped.has(e.rel) ? e.rel : e.full;
        if (budget - (line.length + 1) < 0 && keep.size > 0) continue;
        keep.add(e.rel);
        budget -= line.length + 1;
      }
      const before = lines.length;
      lines = withLines.filter((e) => keep.has(e.rel)).map((e) => (stripped.has(e.rel) ? e.rel : e.full));
      droppedFiles = before - lines.length;
      droppedDetail = 0; // detail accounting folds into the dropped notice
    }
    text = lines.join('\n');
    text += `\n… (map rank-filtered to ${maxChars} chars: ${droppedFiles} files dropped, ${droppedDetail} files path-only — narrow with a subdir to see more)`;
    truncated = true;
  }
  const symbols = withLines.reduce((s, e) => s + e.syms.length, 0);
  return { text, files: entries.length, symbols, truncated };
}
