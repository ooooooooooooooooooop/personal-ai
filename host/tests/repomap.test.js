import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRepoMap } from '../src/core/repomap.js';

const dir = () => mkdtempSync(join(tmpdir(), 'pai-map-'));

function seed(w) {
  mkdirSync(join(w, 'src', 'core'), { recursive: true });
  writeFileSync(join(w, 'src', 'core', 'a.ts'),
    'export function alpha() {}\nexport class Beta {}\nconst helper = () => {}\nexport const gamma = async () => {}\n');
  writeFileSync(join(w, 'src', 'b.py'), 'def pyfn():\n    pass\nclass PyCls:\n    pass\n');
  writeFileSync(join(w, 'README.md'), '# docs\n'); // not a source ext — skipped
  mkdirSync(join(w, 'node_modules', 'junk'), { recursive: true });
  writeFileSync(join(w, 'node_modules', 'junk', 'x.js'), 'function skipped() {}');
}

test('map lists source files with top-level symbols, skips noise dirs', () => {
  const w = dir(); seed(w);
  const r = buildRepoMap(w);
  assert.match(r.text, /src\/core\/a\.ts: .*fn alpha/);
  assert.match(r.text, /class Beta/);
  assert.match(r.text, /fn gamma/); // export const arrow fn
  assert.match(r.text, /src\/b\.py: .*fn pyfn.*class PyCls/s);
  assert.ok(!r.text.includes('README'));      // non-source ext excluded
  assert.ok(!r.text.includes('skipped'));    // node_modules never walked
  assert.equal(r.truncated, false);
});

test('subdir narrows; isIgnored honored; missing subdir errors', () => {
  const w = dir(); seed(w);
  const sub = buildRepoMap(w, { subdir: 'src/core' });
  assert.match(sub.text, /a\.ts/);
  assert.ok(!sub.text.includes('b.py'));
  const ig = buildRepoMap(w, { isIgnored: (rel) => rel.endsWith('b.py') });
  assert.ok(!ig.text.includes('b.py'));
  assert.ok(buildRepoMap(w, { subdir: 'nope' }).error);
  assert.match(buildRepoMap(w, { subdir: '../outside' }).error, /escapes/); // builder itself is confined
});

test('budget truncation marks truncated and stays under cap', () => {
  const w = dir();
  for (let i = 0; i < 40; i++) {
    writeFileSync(join(w, `f${String(i).padStart(2, '0')}.ts`),
      `export function fn${i}() {}\nexport class C${i} {}\n`);
  }
  const r = buildRepoMap(w, { maxChars: 1000 });
  assert.equal(r.truncated, true);
  assert.ok(r.text.length < 1200);
});
