import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sessionReadTool } from '../src/adapter/sessionsearch.js';
import { repoMapTool } from '../src/adapter/repomap.js';

const dir = () => mkdtempSync(join(tmpdir(), 'pai-sr-'));

test('session_read returns bounded tail, untrusted-wrapped, dir-confined', async () => {
  const sd = dir();
  const file = join(sd, 's1.jsonl');
  const rows = [
    { message: { role: 'user', content: 'first question' } },
    { message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] } },
    { type: 'audit', kind: 'NOISE' },
    { message: { role: 'user', content: 'second question' } },
  ];
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'));
  const tool = sessionReadTool({ sessionDir: sd });

  const r = await tool.execute('t', { path: file, last: 2 });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /<past_session messages="2\/3" trust="untrusted">/);
  assert.match(r.content[0].text, /second question/);
  assert.ok(!r.content[0].text.includes('first question')); // tail bound honored
  assert.ok(!r.content[0].text.includes('NOISE'));

  // confinement: traversal + non-jsonl + missing all refuse
  for (const p of [join(sd, '..', 'x.jsonl'), file.replace('.jsonl', '.txt'), join(sd, 'missing.jsonl')]) {
    const bad = await tool.execute('t', { path: p });
    assert.equal(bad.isError, true, p);
  }
});

test('session_read: a symlink inside the session dir pointing outside is refused (A1 realpath parity)', async (t) => {
  const sd = dir();
  const outside = dir();
  writeFileSync(join(outside, 'secret.jsonl'), JSON.stringify({ message: { role: 'user', content: 'outside-secret' } }));
  const linkDir = join(sd, 'linked');
  // junction works without admin on Windows — same pattern as writeboundary tests
  try { symlinkSync(outside, linkDir, 'junction'); } catch { t.skip('no symlink privilege'); return; }
  const tool = sessionReadTool({ sessionDir: sd });
  const r = await tool.execute('t', { path: join(linkDir, 'secret.jsonl') });
  assert.equal(r.isError, true, 'lexically-inside symlink must not escape confinement');
  assert.ok(!JSON.stringify(r).includes('outside-secret'));
});

test('repo_map tool wraps the builder; subdir traversal refused', async () => {
  const w = dir();
  writeFileSync(join(w, 'a.ts'), 'export function thing() {}\n');
  const tool = repoMapTool({ workdir: w, getIgnored: () => null });
  const r = await tool.execute('t', {});
  assert.match(r.content[0].text, /<repo_map files="1" symbols="1">/);
  assert.match(r.content[0].text, /fn thing/);
  const bad = await tool.execute('t', { subdir: '../etc' });
  assert.equal(bad.isError, true);
  // .paiignore predicate reaches the builder (fresh instance per call)
  const ig = repoMapTool({ workdir: w, getIgnored: () => () => true });
  assert.match((await ig.execute('t', {})).content[0].text, /no source files/);
});

test('session_search passes scope through to the facade', async () => {
  const { sessionSearchTool } = await import('../src/adapter/sessionsearch.js');
  let gotScope = null;
  const tool = sessionSearchTool(() => async (q, opts) => { gotScope = opts?.scope; return [{ name: 's1', snippets: ['…hit…'] }]; });
  await tool.execute('t', { query: 'x' });
  assert.equal(gotScope, 'all'); // default
  await tool.execute('t', { query: 'x', scope: 'prompts' });
  assert.equal(gotScope, 'prompts');
  await tool.execute('t', { query: 'x', scope: 'bogus' });
  assert.equal(gotScope, 'all'); // unknown scope falls back, never widens silently
});
