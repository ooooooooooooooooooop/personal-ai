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

test('frontmatter apply modes: manual indexed not injected, globs declare scope', () => {
  const w = dir();
  mkdirSync(join(w, '.pai', 'steering'), { recursive: true });
  writeFileSync(join(w, '.pai', 'steering', 'always.md'), 'always here');
  writeFileSync(join(w, '.pai', 'steering', 'scoped.md'), '---\nglobs: ["src/**", "tests/**"]\n---\nonly in src');
  writeFileSync(join(w, '.pai', 'steering', 'manual.md'), '---\napply: manual\n---\nread me on demand');
  const out = loadSteering(w);
  assert.match(out, /always here/);
  assert.match(out, /scope="src\/\*\*, tests\/\*\*"/);
  assert.match(out, /only in src/);
  assert.doesNotMatch(out, /read me on demand/);       // manual body not injected
  assert.match(out, /<manual-rules>.*manual\.md/);      // but indexed by name
});

test('root-level compat files from other harnesses are loaded (Crush list)', () => {
  const w = dir();
  writeFileSync(join(w, 'CLAUDE.md'), 'claude legacy rules');
  writeFileSync(join(w, 'GEMINI.md'), 'gemini legacy rules');
  writeFileSync(join(w, '.cursorrules'), 'cursor legacy rules');
  writeFileSync(join(w, 'AGENTS.md'), 'agents guidance');
  mkdirSync(join(w, '.github'), { recursive: true });
  writeFileSync(join(w, '.github', 'copilot-instructions.md'), 'copilot hints');
  const out = loadSteering(w);
  for (const re of [/claude legacy rules/, /gemini legacy rules/, /cursor legacy rules/, /agents guidance/, /copilot hints/]) {
    assert.match(out, re);
  }
});

test('native .pai steering precedes compat files in render order', () => {
  const w = dir();
  mkdirSync(join(w, '.pai', 'steering'), { recursive: true });
  writeFileSync(join(w, '.pai', 'steering', 'native.md'), 'NATIVE_BODY');
  writeFileSync(join(w, 'CLAUDE.md'), 'COMPAT_BODY');
  const out = loadSteering(w);
  assert.ok(out.indexOf('NATIVE_BODY') < out.indexOf('COMPAT_BODY'));
});

test('ancestor walk: parent-dir AGENTS.md applies to workdirs below it', () => {
  const root = dir();
  const w = join(root, 'repo', 'packages', 'sub');
  mkdirSync(w, { recursive: true });
  writeFileSync(join(root, 'repo', 'AGENTS.md'), 'ANCESTOR_GUIDANCE');
  writeFileSync(join(root, 'repo', 'CLAUDE.md'), 'ANCESTOR_CLAUDE');
  const out = loadSteering(w);
  assert.match(out, /ANCESTOR_GUIDANCE/);
  assert.match(out, /ANCESTOR_CLAUDE/);
  assert.match(out, /dir=".*repo"/); // marked as ancestor-sourced
});

test('new compat files: .goosehints/.clinerules/CONVENTIONS.md load', () => {
  const w = dir();
  writeFileSync(join(w, '.goosehints'), 'goose hints');
  writeFileSync(join(w, '.clinerules'), 'cline rules');
  writeFileSync(join(w, 'CONVENTIONS.md'), 'house conventions');
  const out = loadSteering(w);
  for (const re of [/goose hints/, /cline rules/, /house conventions/]) assert.match(out, re);
});

test('personal-local files: *.local.md load last with local marker', () => {
  const w = dir();
  writeFileSync(join(w, 'AGENTS.md'), 'shared rules');
  writeFileSync(join(w, 'AGENTS.local.md'), 'personal overrides');
  const out = loadSteering(w);
  assert.match(out, /shared rules/);
  assert.match(out, /personal overrides/);
  assert.match(out, /local="personal"/);
  // local reads AFTER the shared file (override ordering)
  assert.ok(out.indexOf('personal overrides') > out.indexOf('shared rules'));
});
