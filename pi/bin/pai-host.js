#!/usr/bin/env node
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
