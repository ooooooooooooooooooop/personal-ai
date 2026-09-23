#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHost } from '../src/bootstrap/host.js';
import { instancePaths } from '../../host/src/core/instance.js';
import { loadManagedManifest } from '../../host/src/core/manifest.js';

const PI_ROOT = fileURLToPath(new URL('../', import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const cmd = process.argv[2] ?? 'doctor';

if (cmd === 'doctor') {
  const instanceRoot = arg('instance-root', process.env.PAI_INSTANCE_ROOT);
  let ok = true;
  try {
    if (!instanceRoot) throw new Error('missing --instance-root / PAI_INSTANCE_ROOT');
    const paths = instancePaths(instanceRoot);
    console.log('instance_root:', paths.root);
  } catch (e) {
    ok = false;
    console.error('instance_root FAIL:', e.message);
  }
  try {
    const m = loadManagedManifest(join(PI_ROOT, 'extensions', 'managed-manifest.json'));
    console.log('managed manifest: ok,', m.extensions.length, 'extension(s)');
  } catch (e) {
    ok = false;
    console.error('manifest FAIL:', e.message);
  }
  try {
    await import('@earendil-works/pi-agent-core');
    await import('@earendil-works/pi-coding-agent');
    console.log('pi deps: resolvable (0.85.1 pinned)');
  } catch (e) {
    ok = false;
    console.error('pi deps FAIL:', e.message);
  }
  // M1 exit: doctor reports registry / identity / audit health.
  if (instanceRoot) {
    const paths = instancePaths(instanceRoot);
    try {
      const registry = JSON.parse(readFileSync(join(paths.root, 'registry.json'), 'utf-8'));
      const bodies = Object.keys(registry.bodies ?? {});
      if (!bodies.length) throw new Error('no bodies registered');
      console.log('registry: ok,', bodies.join(','));
    } catch (e) {
      ok = false;
      console.error('registry FAIL:', e.message);
    }
    try {
      const identity = JSON.parse(readFileSync(join(paths.root, 'runtime.json'), 'utf-8'));
      if (!identity.run_id || !identity.host_version) throw new Error('identity incomplete');
      console.log('identity: ok, run', identity.run_id?.slice(0, 8),
        '| adapter', `${identity.adapter_id}@${identity.adapter_version}`,
        identity.session_id ? `| session ${identity.session_id.slice(0, 8)}` : '| no session yet');
    } catch (e) {
      ok = false;
      console.error('identity FAIL:', e.message);
    }
    try {
      const files = existsSync(paths.auditDir)
        ? readdirSync(paths.auditDir).filter((f) => f.endsWith('.jsonl'))
        : [];
      if (!files.length) throw new Error('no audit ledger files');
      console.log('audit: ok,', files.join(','));
    } catch (e) {
      ok = false;
      console.error('audit FAIL:', e.message);
    }
  }
  process.exit(ok ? 0 : 1);
}

if (cmd === 'start') {
  const instanceRoot = arg('instance-root', process.env.PAI_INSTANCE_ROOT);
  if (!instanceRoot) {
    console.error('start requires --instance-root or PAI_INSTANCE_ROOT');
    process.exit(1);
  }
  const host = await startHost({ instanceRoot });
  console.log('host up. composite guard sealed:', host.guard.sealed());
  console.log('soul files:', Object.keys(host.soul.files).length,
    '| canonical files:', Object.keys(host.canonical.files).length,
    '| managed extensions:', host.manifest.extensions.length);
}

// dedup-h #333 — instance state backup/verify (OpenClaw `backup
// create`/`backup verify` analogue). Durable-state allowlist snapshot
// with a sha256 manifest; secrets are never bundled.
if (cmd === 'backup') {
  const sub = process.argv[3] ?? 'create';
  const instanceRoot = arg('instance-root', process.env.PAI_INSTANCE_ROOT);
  const { createBackup, verifyBackup } = await import('../../host/src/core/backup.js');
  if (sub === 'create') {
    if (!instanceRoot) {
      console.error('backup create requires --instance-root or PAI_INSTANCE_ROOT');
      process.exit(1);
    }
    const r = createBackup(instanceRoot, arg('out', null));
    console.log(`backup: ${r.files} files → ${r.dir}`);
    if (r.skippedSecrets.length) {
      console.log(`secrets excluded by design (${r.skippedSecrets.length}): ${r.skippedSecrets.join(', ')}`);
    }
    process.exit(0);
  }
  if (sub === 'verify') {
    const dir = process.argv[4] ?? arg('dir', null);
    if (!dir) {
      console.error('backup verify requires a backup directory (positional or --dir)');
      process.exit(1);
    }
    const r = verifyBackup(dir);
    if (r.error) { console.error(`verify FAIL: ${r.error}`); process.exit(1); }
    for (const m of r.missing) console.error(`  MISSING    ${m}`);
    for (const m of r.mismatched) console.error(`  MISMATCH   ${m}`);
    for (const m of r.extra) console.error(`  EXTRA      ${m}`);
    console.log(`verify: ${r.verified}/${r.total} files intact — ${r.ok ? 'OK' : 'FAILED'}`);
    process.exit(r.ok ? 0 : 1);
  }
  console.error(`unknown backup subcommand '${sub}' — expected create|verify`);
  process.exit(1);
}

// dedup-h #242 — expose this host as an MCP server to external clients
// (Claude `mcp serve` analogue). Newline-delimited JSON-RPC on stdio;
// the served tools run the REAL governed channel (policy/hooks/budget).
if (cmd === 'mcp-serve') {
  const instanceRoot = arg('instance-root', process.env.PAI_INSTANCE_ROOT);
  const workdir = arg('workdir', process.env.PAI_WORKDIR ?? process.cwd());
  if (!instanceRoot) {
    console.error('mcp-serve requires --instance-root or PAI_INSTANCE_ROOT');
    process.exit(1);
  }
  const { serveMcp } = await import('../src/serve/mcpserve.js');
  const host = await startHost({ instanceRoot, workdir });
  await serveMcp(host);
}
