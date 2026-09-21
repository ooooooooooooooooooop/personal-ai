/**
 * .paiignore — workdir context-exclusion file (Kiro .kiroignore / Roo
 * .rooignore equivalent). Paths matching it are refused for BOTH read and
 * write families in the decide chain: an excluded path is invisible AND
 * untouchable — a secret dir the agent can still delete is not excluded.
 *
 * Syntax is gitignore-flavored minimalism:
 *   # comment
 *   secrets/        → that subtree (leading-slash optional)
 *   *.pem           → basename glob
 *   ** /gen/**      → ** matches any depth
 * The file is agent-writable — which is FINE for context exclusion (the
 * agent could ignore more, never less: patterns only add restrictions).
 * A pattern can never grant access — the check only blocks.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

function globToRe(pat) {
  // escape regex chars except * ? then translate: ** → .*, * → [^/]*, ? → .
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') {
      if (pat[i + 1] === '*') { re += '.*'; i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return re;
}

export class PaiIgnore {
  /**
   * @param {string} workdir
   * @param {string} [text] — test injection; otherwise reads <workdir>/.paiignore
   */
  constructor(workdir, text = null) {
    this.workdir = workdir;
    this.patterns = [];
    const body = text ?? (existsSync(join(workdir, '.paiignore')) ? readFileSync(join(workdir, '.paiignore'), 'utf-8') : '');
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      this.patterns.push(this.#compile(line));
    }
  }

  #compile(line) {
    const dirOnly = line.endsWith('/');
    const anchored = line.startsWith('/');
    const pat = line.replace(/^\/+/, '').replace(/\/+$/, '');
    // '/'-prefixed or path patterns anchor at the workdir root; basename
    // patterns (no '/') match at any depth — gitignore semantics.
    const re = (anchored || pat.includes('/'))
      ? new RegExp(`^${globToRe(pat)}(/|$)`)
      : new RegExp(`^(.*/)?${globToRe(pat)}(/|$)`);
    return { raw: line, dirOnly, re };
  }

  get loaded() { return this.patterns.length > 0; }

  /** @param {string} absPath — absolute path to test (workdir-relative check) */
  isIgnored(absPath) {
    if (!absPath) return false;
    const rel = absPath.startsWith(this.workdir)
      ? absPath.slice(this.workdir.length).replace(/^[\\/]+/, '')
      : absPath;
    const norm = rel.split(sep).join('/');
    for (const p of this.patterns) {
      if (p.re.test(norm)) return true;
    }
    return false;
  }
}
