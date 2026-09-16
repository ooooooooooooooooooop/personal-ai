import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const PI_ROOT = fileURLToPath(new URL('../', import.meta.url));
const REPO_ROOT = resolve(PI_ROOT, '..');
const HOST_ROOT = join(REPO_ROOT, 'host');

// pi/ may reach outside itself ONLY into host/ (neutral contracts) or the
// pinned @earendil-works engine deps. Never dsh/, mcp/, skills/, soul/, etc.
const ALLOWED_BARE = [/^@earendil-works\//, /^node:/];

function* jsFiles(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* jsFiles(p);
    else if (e.name.endsWith('.js')) yield p;
  }
}

test('pi/ only reaches outside via host/ or pinned pi engine deps', () => {
  const offenders = [];
  for (const file of [...jsFiles(join(PI_ROOT, 'src')), ...jsFiles(join(PI_ROOT, 'bin'))]) {
    for (const m of readFileSync(file, 'utf-8')
      .matchAll(/from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1] ?? m[2];
      if (spec.startsWith('.')) {
        const target = resolve(dirname(file), spec);
        if (!target.startsWith(PI_ROOT) && !target.startsWith(HOST_ROOT + sep)) {
          offenders.push(`${file}: ${spec} -> ${target}`);
        }
      } else if (!ALLOWED_BARE.some((r) => r.test(spec))) {
        offenders.push(`${file}: ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
