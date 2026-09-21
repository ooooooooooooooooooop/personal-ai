import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JobExecutor } from '../src/adapter/jobs.js';
import { JobStore } from '../../host/src/core/jobs.js';
import { AuditWriter } from '../../host/src/core/audit.js';
import { SandboxProvider } from '../../host/src/core/sandbox.js';

const rig = (excludes) => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-sbx-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  const audit = new AuditWriter({ auditDir: join(dir, 'audit') });
  const store = new JobStore(join(dir, 'jobs.db'));
  const specs = [];
  // spy provider — record whether spawnSpec was invoked (sandbox wrap applied)
  const sandbox = new SandboxProvider('none');
  const orig = sandbox.spawnSpec.bind(sandbox);
  sandbox.kind = 'wsl';
  sandbox.spawnSpec = (c, w) => { specs.push(c); return orig(c, w); };
  const executor = new JobExecutor(store, join(dir, 'jobs'), { audit, sandbox, sandboxExcludes: () => excludes });
  return { store, executor, specs, dir };
};

test('M80: excluded prefix bypasses the ambient sandbox; explicit per-job sandbox stands', async () => {
  const { store, executor, specs, dir } = rig(['git', 'docker']);
  // excluded command → ambient wsl sandbox skipped
  const r = await executor.spawnCommandJob({ command: 'git status', workdir: dir });
  assert.ok(r.job_id);
  assert.equal(specs.length, 0); // provider never consulted
  // non-excluded command still wraps
  await executor.spawnCommandJob({ command: 'npm run build', workdir: dir });
  assert.equal(specs.length, 1);
  // explicit per-job sandbox overrides exclusion
  const r3 = await executor.spawnCommandJob({ command: 'git log', workdir: dir, sandbox: { kind: 'docker' } });
  assert.ok(r3.job_id);
  // docker provider replaced the ambient one — ambient spy still at 1
  assert.equal(specs.length, 1);
  store.close();
});
