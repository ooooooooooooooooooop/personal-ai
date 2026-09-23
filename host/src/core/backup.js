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
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

// Optional consistent-sqlite snapshot (dedup-h #544): a byte-copy of a
// live .db can tear mid-transaction. VACUUM INTO produces a consistent
// image; when node:sqlite is unavailable the entry falls back to a raw
// copy marked `rawCopy:true` in the manifest — honest about which kind
// of snapshot each file is.
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* older node — raw-copy fallback */ }

const STATE_PATHS = [
  'registry.json',
  'sessions',
  'memory',
  'memory.db',
  'tasks',
  'schedules',
  'schedules.json',
  'jobs/durable_jobs.db',
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
 * Copy one state file into the bundle. `.db` files get a VACUUM INTO
 * consistent snapshot when node:sqlite is present; anything else (and
 * sqlite when unavailable) is a byte copy. Returns 'vacuum' | 'raw'.
 */
function copyStateFile(src, to) {
  if (src.toLowerCase().endsWith('.db') && DatabaseSync) {
    try {
      const db = new DatabaseSync(src);
      try { db.exec(`VACUUM INTO '${to.replaceAll("'", "''")}'`); }
      finally { db.close(); }
      return 'vacuum';
    } catch {
      // locked/corrupt db — fall through to raw copy, marked honestly
    }
  }
  copyFileSync(src, to);
  return 'raw';
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
      const kind = copyStateFile(p, to);
      files.push({ path: r.split(sep).join('/'), sha256: sha256File(to), bytes: statSync(to).size,
        ...(kind === 'raw' && r.toLowerCase().endsWith('.db') ? { rawCopy: true } : {}) });
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

/**
 * dedup-h #544 — enumerate backup bundles under a directory (newest first).
 * Each row reads its manifest for createdAt/file counts; a bundle whose
 * manifest is unreadable still appears, flagged manifestOk:false.
 */
export function listBackups(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('backup-'))
    .map((e) => {
      const p = join(dir, e.name);
      let m = null;
      try { m = JSON.parse(readFileSync(join(p, 'backup-manifest.json'), 'utf-8')); } catch { /* flagged below */ }
      return {
        dir: p, name: e.name,
        createdAt: m?.createdAt ?? null,
        files: Array.isArray(m?.files) ? m.files.length : null,
        skippedSecrets: Array.isArray(m?.skippedSecrets) ? m.skippedSecrets.length : 0,
        manifestOk: m != null,
      };
    })
    .sort((a, b) => String(b.createdAt ?? b.name).localeCompare(String(a.createdAt ?? a.name)));
}

/**
 * dedup-h #544 — restore a verified bundle into an instance root.
 * Fail-closed by construction:
 *  - the bundle must pass verifyBackup FIRST (missing/mismatch/extra refuse);
 *  - manifest paths are re-confined (no '..', never absolute) — a forged
 *    manifest cannot write outside the instance root;
 *  - existing state is never clobbered silently: without force the restore
 *    refuses and lists the collisions; with force a pre-restore snapshot of
 *    current state is taken before the overwrite.
 */
export function restoreBackup(backupDir, instanceRoot, { force = false } = {}) {
  const v = verifyBackup(backupDir);
  if (!v.ok) {
    return { ok: false, error: 'bundle failed verification — refusing to restore a corrupt or tampered backup',
      missing: v.missing, mismatched: v.mismatched, extra: v.extra };
  }
  const manifest = JSON.parse(readFileSync(join(backupDir, 'backup-manifest.json'), 'utf-8'));
  const files = manifest.files ?? [];
  for (const f of files) {
    const rel = String(f.path ?? '');
    if (!rel || rel.includes('..') || isAbsolute(rel)) {
      return { ok: false, error: `manifest path '${rel}' escapes the instance root — refusing` };
    }
  }
  let preRestore = null;
  if (existsSync(instanceRoot)) {
    const existing = files.filter((f) => existsSync(join(instanceRoot, f.path))).map((f) => f.path);
    if (existing.length && !force) {
      return { ok: false, error: `${existing.length} state files already exist — pass --force to overwrite (a pre-restore snapshot is taken first)`, existing };
    }
    if (existing.length) {
      preRestore = createBackup(instanceRoot).dir; // safety net before clobbering live state
    }
  }
  const restored = [];
  for (const f of files) {
    const src = join(backupDir, f.path);
    const dst = join(instanceRoot, f.path);
    mkdirSync(dirname(dst), { recursive: true });
    const tmp = `${dst}.restore-tmp-${process.pid}`;
    copyFileSync(src, tmp);
    renameSync(tmp, dst); // atomic per file — a crash never halves a state file
    restored.push(f.path);
  }
  return { ok: true, restored: restored.length, preRestore };
}
