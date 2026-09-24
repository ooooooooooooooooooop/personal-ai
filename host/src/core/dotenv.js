/**
 * dotenv — minimal .env loader for the operator's own files.
 *
 * dedup-h #1483 — custom-tool `.env` access analogue: harnesses that ship
 * tools as packages let them read a project `.env`; here the operator's
 * instance-root `.env` (and, under a recorded trust grant, the workdir's)
 * feeds process.env before proxy/tool/hook env consumers run.
 *
 * Trust boundary:
 *  - `<instanceRoot>/.env` is operator-private → always loaded.
 *  - `<workdir>/.env` is agent-writable content → loaded ONLY when the
 *    caller's `trusted` predicate says the workdir has a recorded grant.
 *    An untrusted repo must never steer the daemon's environment.
 *  - Existing process.env always wins (`??=`) — a file never overrides a
 *    real env var the operator exported, so it cannot shadow secrets.
 *  - Parse is line-oriented and total-failure-tolerant: a malformed file
 *    yields whatever valid lines exist; values are never shell-evaluated.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Parse KEY=VALUE lines; `#` comments and `export ` prefixes tolerated. */
export function parseDotEnv(text) {
  const out = {};
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trimStart();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) {
      val = val.slice(1, -1);
      if (raw.includes('"')) val = val.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
    }
    out[key] = val;
  }
  return out;
}

/**
 * Load `<instanceRoot>/.env` always, `<workdir>/.env` only when trusted.
 * Returns key NAMES only — values never enter logs/audits.
 */
export function loadDotEnv(instanceRoot, workdir, { trusted = () => false, env = process.env } = {}) {
  const loaded = { instance: [], workdir: [] };
  const apply = (file, bucket) => {
    let text;
    try { text = readFileSync(file, 'utf-8'); } catch { return; }
    for (const [k, v] of Object.entries(parseDotEnv(text))) {
      if (env[k] === undefined) { env[k] = v; bucket.push(k); }
    }
  };
  if (instanceRoot) apply(join(instanceRoot, '.env'), loaded.instance);
  if (workdir && trusted()) apply(join(workdir, '.env'), loaded.workdir);
  return loaded;
}
