// dedup-h #333 — instance state backup/verify (OpenClaw `backup
// create`/`backup verify` analogue).
//
// `create` snapshots the instance's DURABLE state into a timestamped
// bundle directory carrying a sha256 manifest; `verify` re-hashes every
// listed file and reports missing/mismatch/extra honestly.
//
// Two deliberate boundaries:
//  - ALLOWLIST, not whole-tree copy: only known state paths are bundled.
//    A recursive copy would sweep in volatile dirs (spool/, exports/,
//    audit/) and any secret an operator dropped next to them.
//  - SECRETS NEVER BACKED UP: auth/token/credential-shaped files are
//    device-bound — copying them into a portable bundle is both an
//    exfiltration risk and useless on restore (they re-auth anyway).
//    Exclusions are recorded in the manifest so a verify can see what
//    was deliberately left out.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const STATE_PATHS = [
  'registry.json',
  'sessions',
  'memory',
  'tasks',
  'schedules',
  'schedules.json',
  'receipts',
  'model-fallbacks.json',
  'models-allow.json',
  'feature-models.json',
  'commands.json',
  'egress-allow.json',
  'sandbox-exclude.json',
  'proxy.json',
  'hooks.json',
  'heartbeat.json',
  'model-routes.json',
  'macros.json',
];

const SECRET_RE = /auth|token|secret|credential|apikey|api[-_]?key|\.pem$|\.key$/i;

function* walk(dir) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Snapshot durable instance state into <outDir>/<backup-ISOts>/.
 * Returns { dir, files, skippedSecrets, manifest }.
 */
export function createBackup(instanceRoot, outDir = null) {
  if (!instanceRoot || !existsSync(instanceRoot)) {
    throw new Error(`backup: instance root '${instanceRoot}' does not exist`);
  }
  const stamp = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const dest = join(outDir ?? join(instanceRoot, 'backups'), stamp);
  const files = [];
  const skippedSecrets = [];
  for (const rel of STATE_PATHS) {
    const src = join(instanceRoot, rel);
    if (!existsSync(src)) continue;
    const paths = statSync(src).isDirectory() ? [...walk(src)] : [src];
    for (const p of paths) {
      const r = relative(instanceRoot, p);
      if (SECRET_RE.test(r.split(sep).pop() ?? r)) { skippedSecrets.push(r); continue; }
      const to = join(dest, r);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(p, to);
      files.push({ path: r.split(sep).join('/'), sha256: sha256File(p), bytes: statSync(p).size });
    }
  }
  // top-level secret-looking files sit OUTSIDE the allowlist too — record
  // them so the manifest honestly shows what was deliberately left behind
  for (const f of readdirSync(instanceRoot, { withFileTypes: true })) {
    if (f.isFile() && SECRET_RE.test(f.name) && !skippedSecrets.includes(f.name)) {
      skippedSecrets.push(f.name);
    }
  }
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    instanceRoot,
    files,
    skippedSecrets,
  };
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'backup-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { dir: dest, files: files.length, skippedSecrets, manifest };
}

/**
 * Re-hash every manifest file. Returns { ok, missing[], mismatched[],
 * extra[], verified } — never throws on a corrupt tree; a mangled
 * manifest is itself a failed verification.
 */
export function verifyBackup(dir) {
  const manifestPath = join(dir, 'backup-manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    return { ok: false, error: `manifest unreadable: ${e.message}`, missing: [], mismatched: [], extra: [], verified: 0 };
  }
  const listed = new Map((manifest.files ?? []).map((f) => [f.path, f]));
  const missing = [];
  const mismatched = [];
  let verified = 0;
  for (const [rel, f] of listed) {
    const p = join(dir, rel);
    if (!existsSync(p)) { missing.push(rel); continue; }
    if (sha256File(p) !== f.sha256) { mismatched.push(rel); continue; }
    verified += 1;
  }
  const extra = [];
  for (const p of walk(dir)) {
    const rel = relative(dir, p).split(sep).join('/');
    if (rel === 'backup-manifest.json') continue;
    if (!listed.has(rel)) extra.push(rel);
  }
  return { ok: missing.length === 0 && mismatched.length === 0 && extra.length === 0,
    missing, mismatched, extra, verified, total: listed.size };
}
