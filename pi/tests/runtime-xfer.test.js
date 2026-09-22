/**
 * M124 runtime_export/runtime_import — whitelisted state bundles:
 * manifest sha256 verification, workdir confinement, operator ask gate,
 * fileOps receipts on .pai writes, instance-file pre-backups.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeXferTools } from '../src/adapter/runtimexfer.js';
import { FileOpsGuard } from '../src/adapter/fileops.js';

function rig() {
  const workdir = mkdtempSync(join(tmpdir(), 'pai-xfer-wd-'));
  const instanceRoot = mkdtempSync(join(tmpdir(), 'pai-xfer-inst-'));
  const fileOps = new FileOpsGuard(instanceRoot);
  const audit = { events: [], write(e) { this.events.push(e); } };
  return { workdir, instanceRoot, fileOps, audit };
}

const allowAsk = { ask: async () => 'allow' };
const denyAsk = { ask: async () => 'deny' };

test('export → import roundtrip: pai + instance files land verified', async () => {
  const src = rig();
  mkdirSync(join(src.workdir, '.pai', 'microagents'), { recursive: true });
  writeFileSync(join(src.workdir, '.pai', 'microagents', 'a.md'), '---\ntriggers: [x]\n---\nbody');
  writeFileSync(join(src.instanceRoot, 'memory.db'), 'fake-db-bytes');
  writeFileSync(join(src.instanceRoot, 'profiles.json'), '{"p":1}');
  // governance surface must NOT be in the bundle
  writeFileSync(join(src.workdir, '.pai', 'hooks.json'), '{}');
  writeFileSync(join(src.instanceRoot, 'always-allow.json'), '[]');

  const [exp] = runtimeXferTools({ workdir: src.workdir, instanceRoot: src.instanceRoot, fileOps: src.fileOps });
  const out = await exp.execute('e1', {});
  assert.equal(out.isError, undefined);
  const bundleDir = out.details.dest;
  const manifest = JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf-8'));
  const names = manifest.files.map((f) => f.src);
  assert.ok(names.includes('pai/microagents/a.md'));
  assert.ok(names.includes('instance/memory.db'));
  assert.ok(!names.some((n) => /hooks|always-allow|mcp\.json|commands\.json/.test(n)), 'governance files excluded');

  // import into a fresh instance+workdir
  const dst = rig();
  const askCalls = [];
  const [, imp] = runtimeXferTools({
    workdir: dst.workdir, instanceRoot: dst.instanceRoot, fileOps: dst.fileOps, audit: dst.audit,
    getAsks: () => ({ ask: async (c) => { askCalls.push(c); return 'allow'; } }),
  });
  // bundle lives under the SOURCE workdir — copy it into the dst workdir first
  // (import requires the bundle inside the workdir, by design)
  const dstBundle = join(dst.workdir, 'bundle');
  mkdirSync(dstBundle, { recursive: true });
  for (const f of manifest.files) {
    const p = join(dstBundle, f.src);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, readFileSync(join(bundleDir, f.src)));
  }
  writeFileSync(join(dstBundle, 'manifest.json'), JSON.stringify(manifest));
  const r = await imp.execute('i1', { path: 'bundle' });
  assert.equal(r.isError, undefined);
  assert.equal(askCalls.length, 1);
  assert.equal(askCalls[0].rule, 'runtime_import');
  assert.equal(readFileSync(join(dst.workdir, '.pai', 'microagents', 'a.md'), 'utf-8'), '---\ntriggers: [x]\n---\nbody');
  assert.equal(readFileSync(join(dst.instanceRoot, 'memory.db'), 'utf-8'), 'fake-db-bytes');
  assert.ok(dst.audit.events.some((e) => e.kind === 'RUNTIME_IMPORT'));
});

test('import refuses: tampered bytes, non-bundle, workdir escape, operator deny', async () => {
  const { workdir, instanceRoot, fileOps } = rig();
  const [exp, imp] = runtimeXferTools({
    workdir, instanceRoot, fileOps,
    getAsks: () => allowAsk,
  });
  mkdirSync(join(workdir, '.pai', 'plans'), { recursive: true });
  writeFileSync(join(workdir, '.pai', 'plans', 'p.md'), 'plan');
  const out = await exp.execute('e2', { dest: 'b1' });
  const bundleDir = out.details.dest;

  // tamper: rewrite a file after manifest is fixed
  const manifest = JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf-8'));
  writeFileSync(join(bundleDir, 'pai/plans/p.md'), 'tampered');
  const r1 = await imp.execute('i2', { path: 'b1' });
  assert.equal(r1.isError, true);
  assert.match(r1.content[0].text, /sha256 mismatch/);

  // escape: bundle outside workdir
  const r2 = await imp.execute('i3', { path: '../outside' });
  assert.equal(r2.isError, true);

  // operator deny → nothing written
  const manifestFixed = JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf-8'));
  // restore correct bytes for the deny test
  writeFileSync(join(bundleDir, 'pai/plans/p.md'), 'plan');
  const [, impDeny] = runtimeXferTools({
    workdir, instanceRoot, fileOps,
    getAsks: () => denyAsk,
  });
  const r3 = await impDeny.execute('i4', { path: 'b1' });
  assert.equal(r3.isError, true);
  assert.match(r3.content[0].text, /refused by operator/);
  assert.equal(existsSync(join(workdir, '.pai', 'plans', 'p.md')), true); // pre-existing, untouched content
  assert.equal(readFileSync(join(workdir, '.pai', 'plans', 'p.md'), 'utf-8'), 'plan');
});

test('import without operator channel fails closed', async () => {
  const { workdir, instanceRoot, fileOps } = rig();
  mkdirSync(join(workdir, '.pai', 'plans'), { recursive: true });
  writeFileSync(join(workdir, '.pai', 'plans', 'p.md'), 'x');
  const [exp] = runtimeXferTools({ workdir, instanceRoot, fileOps });
  await exp.execute('e3', { dest: 'b2' });
  const [, imp] = runtimeXferTools({ workdir, instanceRoot, fileOps, getAsks: () => null });
  const r = await imp.execute('i5', { path: 'b2' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /fail-closed/);
});
