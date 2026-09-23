// dedup-h #560: pdf_read — first-class pdf tool over the zero-dep extractor.
// Carrier honesty: the pinned engine has no document content block, so
// extraction is the path for EVERY model — bounds refuse loudly, never trim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { pdfTool } from '../src/adapter/pdftool.js';

function pdfBuf(text = 'Hello PDF world') {
  const stream = zlib.deflateSync(Buffer.from(`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`, 'latin1'));
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj<</Type /Page /Length ' + stream.length + '>>stream\n', 'latin1'),
    stream,
    Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
  ]);
}

function rig() {
  const workdir = mkdtempSync(join(tmpdir(), 'pai-pdf-wd-'));
  const instanceRoot = mkdtempSync(join(tmpdir(), 'pai-pdf-inst-'));
  return { workdir, instanceRoot };
}

test('pdf_read: extracts text from a real PDF inside the workdir', async () => {
  const { workdir, instanceRoot } = rig();
  writeFileSync(join(workdir, 'doc.pdf'), pdfBuf('extract me'));
  const t = pdfTool({ workdir, instanceRoot, analyze: null });
  const r = await t.execute('x', { path: 'doc.pdf' });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /extract me/);
});

test('pdf_read: path escape, missing file, non-PDF all refuse honestly', async () => {
  const { workdir, instanceRoot } = rig();
  const t = pdfTool({ workdir, instanceRoot, analyze: null });
  const outside = join(tmpdir(), 'escape.pdf');
  writeFileSync(outside, pdfBuf());
  for (const [p, re] of [
    [{ path: outside }, /inside the workdir/],
    [{ path: '../x.pdf' }, /inside the workdir/],
    [{ path: 'ghost.pdf' }, /not found/],
  ]) {
    const r = await t.execute('x', p);
    assert.equal(r.isError, true, JSON.stringify(p));
    assert.match(r.content[0].text, re);
  }
  writeFileSync(join(workdir, 'fake.pdf'), 'not actually a pdf');
  writeFileSync(join(workdir, 'fake.bin'), 'not actually a pdf');
  const r = await t.execute('x', { path: 'fake.bin' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not a PDF/);
  const rPdf = await t.execute('x', { path: 'fake.pdf' });
  assert.equal(rPdf.isError, true, '.pdf extension with garbage content still refuses');
  assert.match(rPdf.content[0].text, /no extractable text/);
});

test('pdf_read: byte and page caps refuse; per-call args may only tighten', async () => {
  const { workdir, instanceRoot } = rig();
  writeFileSync(join(workdir, 'big.pdf'), pdfBuf('x'.repeat(2000)));
  const t = pdfTool({ workdir, instanceRoot, analyze: null });
  // tiny per-call byte cap refuses with real sizes
  const r = await t.execute('x', { path: 'big.pdf', max_bytes_mb: 0.00001 });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /size cap/);
  // instance pdf.json binds the cap; per-call cannot widen it
  writeFileSync(join(instanceRoot, 'pdf.json'), JSON.stringify({ maxBytesMb: 0.00001, maxPages: 0 }));
  const r2 = await t.execute('x', { path: 'big.pdf', max_bytes_mb: 100 });
  assert.equal(r2.isError, true, 'per-call cannot widen the configured cap');
  assert.match(r2.content[0].text, /size cap|page cap/);
  // page cap: real /Type /Page count exceeds 0 (size cap lifted first)
  writeFileSync(join(instanceRoot, 'pdf.json'), JSON.stringify({ maxPages: 0 }));
  const r3 = await t.execute('x', { path: 'big.pdf', max_pages: 0 });
  assert.equal(r3.isError, true);
  assert.match(r3.content[0].text, /page cap/);
  // malformed pdf.json fails closed
  writeFileSync(join(instanceRoot, 'pdf.json'), '{oops');
  const r4 = await t.execute('x', { path: 'big.pdf', max_bytes_mb: 100 });
  assert.equal(r4.isError, true);
  assert.match(r4.content[0].text, /malformed/);
});

test('pdf_read: question routes through the configured pdf feature model; absent → text fallback', async () => {
  const { workdir, instanceRoot } = rig();
  writeFileSync(join(workdir, 'q.pdf'), pdfBuf('quarterly revenue grew'));
  const seen = [];
  const analyzed = pdfTool({
    workdir, instanceRoot,
    analyze: async (sys, user) => { seen.push([sys, user]); return 'ANSWER: revenue grew'; },
  });
  const r = await analyzed.execute('x', { path: 'q.pdf', question: 'what grew?' });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /ANSWER: revenue grew/);
  assert.match(seen[0][1], /quarterly revenue grew/, 'analysis call carries the extracted text');
  // analyze unavailable → raw text returns for the CALLING model (never a fake answer)
  const unanalyzed = pdfTool({ workdir, instanceRoot, analyze: async () => null });
  const r2 = await unanalyzed.execute('x', { path: 'q.pdf', question: 'what grew?' });
  assert.equal(r2.isError, undefined);
  assert.match(r2.content[0].text, /no pdf feature model configured/);
  assert.match(r2.content[0].text, /quarterly revenue grew/);
});

test('pdf_read: unextractable PDF refuses honestly instead of returning garbage', async () => {
  const { workdir, instanceRoot } = rig();
  writeFileSync(join(workdir, 'scanned.pdf'), Buffer.from('%PDF-1.4\n%%EOF', 'latin1'));
  const t = pdfTool({ workdir, instanceRoot, analyze: null });
  const r = await t.execute('x', { path: 'scanned.pdf' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no extractable text/);
});
