/**
 * Path confinement helpers — real containment checks, not string prefixes.
 *
 * `startsWith(root)` is the classic sibling-prefix escape: root `/state/pai`
 * accepts `/state/pai-evil/x.json`. Containment must be computed on the
 * relative path, and for EXISTING files on the resolved real path (a symlink
 * inside the root may point outside it).
 */
import { isAbsolute, relative, resolve, sep, dirname } from 'node:path';
import { realpathSync } from 'node:fs';

/** True when `candidate` resolves to the root itself or a path inside it. */
export function pathInsideRoot(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * True when `candidate` is inside root AND (when it already exists) its real
 * path is still inside root — defeats in-root symlinks pointing outside.
 */
export function pathInsideRootReal(root, candidate) {
  if (!pathInsideRoot(root, candidate)) return false;
  try {
    return pathInsideRoot(root, realpathSync(resolve(candidate)));
  } catch {
    return true; // nonexistent target (export destination) — lexical check stands
  }
}

/**
 * Write-target containment (M96 second half): lexical checks alone cannot see
 * a SYMLINKED PARENT — `root/escape -> /outside` makes `root/escape/out.json`
 * lexically inside while writeFileSync follows the link out. For a write the
 * parent must already exist, so: lexical inside + realpath(parent) inside
 * realpath(root) + (if the target exists) realpath(target) inside too.
 */
export function pathInsideRootForWrite(root, candidate) {
  const abs = resolve(candidate);
  if (!pathInsideRoot(root, abs)) return false;
  let realRoot;
  try { realRoot = realpathSync(resolve(root)); } catch { return false; }
  // the parent must already exist for writeFileSync — verify its REAL path
  try {
    if (!pathInsideRoot(realRoot, realpathSync(dirname(abs)))) return false;
  } catch { return false; }
  try {
    return pathInsideRoot(realRoot, realpathSync(abs)); // existing target — follow links
  } catch {
    return true; // target does not exist yet — verified parent will host it
  }
}
