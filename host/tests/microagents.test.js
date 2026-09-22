/**
 * Microagents (H-family, OpenHands reference) — trigger-scoped knowledge.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMicroagents, matchMicroagents, renderKnowledge } from '../src/core/microagents.js';

const mkDir = (files = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-micro-'));
  const mdir = join(dir, '.pai', 'microagents');
  mkdirSync(mdir, { recursive: true });
  for (const [f, content] of Object.entries(files)) writeFileSync(join(mdir, f), content);
  return dir;
};

test('load: parses frontmatter triggers; files without triggers skipped', () => {
  const dir = mkDir({
    'deploy.md': '---\ntriggers: deploy, release\n---\nAlways run migrations first.\n',
    'style.md': 'no frontmatter — never triggers\n',
    'empty.md': '---\ntriggers:\n---\nno triggers\n',
  });
  const agents = loadMicroagents(dir);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].name, 'deploy');
  assert.deepEqual(agents[0].triggers, ['deploy', 'release']);
  assert.match(agents[0].body, /migrations/);
});

test('match: literal + regex triggers; no match → empty', () => {
  const dir = mkDir({
    'db.md': '---\ntriggers: migration|schema\n---\nUse the migration runner.\n',
  });
  const agents = loadMicroagents(dir);
  assert.equal(matchMicroagents(agents, 'run the migration now').length, 1);
  assert.equal(matchMicroagents(agents, 'schema change needed').length, 1);
  assert.equal(matchMicroagents(agents, 'unrelated topic').length, 0);
  assert.equal(matchMicroagents(agents, '').length, 0);
});

test('renderKnowledge wraps in <knowledge name> blocks', () => {
  const out = renderKnowledge([{ name: 'x', body: 'do the thing' }]);
  assert.match(out, /<knowledge name="x">\ndo the thing\n<\/knowledge>/);
});

test('missing .pai/microagents dir → empty, never throws', () => {
  assert.deepEqual(loadMicroagents(mkdtempSync(join(tmpdir(), 'pai-none-'))), []);
});

test('oversized body is capped with a visible marker — never injected whole, never cut silently', () => {
  const dir = mkDir({
    'huge.md': `---\ntriggers: big\n---\n${'x'.repeat(20 * 1024)}`,
  });
  const agents = loadMicroagents(dir);
  assert.equal(agents.length, 1);
  assert.ok(agents[0].body.length < 17 * 1024);
  assert.match(agents[0].body, /\[truncated: file exceeds the 16KB per-microagent cap\]/);
});
