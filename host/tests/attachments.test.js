import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kindOfMime, normalizeAttachment, normalizeAttachments, partitionByCapability, describeAttachment } from '../src/core/attachments.js';

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
