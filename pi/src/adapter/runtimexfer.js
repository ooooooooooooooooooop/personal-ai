/**
 * runtime_export / runtime_import — M124 runtime backup transfer.
 *
 * A bundle is a directory with manifest.json {version, files:[{src,dest,sha256,bytes}]}.
 * Whitelisted state only — the bundle carries PORTABLE AGENT STATE:
 *   pai/:      .pai/microagents/**, .pai/plans/**, .pai/specs/**, verify.json
 *   instance/: memory.db, profiles.json, model-aliases.json, feature-models.json,
 *              model-fallbacks.json
 * Governance surfaces are NEVER in the bundle — hooks.json, commands.json,
 * allow-lists, trust stores, policy, mcp.json (env!), sessions (session_import
 * owns those). Importing governance config would smuggle authority, not state.
 *
 * Import discipline:
 *  - bundle dir must resolve inside the workdir (realpath — symlink escapes refuse)
 *  - every file re-hashed before landing; a tampered bundle refuses the file
 *  - pai/* destinations write through FileOpsGuard (backup + receipt + undo);
 *    instance/* destinations get a byte-copy pre-backup under instance backups/
 *  - the tool ASKS the operator before anything is written (runtime_import is
 *    steering-adjacent: imported microagents fire on future prompts)
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathInsideRootForWrite, pathInsideRootReal } from './paths.js';

const err = (text) => ({ content: [{ type: 'text', text }], isError: true });
const ok = (text, details) => ({ content: [{ type: 'text', text }], details });
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// For a write target whose parent chain does not exist yet (fresh bundle
// dir): the deepest EXISTING ancestor is what the filesystem will follow —
// its real path must be inside the real root. Nonexistent tail components
// cannot be symlinks, so ancestor-verified + lexical-inside is sufficient.
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { pathInsideRoot } from './paths.js';
function insideForFreshWrite(root, candidate) {
  const abs = resolve(candidate);
  if (!pathInsideRoot(root, abs)) return false;
  let cur = abs;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
  try { return pathInsideRoot(realpathSync(resolve(root)), realpathSync(cur)); }
  catch { return false; }
}

// dest-prefix → where it lands. Everything else is refused on BOTH sides.
const PAI_SOURCES = ['microagents', 'plans', 'specs'];
const PAI_FILES = ['verify.json'];
const WORKDIR_FILES = ['.paiignore']; // workdir-root files → 'workdir/' dest prefix
const INSTANCE_FILES = ['memory.db', 'profiles.json', 'model-aliases.json', 'feature-models.json', 'model-fallbacks.json'];

function* walk(dir, base = dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p, base);
    else if (st.isFile()) yield relative(base, p).split(sep).join('/');
  }
}

export function runtimeXferTools({ workdir, instanceRoot, fileOps, audit = null, getAsks = null }) {
  const wdir = resolve(workdir);
  const iroot = resolve(instanceRoot);

  const exportTool = {
    name: 'runtime_export',
    label: 'Export runtime state bundle',
    description: 'Export portable agent state (.pai microagents/plans/specs + instance memory/profiles) into a manifest-verified bundle dir under the workdir. Governance config and sessions are never exported.',
    parameters: {
      type: 'object',
      properties: { dest: { type: 'string', description: 'bundle dir, relative to workdir (default .pai/exports/runtime-<ts>)' } },
    },
    async execute(_id, params) {
      const rel = String(params?.dest ?? '').trim() || join('.pai', 'exports', `runtime-${Date.now()}`);
      const dest = resolve(wdir, rel);
      if (!insideForFreshWrite(wdir, dest)) return err(`dest '${rel}' escapes the workdir`);
      const files = [];
      const take = (abs, destRel) => {
        if (!existsSync(abs)) return;
        const buf = readFileSync(abs);
        files.push({ src: destRel, dest: destRel, sha256: sha(buf), bytes: buf.length, _abs: abs });
      };
      for (const d of PAI_SOURCES) {
        const dir = join(wdir, '.pai', d);
        if (existsSync(dir)) for (const rel2 of walk(dir)) take(join(dir, rel2), `pai/${d}/${rel2}`);
      }
      for (const f of PAI_FILES) take(join(wdir, '.pai', f), `pai/${f}`);
      for (const f of WORKDIR_FILES) take(join(wdir, f), `workdir/${f}`);
      for (const f of INSTANCE_FILES) take(join(iroot, f), `instance/${f}`);
      if (!files.length) return err('nothing to export — no whitelisted runtime state present');
      mkdirSync(dest, { recursive: true });
      for (const f of files) {
        const out = join(dest, f.src);
        mkdirSync(join(out, '..'), { recursive: true });
        copyFileSync(f._abs, out);
      }
      const manifest = { version: 1, exportedAt: new Date().toISOString(), files: files.map(({ _abs, ...rest }) => rest) };
      writeFileSync(join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      audit?.write({ kind: 'RUNTIME_EXPORT', data: { dest, files: files.length } });
      return ok(`runtime bundle exported: ${files.length} files → ${dest}`, { dest, files: manifest.files });
    },
  };

  const importTool = {
    name: 'runtime_import',
    label: 'Import runtime state bundle',
    description: 'Import a runtime_export bundle: manifest sha256-verified, whitelisted dests only, .pai writes go through backup+receipt fileops, instance files get a pre-backup. Always asks the operator first.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'bundle dir containing manifest.json, relative to workdir' } },
      required: ['path'],
    },
    async execute(toolCallId, params) {
      const src = resolve(wdir, String(params?.path ?? ''));
      if (!pathInsideRootReal(wdir, src)) return err(`bundle path escapes the workdir`);
      if (!existsSync(join(src, 'manifest.json'))) return err('no manifest.json — not a runtime_export bundle');
      let manifest;
      try { manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf-8')); }
      catch (e) { return err(`manifest unreadable: ${e.message}`); }
      const files = Array.isArray(manifest?.files) ? manifest.files : [];
      if (!files.length) return err('manifest carries no files');
      // verify EVERY file before touching anything — a corrupt or tampered
      // bundle refuses the whole import, not just the bad file
      const staged = [];
      for (const f of files) {
        const rel2 = String(f?.src ?? '');
        if (!/^(pai|instance|workdir)\//.test(rel2) || rel2.includes('..')) return err(`manifest entry '${rel2}' outside whitelist`);
        const fp = join(src, rel2);
        if (!existsSync(fp) || !statSync(fp).isFile()) return err(`bundle file missing: ${rel2}`);
        const buf = readFileSync(fp);
        if (sha(buf) !== f.sha256) return err(`sha256 mismatch on ${rel2} — bundle tampered or corrupt`);
        staged.push({ rel: rel2, buf, bytes: buf.length });
      }
      // operator ask — importing .pai state plants future steering
      const ask = getAsks?.()?.ask;
      if (!ask) return err('runtime_import requires an operator channel (fail-closed)');
      const answer = await ask({
        toolName: 'runtime_import', toolCallId, rule: 'runtime_import',
        summary: `导入运行时备份：${staged.length} 个文件`,
        detail: `来源 ${src}\n` + staged.slice(0, 12).map((s) => `  ${s.rel} (${s.bytes}B)`).join('\n') + (staged.length > 12 ? `\n  …等 ${staged.length} 个` : ''),
        args: { path: params.path, files: staged.length },
        argsTruncated: false, argsTotalChars: null,
      });
      if (answer !== 'allow' && answer !== 'allow_session') return err(`runtime_import refused by operator (${answer})`);

      const applied = [];
      for (const s of staged) {
        const paiSide = s.rel.startsWith('pai/') || s.rel.startsWith('workdir/');
        const destAbs = s.rel.startsWith('pai/') ? join(wdir, '.pai', s.rel.slice(4))
          : s.rel.startsWith('workdir/') ? join(wdir, s.rel.slice(8))
          : join(iroot, s.rel.slice(9));
        const root = paiSide ? wdir : iroot;
        if (!insideForFreshWrite(root, destAbs)) return err(`dest ${s.rel} escapes its root — partial import: ${applied.length} files applied`);
        if (paiSide) {
          // governed write path: backup + receipt + undo under this call id
          try {
            await fileOps.write(destAbs, s.buf, { toolCallId });
          } catch (e) {
            return err(`write failed on ${s.rel}: ${String(e?.message ?? e)} — partial import: ${applied.length} applied`);
          }
        } else {
          // instance files: byte-copy with a pre-backup under instance backups/
          if (existsSync(destAbs)) {
            const bakDir = join(iroot, 'backups');
            mkdirSync(bakDir, { recursive: true });
            copyFileSync(destAbs, join(bakDir, `${Date.now()}-${s.rel.replace(/\//g, '_')}`));
          }
          mkdirSync(join(destAbs, '..'), { recursive: true });
          writeFileSync(destAbs, s.buf);
        }
        applied.push(s.rel);
      }
      audit?.write({ kind: 'RUNTIME_IMPORT', data: { src, files: applied.length, toolCallId } });
      return ok(`runtime bundle imported: ${applied.length} files`, { applied });
    },
  };

  return [exportTool, importTool];
}
