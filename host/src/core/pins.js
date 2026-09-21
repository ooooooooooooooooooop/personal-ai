/**
 * Pinned context files (CodeArts `/context add` analogue) — `.pai/pins.json`
 * holds workdir-relative paths whose LIVE contents ride the context envelope
 * every turn. Unlike a one-shot @-mention, a pin survives compaction and
 * re-reads the file each turn, so edits stay visible.
 *
 * Boundaries: pinned content is workspace DATA, not instruction — rendered
 * inside <pinned-file> data blocks under the standing untrusted rule. Paths
 * must resolve inside the workdir (no absolute/out-of-tree pins). Bounded
 * per file and in total. .paiignore-excluded paths refuse at add time AND
 * are skipped at render time — context exclusion wins over pinning.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const PER_FILE_MAX = 16 * 1024;
const TOTAL_MAX = 48 * 1024;
const MAX_PINS = 50;

const pinFile = (workdir) => join(workdir, '.pai', 'pins.json');

function readList(workdir) {
  try {
    const doc = JSON.parse(readFileSync(pinFile(workdir), 'utf-8'));
    return (Array.isArray(doc?.paths) ? doc.paths : []).map((p) => String(p)).filter(Boolean).slice(0, MAX_PINS);
  } catch { return []; }
}

function safeResolve(workdir, rel) {
  const abs = resolve(workdir, rel);
  const root = resolve(workdir);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

/**
 * Render the pin block for the context envelope.
 * @param {string} workdir
 * @param {(rel:string)=>boolean} [isIgnored] .paiignore check
 * @returns {string|null}
 */
export function loadPins(workdir, { isIgnored = null } = {}) {
  const paths = readList(workdir);
  if (!paths.length) return null;
  let out = '';
  for (const rel of paths) {
    if (out.length >= TOTAL_MAX) break;
    if (isIgnored?.(rel)) continue;
    const abs = safeResolve(workdir, rel);
    if (!abs || !existsSync(abs)) continue;
    let body = '';
    try { body = readFileSync(abs, 'utf-8').slice(0, PER_FILE_MAX); } catch { continue; }
    out += `\n<pinned-file path="${rel}">\n${body}\n</pinned-file>\n`;
  }
  return out.trim() || null;
}

/**
 * Add/remove/list pins. Paths are stored workdir-relative, validated to stay
 * inside the tree. Returns { paths } or { error }.
 */
export function editPins(workdir, op, relPath = null, { isIgnored = null } = {}) {
  const paths = readList(workdir);
  if (op === 'list') return { paths };
  const rel = String(relPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel) return { error: 'pins requires a workdir-relative path' };
  const abs = safeResolve(workdir, rel);
  if (!abs) return { error: `path '${rel}' escapes the workdir` };
  if (op === 'add') {
    if (!existsSync(abs)) return { error: `'${rel}' does not exist` };
    if (isIgnored?.(rel)) return { error: `'${rel}' is excluded by .paiignore — context-excluded paths cannot be pinned` };
    if (paths.includes(rel)) return { paths, unchanged: true };
    if (paths.length >= MAX_PINS) return { error: `pin limit ${MAX_PINS} reached` };
    paths.push(rel);
  } else if (op === 'remove') {
    const i = paths.indexOf(rel);
    if (i < 0) return { error: `'${rel}' is not pinned` };
    paths.splice(i, 1);
  } else {
    return { error: `unknown pins op '${op}'` };
  }
  mkdirSync(join(workdir, '.pai'), { recursive: true });
  writeFileSync(pinFile(workdir), JSON.stringify({ paths }, null, 2) + '\n');
  return { paths };
}
