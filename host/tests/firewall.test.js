import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const HOST_ROOT = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]+$/, '');

// host/ is the neutral control plane with ZERO external dependencies:
//  - relative imports must resolve inside host/
//  - bare imports may only be node: builtins
// This mechanically enforces invariant 1 — host cannot even name Pi/DSH/Chord.
function* jsFiles(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* jsFiles(p);
    else if (e.name.endsWith('.js')) yield p;
  }
}

test('host/ source is fully self-contained (no body, no harness, no deps)', () => {
  const offenders = [];
  for (const file of jsFiles(join(HOST_ROOT, 'src'))) {
    for (const m of readFileSync(file, 'utf-8')
      .matchAll(/from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1] ?? m[2];
      if (spec.startsWith('.')) {
        const target = resolve(dirname(file), spec);
        if (target !== HOST_ROOT && !target.startsWith(HOST_ROOT + sep)) {
          offenders.push(`${file}: ${spec}`);
        }
      } else if (!spec.startsWith('node:')) {
        offenders.push(`${file}: ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('core modules load with zero external deps', async () => {
  await import('../src/core/contracts.js');
  await import('../src/core/instance.js');
  await import('../src/core/audit.js');
  await import('../src/core/manifest.js');
  await import('../src/core/loaders.js');
  await import('../src/core/governance.js');
  await import('../src/app/host.js');
});
