/**
 * M140: fast_context — read-only bounded retrieval tool.
 *
 * Covers: ranked results with line numbers + snippets, filename-hit
 * dominance, subdir confinement, .paiignore honoring, empty/honest
 * miss reporting, and the read-only contract (no writes, no receipts).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fastContextTool } from '../src/adapter/fastcontext.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pai-fastctx-'));
  mkdirSync(join(dir, 'src', 'core'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'src', 'core', 'governance.js'),
    'export class GovernanceKernel {\n  decideToolCall() { return null; }\n}\n// policy gating lives here\n');
  writeFileSync(join(dir, 'src', 'core', 'memory.js'),
    'export function remember(text) { /* persist memory */ }\n// the kernel never reads this\n');
  writeFileSync(join(dir, 'docs', 'guide.md'), '# Guide\nGovernance overview and kernel notes.\n');
  writeFileSync(join(dir, 'secret.log'), 'kernel kernel kernel\n');
  return dir;
}

test('M140: fast_context ranks relevant files with line numbers and snippets', async () => {
  const dir = setup();
  const tool = fastContextTool({ workdir: dir });
  const r = await tool.execute('t', { query: 'GovernanceKernel decideToolCall' });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /src\/core\/governance\.js/);
  assert.match(r.content[0].text, /\d+: export class GovernanceKernel/);
  const gov = r.details.results.find((x) => x.rel === 'src/core/governance.js');
  assert.ok(gov, 'governance.js in ranked results');
  assert.ok(gov.lines.some((l) => l.line === 1), 'line numbers attached');
});

test('M140: filename hits outrank content-only hits; .paiignore honored', async () => {
  const dir = setup();
  // 'remember' appears once in memory.js (name+content) vs 'kernel' scattered
  const tool = fastContextTool({ workdir: dir, getIgnored: (p) => p.endsWith('.log') });
  const r = await tool.execute('t', { query: 'kernel' });
  const rels = r.details.results.map((x) => x.rel);
  assert.ok(!rels.includes('secret.log'), 'ignored file never surfaces');
  const r2 = await tool.execute('t', { query: 'memory remember' });
  assert.equal(r2.details.results[0].rel, 'src/core/memory.js', 'filename hit dominates');
});

test('M140: subdir confines the scan; escaping subdir refuses', async () => {
  const dir = setup();
  const tool = fastContextTool({ workdir: dir });
  const r = await tool.execute('t', { query: 'kernel', subdir: 'docs' });
  assert.match(r.content[0].text, /docs\/guide\.md/);
  assert.ok(!r.details.results.some((x) => x.rel.startsWith('src/')), 'src/ not scanned');
  const esc = await tool.execute('t', { query: 'kernel', subdir: '..' });
  assert.equal(esc.isError, true);
  assert.match(esc.content[0].text, /escapes the workspace/);
});

test('M140: a junction/symlink subdir pointing outside the workdir refuses (A1 realpath parity)', async (t) => {
  const dir = setup();
  const outside = mkdtempSync(join(tmpdir(), 'pai-fastctx-out-'));
  writeFileSync(join(outside, 'leak.js'), '// kernel secrets outside the workdir\n');
  const link = join(dir, 'linked-out');
  try { symlinkSync(outside, link, 'junction'); } catch { t.skip('no symlink privilege'); return; }
  const tool = fastContextTool({ workdir: dir });
  const r = await tool.execute('t', { query: 'kernel', subdir: 'linked-out' });
  assert.equal(r.isError, true, 'lexically-inside junction must not escape the scan root');
  assert.match(r.content[0].text, /escapes the workspace/);
});

test('M140: honest miss + no files created (read-only contract)', async () => {
  const dir = setup();
  const before = readdirSync(dir).sort();
  const tool = fastContextTool({ workdir: dir });
  const r = await tool.execute('t', { query: '!!!' });
  assert.equal(r.isError, true); // no searchable terms → honest refusal
  const r2 = await tool.execute('t', { query: 'nonexistent_term_xyz' });
  assert.equal(r2.isError, undefined);
  assert.match(r2.content[0].text, /no matches/);
  assert.deepEqual(readdirSync(dir).sort(), before, 'read-only: nothing written');
});
