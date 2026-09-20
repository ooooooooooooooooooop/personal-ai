import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSteering } from '../src/core/steering.js';

const dir = () => mkdtempSync(join(tmpdir(), 'pai-steer-'));

test('no steering files → null', () => {
  assert.equal(loadSteering(dir()), null);
});

test('.pai/steering/*.md + named files load into the envelope block', () => {
  const w = dir();
  mkdirSync(join(w, '.pai', 'steering'), { recursive: true });
  writeFileSync(join(w, '.pai', 'steering', 'voice.md'), 'talk plainly');
  writeFileSync(join(w, '.pai', 'product.md'), 'the product is X');
  const out = loadSteering(w);
  assert.match(out, /steering\/voice\.md/);
  assert.match(out, /talk plainly/);
  assert.match(out, /product\.md/);
});

test('compat rule dirs (.claude/.cursor/.windsurf/.devin) load as steering', () => {
  const w = dir();
  mkdirSync(join(w, '.claude', 'rules'), { recursive: true });
  mkdirSync(join(w, '.cursor', 'rules'), { recursive: true });
  writeFileSync(join(w, '.claude', 'rules', 'style.md'), 'always english comments');
  writeFileSync(join(w, '.cursor', 'rules', 'api.mdc'), '---\nglobs: src/**\n---\nuse the strict provider');
  writeFileSync(join(w, '.cursor', 'rules', 'skip.txt'), 'not a rule file');
  const out = loadSteering(w);
  assert.match(out, /\.claude\/rules\/style\.md/);
  assert.match(out, /always english comments/);
  assert.match(out, /\.cursor\/rules\/api\.mdc/); // .mdc included
  assert.doesNotMatch(out, /skip\.txt/);          // non-md ignored
});
