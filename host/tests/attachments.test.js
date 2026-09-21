import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { kindOfMime, normalizeAttachment, normalizeAttachments, partitionByCapability, describeAttachment, extractAttachmentText, bmpToPng, sniffMime } from '../src/core/attachments.js';

test('kindOfMime classifies media prefixes, rest is file', () => {
  assert.equal(kindOfMime('image/png'), 'image');
  assert.equal(kindOfMime('audio/mpeg'), 'audio');
  assert.equal(kindOfMime('video/mp4'), 'video');
  assert.equal(kindOfMime('application/pdf'), 'file');
  assert.equal(kindOfMime(''), 'file');
});

test('normalize requires a source; inline data derives byte count', () => {
  assert.equal(normalizeAttachment({}).ok, false);
  assert.equal(normalizeAttachment({ name: 'x' }).ok, false);
  const r = normalizeAttachment({ name: 'a.png', mime: 'image/png', data: 'aGk=' }); // 'hi'
  assert.equal(r.ok, true);
  assert.equal(r.attachment.kind, 'image');
  assert.equal(r.attachment.bytes, 2);
  assert.equal(r.attachment.source.type, 'inline');
  const p = normalizeAttachment({ name: 's.wav', mime: 'audio/wav', path: 'C:/x/s.wav', bytes: 10 });
  assert.equal(p.ok, true);
  assert.equal(p.attachment.kind, 'audio');
  assert.equal(p.attachment.source.type, 'path');
});

test('oversize attachment rejected; batch keeps the good ones', () => {
  const big = normalizeAttachment({ name: 'big', data: 'x', bytes: 9 * 1024 * 1024 });
  assert.equal(big.ok, false);
  assert.match(big.error, /exceeds/);
  const { attachments, rejected } = normalizeAttachments([
    { name: 'ok.png', mime: 'image/png', data: 'aGk=' },
    { name: 'bad', },
  ]);
  assert.equal(attachments.length, 1);
  assert.equal(rejected.length, 1);
});

test('partitionByCapability: images native for pi, audio/video degrade', () => {
  const { attachments } = normalizeAttachments([
    { name: 'p.png', mime: 'image/png', data: 'aGk=' },
    { name: 's.mp3', mime: 'audio/mpeg', data: 'aGk=' },
    { name: 'd.pdf', mime: 'application/pdf', data: 'aGk=' },
  ]);
  const { native, degraded } = partitionByCapability(attachments, { images: true });
  assert.equal(native.length, 1);
  assert.equal(native[0].kind, 'image');
  assert.deepEqual(degraded.map((a) => a.kind), ['audio', 'file']);
  assert.match(describeAttachment(degraded[0]), /kind="audio".*name="s.mp3"/);
});

test('extractAttachmentText: ipynb renders cells; text inlines; pdf stays null', () => {
  const nb = JSON.stringify({
    cells: [
      { cell_type: 'markdown', source: ['# title'] },
      { cell_type: 'code', source: ['x = 1\nprint(x)'], outputs: [{ text: '1\n' }] },
    ],
  });
  const { attachments } = normalizeAttachments([
    { name: 'n.ipynb', mime: 'application/x-ipynb+json', data: Buffer.from(nb).toString('base64') },
    { name: 's.py', mime: 'text/x-python', data: Buffer.from('print(1)').toString('base64') },
    { name: 'd.pdf', mime: 'application/pdf', data: 'aGk=' },
  ]);
  const ipynb = extractAttachmentText(attachments[0]);
  assert.match(ipynb, /cell 0 \[markdown\]/);
  assert.match(ipynb, /cell 1 \[code\]/);
  assert.match(ipynb, /out: 1/);
  assert.equal(extractAttachmentText(attachments[1]), 'print(1)');
  assert.equal(extractAttachmentText(attachments[2]), null, 'streamless pdf yields nothing — descriptor stays honest');
  assert.equal(extractAttachmentText({ kind: 'image', source: { type: 'inline', data: 'x' } }), null);
});

/** Hand-rolled minimal zip (one deflated entry) — enough for the EOCD reader. */
function makeZip(name, content) {
  const nameB = Buffer.from(name, 'utf-8');
  const comp = zlib.deflateRawSync(content);
  const lho = Buffer.alloc(30);
  lho.writeUInt32LE(0x04034b50, 0);
  lho.writeUInt16LE(20, 4); lho.writeUInt16LE(0, 6); lho.writeUInt16LE(8, 8);
  lho.writeUInt16LE(0, 10); lho.writeUInt16LE(0, 12);
  lho.writeUInt32LE(0, 14);
  lho.writeUInt32LE(comp.length, 18); lho.writeUInt32LE(content.length, 22);
  lho.writeUInt16LE(nameB.length, 26); lho.writeUInt16LE(0, 28);
  const local = Buffer.concat([lho, nameB, comp]);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(8, 10);
  cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14); cd.writeUInt32LE(0, 16);
  cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(content.length, 24);
  cd.writeUInt16LE(nameB.length, 28);
  cd.writeUInt32LE(0, 42);
  const central = Buffer.concat([cd, nameB]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

test('extractAttachmentText: docx pulls document.xml paragraph text', () => {
  const docx = makeZip('word/document.xml', Buffer.from(
    '<?xml version="1.0"?><w:document><w:body>' +
    '<w:p><w:r><w:t>Hello &amp; welcome</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Second para</w:t></w:r></w:p>' +
    '</w:body></w:document>', 'utf-8'));
  const { attachments } = normalizeAttachments([
    { name: 'r.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: docx.toString('base64') },
    { name: 'bad.docx', mime: 'application/octet-stream', data: Buffer.from('not a zip').toString('base64') },
  ]);
  const text = extractAttachmentText(attachments[0]);
  assert.match(text, /Hello & welcome/);
  assert.match(text, /Second para/);
  assert.equal(extractAttachmentText(attachments[1]), null, 'corrupt docx degrades to descriptor');
});

test('extractAttachmentText: pdf pulls text-show ops from FlateDecode streams', () => {
  const stream = zlib.deflateSync(Buffer.from('BT /F1 12 Tf 72 720 Td (Hello \\(PDF\\)) Tj T* (second line) Tj ET', 'latin1'));
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj<</Length ' + stream.length + '>>stream\n', 'latin1'),
    stream,
    Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
  ]);
  const { attachments } = normalizeAttachments([
    { name: 'doc.pdf', mime: 'application/pdf', data: pdf.toString('base64') },
  ]);
  const text = extractAttachmentText(attachments[0]);
  assert.match(text, /Hello \(PDF\)/);
  assert.match(text, /second line/);
});

test('magic-byte sniffing: mislabeled inline payloads reclassify to truth', () => {
  // PNG bytes declared as a PDF → image kind wins; model sees image, not fake doc
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64');
  const { attachments: a1 } = normalizeAttachments([{ name: 'x.pdf', mime: 'application/pdf', data: png }]);
  assert.equal(a1[0].mime, 'image/png');
  assert.equal(a1[0].kind, 'image');

  // EXE bytes declared as image → downgraded off the vision surface
  const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]).toString('base64');
  const { attachments: a2 } = normalizeAttachments([{ name: 'pic.png', mime: 'image/png', data: exe }]);
  assert.equal(a2[0].kind, 'file');

  // unknown bytes keep the declared mime (sniffing reclassifies only on certainty)
  const blob = Buffer.from('plain text data').toString('base64');
  const { attachments: a3 } = normalizeAttachments([{ name: 'f.bin', mime: 'text/plain', data: blob }]);
  assert.equal(a3[0].mime, 'text/plain');
});

test('clipboard BMP → PNG transcoding (BI_RGB only; else honest descriptor)', () => {
  // 2x1 24-bit BMP: row stride = ceil(2*3/4)*4 = 8 bytes (2 padding)
  const w = 2, h = 1, stride = 8, dataOff = 54;
  const bmp = Buffer.alloc(dataOff + stride);
  bmp[0] = 0x42; bmp[1] = 0x4d; // 'BM'
  bmp.writeUInt32LE(dataOff, 10);
  bmp.writeUInt32LE(40, 14);            // DIB header size
  bmp.writeInt32LE(w, 18); bmp.writeInt32LE(h, 22);
  bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp.writeUInt32LE(0, 30);
  bmp[dataOff] = 0x00; bmp[dataOff + 1] = 0x00; bmp[dataOff + 2] = 0xff; // BGR blue→wait R
  const png = bmpToPng(bmp);
  assert.ok(png, 'BI_RGB 24-bit transcodes');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  // normalizeAttachment: declared image/bmp bytes → real PNG rides as image/png
  const { attachments } = normalizeAttachments([{ name: 'clip.bmp', mime: 'image/bmp', data: bmp.toString('base64') }]);
  assert.equal(attachments[0].mime, 'image/png');
  assert.equal(attachments[0].kind, 'image');
  assert.equal(Buffer.from(attachments[0].source.data, 'base64').subarray(0, 4).toString('latin1'), '\x89PNG');
  // compressed/garbage BMP stays an honest bmp descriptor
  const bad = Buffer.from(bmp); bad.writeUInt32LE(1, 30); // BI_RLE8 — unsupported
  const { attachments: a2 } = normalizeAttachments([{ name: 'x.bmp', mime: 'image/bmp', data: bad.toString('base64') }]);
  assert.equal(a2[0].mime, 'image/bmp');
});
