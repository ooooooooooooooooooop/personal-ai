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
 */
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const file = (instanceRoot) => join(instanceRoot, 'project-trust.json');

function loadMap(instanceRoot) {
  try {
    const doc = JSON.parse(readFileSync(file(instanceRoot), 'utf-8'));
    return doc && typeof doc === 'object' && doc.workdirs && typeof doc.workdirs === 'object'
      ? doc.workdirs
      : {};
  } catch { return {}; }
}

export function isTrusted(instanceRoot, workdir) {
  return loadMap(instanceRoot)[resolve(workdir)] === true;
}

export function setTrust(instanceRoot, workdir, trusted) {
  const map = loadMap(instanceRoot);
  const key = resolve(workdir);
  if (trusted) map[key] = true; else delete map[key];
  mkdirSync(instanceRoot, { recursive: true });
  // atomic: a torn store fails closed (all workdirs untrusted) but silently
  // drops every recorded grant — tmp+rename keeps the last good map
  const f = file(instanceRoot);
  const tmp = `${f}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ workdirs: map }, null, 2));
  renameSync(tmp, f);
  return { workdir: key, trusted: map[key] === true };
}

/** Detection for the UI prompt — does this workdir even carry injectable content? */
export function hasInjectableContent(workdir) {
  const d = join(workdir, '.pai', 'microagents');
  if (!existsSync(d)) return false;
  try { return readdirSync(d).some((f) => f.endsWith('.md')); } catch { return false; }
}
