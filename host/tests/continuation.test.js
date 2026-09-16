/**
 * M3 evidence gate + governed continuation — real temp ledger, restart durable.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { instancePaths } from '../src/core/instance.js';
import { AuditWriter } from '../src/core/audit.js';
import { evaluateEvidence, renderGap } from '../src/core/evidence.js';
import { ContinuationGovernor } from '../src/core/continuation.js';

const REQUIREMENTS = [
  { id: 'wrote', kind: 'tool_success', tool: 'write' },
  { id: 'tested', kind: 'tool_success', tool: 'powershell' },
];

const turn = (toolCalls, text = '') => ({ toolCalls, assistantText: text, fileChanges: [] });

test('evidence evaluator returns unmet gap ids', () => {
  const r = evaluateEvidence(REQUIREMENTS, turn([
    { name: 'write', isError: false },
    { name: 'powershell', isError: true }, // ran but failed — not success
  ]));
  assert.equal(r.sufficient, false);
  assert.deepEqual(r.gaps, ['tested']);
  const full = evaluateEvidence(REQUIREMENTS, turn([
    { name: 'write', isError: false },
    { name: 'powershell', isError: false },
  ]));
  assert.equal(full.sufficient, true);
});

test('gap text is structured and repair-oriented', () => {
  const text = renderGap(REQUIREMENTS, ['tested']);
  assert.match(text, /EVIDENCE GAP/);
  assert.match(text, /tested: tool_success \(tool=powershell\)/);
});

function governor(dir, over = {}) {
  const paths = instancePaths(dir);
  return new ContinuationGovernor({
    ledgerPath: join(dir, 'continuation.jsonl'),
    audit: new AuditWriter(paths),
    requirements: REQUIREMENTS,
    ...over,
  });
}

test('insufficient evidence → continue with steerText; sufficient → complete', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-cont-'));
  const g = governor(dir);
  const d1 = g.evaluate(turn([{ name: 'write', isError: false }]));
  assert.equal(d1.action, 'continue');
  assert.ok(d1.steerText.includes('tested'));
  const d2 = g.evaluate(turn([
    { name: 'write', isError: false },
    { name: 'powershell', isError: false },
  ]));
  assert.equal(d2.action, 'complete');
});

test('repeating identical gaps → BLOCKED (loop breaker)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-cont-'));
  const g = governor(dir, { noProgressLimit: 3 });
  const same = turn([{ name: 'write', isError: false }]);
  assert.equal(g.evaluate(same).action, 'continue');
  assert.equal(g.evaluate(same).action, 'continue');
  const d3 = g.evaluate(same);
  assert.equal(d3.action, 'blocked');
  assert.equal(d3.reason, 'no_progress');
});

test('max continuations → BLOCKED; ledger survives restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-cont-'));
  const g = governor(dir, { maxContinuations: 2, noProgressLimit: 99 });
  const t1 = turn([{ name: 'write', isError: false }]);
  const t2 = turn([{ name: 'read', isError: false }]); // different gap set each time
  const t3 = turn([{ name: 'ls', isError: false }]);
  g.evaluate(t1);
  g.evaluate(t2);
  const d = g.evaluate(t3);
  assert.equal(d.action, 'blocked');
  assert.equal(d.reason, 'max_continuations');

  // simulated restart: new governor reads the same ledger — budget position kept
  const g2 = governor(dir, { maxContinuations: 2 });
  const d2 = g2.evaluate(t1);
  assert.equal(d2.action, 'blocked');
  const lines = readFileSync(join(dir, 'continuation.jsonl'), 'utf-8').trim().split('\n');
  assert.ok(lines.length >= 4);
});
