import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unifiedDiff } from '../src/core/diffutil.js';

test('identical input → empty diff', () => {
  assert.equal(unifiedDiff('a\nb\nc', 'a\nb\nc'), '');
});

test('changed line produces a hunk with -/+ rows', () => {
  const d = unifiedDiff('a\nb\nc', 'a\nB\nc', { path: 'f.js' });
  assert.match(d, /--- a\/f\.js/);
  assert.match(d, /-b/);
  assert.match(d, /\+B/);
  assert.match(d, / a/); // context line kept
});

test('insert and delete are marked', () => {
  const d = unifiedDiff('x\ny', 'x\nnew1\nnew2\ny');
  assert.match(d, /\+new1/);
  assert.match(d, /\+new2/);
  assert.match(d, / x/);
});

test('oversized inputs degrade to a truncation note, not OOM', () => {
  const big = Array.from({ length: 3000 }, (_, i) => `line${i}`).join('\n');
  const d = unifiedDiff(big, big + '\nextra', { path: 'big' });
  assert.match(d, /diff too large/);
});

test('separated changes become separate hunks', () => {
  const a = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n');
  const b = a.replace('l1', 'L1').replace('l38', 'L38');
  const d = unifiedDiff(a, b);
  assert.equal((d.match(/@@/g) ?? []).length, 4); // two hunks × open/close marker pairs
});
