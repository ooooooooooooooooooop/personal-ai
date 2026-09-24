/**
 * Multi-root workspace feature flag (dedup-h #1475): a body normally sees
 * exactly one workdir — every boundary gate (read/write outside-workspace
 * asks) is adjudicated against that single root. An operator may opt into
 * declaring ADDITIONAL roots in <instance>/workspace.json:
 *
 *   { "multiRoot": true, "roots": ["D:/shared-lib", "C:/refs/specs"] }
 *
 * Semantics:
 * - `multiRoot` is THE FLAG: absent/false/non-object doc → single-root
 *   legacy behavior, byte-for-byte identical to before.
 * - `roots` are extra directories the boundary gates treat as inside the
 *   workspace. They are operator-private config (the instance root is not
 *   agent-writable) — an agent-editable file must never widen the boundary,
 *   so there is deliberately no workdir-side declaration file and no
 *   channel command that model traffic could reach.
 * - Entries are normalized to absolute paths; non-strings, empty strings
 *   and duplicates are dropped. A nonexistent root is harmless — it simply
 *   matches nothing until it exists (the realpath checks tolerate it).
 * - Cap: 32 extra roots — a runaway config degrades to the first entries,
 *   never to unbounded root scanning per tool call.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const MAX_ROOTS = 32;

export function loadWorkspaceRoots(instanceRoot) {
  if (!instanceRoot) return { multiRoot: false, roots: [] };
  let doc;
  try {
    doc = JSON.parse(readFileSync(join(instanceRoot, 'workspace.json'), 'utf-8'));
  } catch (e) {
    if (e?.code === 'ENOENT') return { multiRoot: false, roots: [] };
    return { multiRoot: false, roots: [], error: `workspace.json unreadable: ${e.message}` };
  }
  if (doc?.multiRoot !== true) return { multiRoot: false, roots: [] };
  const seen = new Set();
  const roots = [];
  for (const raw of Array.isArray(doc?.roots) ? doc.roots : []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const abs = isAbsolute(raw) ? resolve(raw) : null; // relative roots are meaningless — dropped
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    roots.push(abs);
    if (roots.length >= MAX_ROOTS) break;
  }
  return { multiRoot: true, roots };
}
