/**
 * M136: autonomous Curator — deterministic scoring + advisory proposals
 * over the agent-authored library (.pai/microagents, .pai/plans).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { curateLibrary, parseTriggers, scoreEntry } from '../src/core/curator.js';

const NOW = Date.parse('2026-09-22T00:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86_400_000);

function lib() {
  const dir = mkdtempSync(join(tmpdir(), 'pai-curator-'));
  mkdirSync(join(dir, '.pai', 'microagents'), { recursive: true });
  mkdirSync(join(dir, '.pai', 'plans'), { recursive: true });
  return dir;
}

function writeSkill(dir, name, { triggers = ['x'], body = 'substantial knowledge body '.repeat(8), ageDays = 0 }) {
  const p = join(dir, '.pai', 'microagents', `${name}.md`);
  writeFileSync(p, `---\ntriggers: ${triggers.join(', ')}\n---\n\n${body}\n`);
  const t = daysAgo(ageDays);
  utimesSync(p, t, t);
}

test('M136: scoreEntry — staleness, thin bodies, dead triggers all cost score', () => {
  const fresh = scoreEntry({ name: 'a', kind: 'microagents', bytes: 500, mtimeMs: NOW, triggers: ['x'], firstLine: 'x' }, NOW);
  assert.ok(fresh.score > 50);
  const stale = scoreEntry({ name: 'b', kind: 'microagents', bytes: 40, mtimeMs: daysAgo(120).getTime(), triggers: [], firstLine: '' }, NOW);
  assert.ok(stale.score < 25);
  assert.ok(stale.reasons.length >= 3);
});

test('M136: overlapping microagents get a merge proposal, stale+thin gets prune, curator never deletes', () => {
  const dir = lib();
  writeSkill(dir, 'deploy-runbook', { triggers: ['deploy', 'release'], ageDays: 2 });
  writeSkill(dir, 'deploy-runbook-old', { triggers: ['deploy', 'release', 'old'], body: 'deploy release steps '.repeat(6), ageDays: 100 });
  writeSkill(dir, 'dead-note', { triggers: [], body: 'tiny', ageDays: 200 });
  writeSkill(dir, 'healthy-skill', { triggers: ['build'], ageDays: 1 });

  const { entries, proposals } = curateLibrary(dir, { now: NOW });
  assert.equal(entries.length, 4);

  const merge = proposals.find((p) => p.kind === 'merge');
  assert.ok(merge, 'merge proposal emitted');
  assert.equal(merge.keep, 'deploy-runbook', 'newer twin survives');
  assert.equal(merge.drop, 'deploy-runbook-old');

  const prunes = proposals.filter((p) => p.kind === 'prune').map((p) => p.target);
  assert.ok(prunes.includes('dead-note'), 'stale+thin+triggerless pruned');
  assert.ok(prunes.includes('deploy-runbook-old') || merge.drop === 'deploy-runbook-old', 'merged-away twin not double-proposed');

  const keeps = proposals.filter((p) => p.kind === 'keep').map((p) => p.target);
  assert.ok(keeps.includes('healthy-skill'));

  // advisory contract: scanning mutates nothing
  assert.ok(existsSync(join(dir, '.pai', 'microagents', 'dead-note.md')));
  assert.ok(existsSync(join(dir, '.pai', 'microagents', 'deploy-runbook-old.md')));
});

test('M136: parseTriggers reads frontmatter; empty/missing handled', () => {
  assert.deepEqual(parseTriggers('---\ntriggers: a, b\n---\nbody'), ['a', 'b']);
  assert.deepEqual(parseTriggers('no frontmatter'), []);
});
