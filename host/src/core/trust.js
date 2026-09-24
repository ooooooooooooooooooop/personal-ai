/**
 * Project trust (Pi project-trust.ts analogue, narrowed to our real exposure):
 * files a repo plants under `.pai/microagents/` auto-inject into prompts on
 * keyword match — silent instruction injection from cloned code. Steering and
 * compat files are different: they render as clearly-marked bounded context,
 * which every harness loads unconditionally.
 *
 * A workdir is untrusted until the operator records trust in
 * <instance>/project-trust.json (operator-private — the project can never
 * write its own trust grant). Fail-closed: absent/malformed = untrusted.
 *
 * dedup-h #228 worktree trust (Zed session.trust_all_worktrees analogue):
 * a git worktree is its OWN trust scope by default — same .pai content, but
 * a different path on disk and a different checkout, so the main repo's
 * grant does not automatically cover it. The operator may opt in to
 * inheritance with trustAllWorktrees:true — then a worktree whose MAIN
 * checkout is trusted inherits the grant. Setting is operator-private.
 */
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';

const file = (instanceRoot) => join(instanceRoot, 'project-trust.json');

function readDoc(instanceRoot) {
  try {
    const doc = JSON.parse(readFileSync(file(instanceRoot), 'utf-8'));
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
  } catch { return {}; }
}

function writeDoc(instanceRoot, doc) {
  mkdirSync(instanceRoot, { recursive: true });
  // atomic: a torn store fails closed (all workdirs untrusted) but silently
  // drops every recorded grant — tmp+rename keeps the last good map
  const f = file(instanceRoot);
  const tmp = `${f}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2));
  renameSync(tmp, f);
}

function loadMap(instanceRoot) {
  const doc = readDoc(instanceRoot);
  return doc.workdirs && typeof doc.workdirs === 'object' && !Array.isArray(doc.workdirs)
    ? doc.workdirs
    : {};
}

/**
 * Is `workdir` a git worktree (linked checkout), and where is the main
 * checkout? A linked worktree carries a `.git` FILE reading
 * `gitdir: <main>/.git/worktrees/<name>` — the common dir resolves back to
 * the main checkout's `.git`, whose parent is the trusted-or-not main root.
 */
export function worktreeInfo(workdir) {
  try {
    const p = join(workdir, '.git');
    if (!statSync(p).isFile()) return null; // real .git dir = main checkout
    const m = readFileSync(p, 'utf-8').slice(0, 4096).match(/gitdir:\s*(.+)/i);
    if (!m) return null;
    const gitdir = resolve(workdir, m[1].trim());
    if (!/[\\/]worktrees[\\/][^\\/]+$/.test(gitdir)) return null;
    const commonDir = resolve(gitdir, '..', '..'); // <main>/.git
    return { gitdir, commonDir, mainRoot: dirname(commonDir) };
  } catch { return null; }
}

export function trustAllWorktreesEnabled(instanceRoot) {
  return readDoc(instanceRoot).trustAllWorktrees === true;
}

/** True when `ancestor` path-grant covers `workdir` (self or a strict parent). */
const covers = (ancestor, workdir) => {
  const a = resolve(ancestor);
  const w = resolve(workdir);
  return w === a || w.startsWith(a.endsWith(sep) ? a : a + sep);
};

/**
 * dedup-h #1978 — trust-scope detail: the operator's grant may be exact
 * (this directory only) or recursive (this directory and everything under
 * it). Returns {trusted, scope, grantedBy} — scope is 'exact' | 'recursive'
 * | 'worktree' | null; grantedBy is the path whose grant covers the
 * workdir (itself for exact, an ancestor for recursive inheritance).
 */
export function trustDetail(instanceRoot, workdir) {
  const map = loadMap(instanceRoot);
  const key = resolve(workdir);
  const grant = map[key];
  if (grant === true || grant?.recursive === true) {
    return { trusted: true, scope: grant === true ? 'exact' : 'recursive', grantedBy: key };
  }
  // A recursive grant on an ANCESTOR covers this workdir.
  for (const [k, v] of Object.entries(map)) {
    if (v?.recursive === true && k !== key && covers(k, workdir)) {
      return { trusted: true, scope: 'recursive', grantedBy: k };
    }
  }
  // Opt-in inheritance only — Zed's default (own trust scope) is ours too.
  if (trustAllWorktreesEnabled(instanceRoot)) {
    const wt = worktreeInfo(workdir);
    if (wt && map[resolve(wt.mainRoot)] === true) {
      return { trusted: true, scope: 'worktree', grantedBy: resolve(wt.mainRoot) };
    }
  }
  return { trusted: false, scope: null, grantedBy: null };
}

export function isTrusted(instanceRoot, workdir) {
  return trustDetail(instanceRoot, workdir).trusted;
}

export function setTrust(instanceRoot, workdir, trusted, scope = 'exact') {
  const map = loadMap(instanceRoot);
  const key = resolve(workdir);
  if (trusted) map[key] = scope === 'recursive' ? { recursive: true } : true;
  else delete map[key];
  writeDoc(instanceRoot, { ...readDoc(instanceRoot), workdirs: map }); // preserve flags
  return { workdir: key, trusted: map[key] === true || map[key]?.recursive === true, scope: map[key] === true ? 'exact' : map[key]?.recursive === true ? 'recursive' : null };
}

export function setTrustAllWorktrees(instanceRoot, enabled) {
  const doc = { ...readDoc(instanceRoot) };
  if (enabled === true) doc.trustAllWorktrees = true; else delete doc.trustAllWorktrees;
  writeDoc(instanceRoot, doc);
  return { trustAllWorktrees: doc.trustAllWorktrees === true };
}

/** Detection for the UI prompt — does this workdir even carry injectable content? */
export function hasInjectableContent(workdir) {
  const d = join(workdir, '.pai', 'microagents');
  if (!existsSync(d)) return false;
  try { return readdirSync(d).some((f) => f.endsWith('.md')); } catch { return false; }
}
