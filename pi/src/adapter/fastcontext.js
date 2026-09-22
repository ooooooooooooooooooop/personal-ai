/**
 * fast_context — M140 read-only high-speed retrieval (Fast Context
 * subagent analogue): one bounded call that does what a search subagent
 * would — locate the files and line ranges relevant to a query — without
 * spending model turns on read/grep round-trips.
 *
 * Properties:
 *  - READ-ONLY: it walks and reads, never writes — no write lease, no
 *    fileops receipts, nothing to undo.
 *  - BOUNDED: file count, per-file bytes, walked depth, and emitted
 *    results are all capped; the tool degrades honestly (reports the
 *    truncation) instead of scanning forever.
 *  - RANKED: filename hits outrank content hits; content hits carry the
 *    matching line numbers + a snippet so the caller can jump straight
 *    to a read window instead of re-grepping.
 *  - POLICY-RESPECTING: .paiignore exclusions hold (same predicate the
 *    repo_map tool uses) and subdir cannot escape the workdir.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.taskflow', '.grepai', '.claude', '__pycache__']);
const SRC_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java',
  '.rb', '.php', '.cs', '.cpp', '.c', '.h', '.hpp', '.md', '.txt', '.json',
  '.yaml', '.yml', '.toml', '.sh', '.ps1', '.sql', '.html', '.css',
]);
const MAX_FILES = 20000;
const MAX_DEPTH = 10;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_RESULTS_CAP = 40;
const SNIPPET_LEN = 120;

const err = (text) => ({ content: [{ type: 'text', text }], isError: true });
const ok = (text, details) => ({ content: [{ type: 'text', text }], details });

function termsOf(query) {
  // identifier-ish tokens; longer tokens first so specific terms dominate
  const terms = String(query).match(/[A-Za-z_$][\w$]{1,60}|[一-鿿]{2,20}/g) ?? [];
  return [...new Set(terms.map((t) => t.toLowerCase()))].slice(0, 24);
}

export function fastContextTool({ workdir, getIgnored = null }) {
  const root = resolve(workdir);
  return {
    name: 'fast_context',
    label: 'Fast Context',
    description:
      'Read-only retrieval: locate the files and line ranges relevant to a ' +
      'query without burning turns on read/grep round-trips. Returns ranked ' +
      'paths with matching line numbers and snippets. Read-only and bounded — ' +
      'no writes, capped scan, .paiignore honored.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'natural-language or identifier query' },
        subdir: { type: 'string', description: 'limit the scan to a subtree (relative path)' },
        max_results: { type: 'number', description: `cap on returned files (default 12, max ${MAX_RESULTS_CAP})` },
      },
      required: ['query'],
    },
    async execute(_id, params) {
      const terms = termsOf(params?.query);
      if (!terms.length) return err('fast_context: query produced no searchable terms');
      const maxResults = Math.min(Math.max(1, params?.max_results ?? 12), MAX_RESULTS_CAP);

      const base = params?.subdir ? resolve(root, params.subdir) : root;
      if (params?.subdir && base !== root && !base.startsWith(root + sep)) {
        return err(`fast_context: subdir '${params.subdir}' escapes the workspace`);
      }
      if (!existsSync(base)) return err(`fast_context: not found: ${params?.subdir ?? workdir}`);

      // pass 1 — bounded walk collecting candidate text files
      const files = []; // {rel, abs}
      let walkTruncated = false;
      const walk = (dir, depth) => {
        if (files.length >= MAX_FILES || walkTruncated || depth > MAX_DEPTH) { walkTruncated = files.length >= MAX_FILES; return; }
        let ents;
        try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (files.length >= MAX_FILES) { walkTruncated = true; return; }
          const p = join(dir, e.name);
          const rel = relative(root, p).split(sep).join('/');
          if (getIgnored?.(rel)) continue;
          if (e.isDirectory()) {
            if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
            walk(p, depth + 1);
          } else if (SRC_EXT.has(extname(e.name).toLowerCase())) {
            try {
              if (statSync(p).size <= MAX_FILE_BYTES) files.push({ rel, abs: p });
            } catch { /* vanished mid-walk */ }
          }
        }
      };
      walk(base, 0);

      // pass 2 — score: filename hits dominate; content hits carry line numbers
      const scored = [];
      for (const f of files) {
        const nameLc = f.rel.toLowerCase();
        let score = 0;
        const nameHits = terms.filter((t) => nameLc.includes(t)).length;
        score += nameHits * 10;
        let src = null;
        const lines = []; // {line, text, hits}
        try { src = readFileSync(f.abs, 'utf-8'); } catch { continue; }
        const srcLines = src.split('\n');
        for (let i = 0; i < srcLines.length && lines.length < 8; i++) {
          const l = srcLines[i];
          const ll = l.toLowerCase();
          const hits = terms.filter((t) => ll.includes(t)).length;
          if (hits) {
            score += hits;
            lines.push({ line: i + 1, text: l.trim().slice(0, SNIPPET_LEN), hits });
          }
        }
        if (score > 0) scored.push({ rel: f.rel, score, lines });
      }
      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, maxResults);

      if (!top.length) {
        return ok(`fast_context: no matches for ${terms.join(', ')} in ${files.length} files` +
          (walkTruncated ? ` (scan truncated at ${MAX_FILES} files)` : ''), { results: [], truncated: walkTruncated });
      }
      const body = top.map((r) =>
        `${r.rel}  (score ${r.score})\n` +
        r.lines.slice(0, 4).map((l) => `    ${l.line}: ${l.text}`).join('\n'),
      ).join('\n');
      return ok(
        `fast_context: ${top.length}/${scored.length} relevant of ${files.length} files` +
        (walkTruncated ? ` (scan truncated at ${MAX_FILES})` : '') + `\n\n${body}`,
        { results: top, truncated: walkTruncated || scored.length > top.length },
      );
    },
  };
}
