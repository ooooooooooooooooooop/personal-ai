import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PaiIgnore } from '../src/core/paiignore.js';
import { loadSteering } from '../src/core/steering.js';

test('absent .paiignore → unloaded, nothing ignored', () => {
  const w = mkdtempSync(join(tmpdir(), 'pai-ign-'));
  const ig = new PaiIgnore(w);
  assert.equal(ig.loaded, false);
  assert.equal(ig.isIgnored(join(w, 'secrets/key.pem')), false);
});

test('dir, basename glob, ** patterns and comments', () => {
  const w = mkdtempSync(join(tmpdir(), 'pai-ign-'));
  const ig = new PaiIgnore(w, '# comment\n/secrets/\n*.pem\nbuild/**/*.log\n');
  assert.equal(ig.isIgnored(join(w, 'secrets/key.txt')), true);
  assert.equal(ig.isIgnored(join(w, 'x/secrets/deep.txt')), false); // '/' prefix anchors to root
  assert.equal(ig.isIgnored(join(w, 'certs/a.pem')), true); // basename glob matches any depth
  assert.equal(ig.isIgnored(join(w, 'build/x/y/app.log')), true);
  assert.equal(ig.isIgnored(join(w, 'src/app.js')), false);
  // unanchored dir pattern matches anywhere (gitignore truth)
  const ig2 = new PaiIgnore(w, 'secrets/\n');
  assert.equal(ig2.isIgnored(join(w, 'x/secrets/deep.txt')), true);
});

test('steering: .pai/steering/*.md + named conventions, bounded', () => {
  const w = mkdtempSync(join(tmpdir(), 'pai-steer-'));
  assert.equal(loadSteering(w), null);
  mkdirSync(join(w, '.pai', 'steering'), { recursive: true });
  writeFileSync(join(w, '.pai', 'steering', 'api.md'), 'use REST v2 only');
  writeFileSync(join(w, '.pai', 'product.md'), 'a todo app');
  const s = loadSteering(w);
  assert.match(s, /<steering-file name="steering\/api\.md">/);
  assert.match(s, /use REST v2 only/);
  assert.match(s, /<steering-file name="product\.md">/);
});
