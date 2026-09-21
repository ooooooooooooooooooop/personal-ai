import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { OutputSpool, outputSpoolExtension, outputReadTool } from '../src/adapter/outspool.js';

test('oversized text externalizes to spool; placeholder carries handle; output_read pages back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-spool-'));
  const spool = new OutputSpool(dir);
  const audits = [];
  const ext = outputSpoolExtension({ spool, audit: { write: (e) => audits.push(e) }, thresholdBytes: 100 });
  const handlers = {};
  ext.factory({ on: (n, fn) => { handlers[n] = fn; } });

  const big = 'x'.repeat(500);
  const out = handlers.tool_result({ toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: big }] });
  assert.ok(out?.content);
  assert.match(out.content[0].text, /externalized/);
  const id = out.content[0].text.match(/handle: (\S+)/)[1];
  assert.ok(audits.some((e) => e.kind === 'OUTPUT_SPOOL'));

  const tool = outputReadTool(spool);
  const r1 = await tool.execute('t', { id, offset: 0, limit: 50 });
  assert.match(r1.content[0].text, /^x{50}/);
  assert.match(r1.content[0].text, /450 remaining/);
  const r2 = await tool.execute('t', { id, offset: 450, limit: 100 });
  assert.match(r2.content[0].text, /0 remaining/);
});

test('small results pass through untouched; missing id errors honestly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-spool2-'));
  const spool = new OutputSpool(dir);
  const ext = outputSpoolExtension({ spool, thresholdBytes: 1000 });
  const handlers = {};
  ext.factory({ on: (n, fn) => { handlers[n] = fn; } });
  assert.equal(handlers.tool_result({ toolCallId: 'c', toolName: 'read', content: [{ type: 'text', text: 'small' }] }), undefined);
  const tool = outputReadTool(spool);
  const bad = await tool.execute('t', { id: 'out-nope' });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /no spooled output/);
});

test('cap evicts oldest spooled files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-spool3-'));
  const spool = new OutputSpool(dir, { cap: 3 });
  const ids = [];
  for (let i = 0; i < 5; i++) { ids.push(spool.store(`blob-${i}`).id); await new Promise((r) => setTimeout(r, 5)); }
  assert.equal(spool.list().length, 3);
  assert.throws(() => spool.read(ids[0]), /no spooled output/);
});
