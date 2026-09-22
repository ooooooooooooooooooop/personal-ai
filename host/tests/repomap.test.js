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

test('PageRank: the heavily-imported hub survives the budget cut; unreferenced leaves drop', () => {
  const w = dir();
  // a/ alphabetically first but a dead leaf — nobody imports it.
  // zzz_hub is alphabetically LAST but the whole repo depends on it.
  // Alphabetical tail-cutting kept the leaf and dropped the hub; rank
  // filtering must do the opposite.
  writeFileSync(join(w, 'aaa_leaf.ts'), 'export function leafA() {}\n');
  writeFileSync(join(w, 'aab_leaf.ts'), 'export function leafB() {}\n');
  writeFileSync(join(w, 'zzz_hub.ts'),
    'export function hubCore() {}\nexport class HubService {}\nexport const hubConfig = () => {}\n');
  for (let i = 0; i < 6; i++) {
    writeFileSync(join(w, `m${i}_user.ts`),
      `import { hubCore } from './zzz_hub';\nexport function user${i}() { return hubCore; }\n`);
  }
  // budget: enough for the hub + a couple of users, not for everything
  const r = buildRepoMap(w, { maxChars: 100 });
  assert.equal(r.truncated, true);
  assert.match(r.text, /zzz_hub\.ts/, 'the import hub survived the cut');
  assert.match(r.text, /rank-filtered/, 'the notice says selection was rank-based');
  assert.ok(!/aaa_leaf\.ts: /.test(r.text) || !/aab_leaf\.ts: /.test(r.text),
    'at least one unreferenced leaf lost ground to the hub');
});

test('PageRank: no-edge repo degrades to uniform scores — full map when budget allows', () => {
  const w = dir(); seed(w);
  const r = buildRepoMap(w); // no imports in the fixture → uniform ranks
  assert.equal(r.truncated, false);
  assert.match(r.text, /a\.ts/);
  assert.match(r.text, /b\.py/);
});

test('PageRank: python dotted imports and C includes form edges too', () => {
  const w = dir();
  writeFileSync(join(w, 'aaa_unused.py'), 'def lonely():\n    pass\n');
  writeFileSync(join(w, 'zutil.py'), 'def helper():\n    pass\nclass ZUtil:\n    pass\n');
  writeFileSync(join(w, 'worker1.py'), 'import zutil\ndef w1():\n    pass\n');
  writeFileSync(join(w, 'worker2.py'), 'from zutil import helper\ndef w2():\n    pass\n');
  const r = buildRepoMap(w, { maxChars: 100 });
  assert.match(r.text, /zutil\.py/, 'dotted-import hub survives');
  const leafLine = r.text.split('\n').find((l) => l.startsWith('aaa_unused.py'));
  assert.ok(!leafLine || !leafLine.includes(':'), 'unreferenced leaf dropped or lost its symbol detail');
});
