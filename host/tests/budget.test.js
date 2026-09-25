/**
 * BudgetGovernor — bounded autonomy gate.
 * Reviewer-required properties:
 *  - admission BEFORE the expensive call; breach denies
 *  - consumed is a monotonic append-only ledger (rewind can't un-spend)
 *  - limits configured + unwritable ledger = fail-closed deny
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetGovernor } from '../src/core/budget.js';

const rig = (limits) => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-budget-'));
  const gov = new BudgetGovernor({ ledgerPath: join(dir, 'budget-ledger.jsonl'), limits });
  return { dir, gov };
};

test('admit allows when no limits configured; usage still lands on the ledger', () => {
  const { gov } = rig(null);
  assert.equal(gov.configured, false);
  assert.equal(gov.admit('s1').ok, true);
  gov.record({ scope: 's1', source: 'turn', usage: { input: 100, output: 50, cost: { total: 0.01 } } });
  const c = gov.consumed('s1');
  assert.equal(c.tokens, 150);
  assert.equal(c.calls, 1);
  assert.ok(Math.abs(c.cost - 0.01) < 1e-9);
});

test('token cap: admit denies once consumed reaches the limit', () => {
  const { gov } = rig({ maxTokensPerSession: 200 });
  gov.record({ scope: 's1', source: 'turn', usage: { input: 120, output: 80 } });
  const gate = gov.admit('s1');
  assert.equal(gate.ok, false);
  assert.equal(gate.rule, 'max_tokens');
  // a different scope is unaffected — budgets are per-scope
  assert.equal(gov.admit('s2').ok, true);
});

test('cost cap denies at the configured ceiling', () => {
  const { gov } = rig({ maxCostPerSessionUsd: 0.05 });
  gov.record({ scope: 's1', source: 'turn', usage: { input: 10, cost: { total: 0.06 } } });
  assert.equal(gov.admit('s1').ok, false);
  assert.equal(gov.breach('s1').rule, 'max_cost');
});

test('the ledger is append-only: deleting session state cannot un-spend it', () => {
  const { dir, gov } = rig({ maxTokensPerSession: 1000 });
  gov.record({ scope: 's1', source: 'turn', usage: { input: 300, output: 200 } });
  // simulate rewind: session head moves, ledger file untouched
  const gov2 = new BudgetGovernor({ ledgerPath: join(dir, 'budget-ledger.jsonl'), limits: { maxTokensPerSession: 600 } });
  assert.equal(gov2.consumed('s1').tokens, 500);
  assert.equal(gov2.admit('s1').ok, true); // 500 < 600
  gov2.record({ scope: 's1', source: 'compaction', usage: { input: 80, output: 40 } });
  assert.equal(gov2.consumed('s1').tokens, 620);
  assert.equal(gov2.admit('s1').ok, false); // now over — rewind never rolled it back
});

test('fail-closed: configured limits + unwritable ledger denies admission', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-budget-broken-'));
  // a directory at the ledger path makes appendFileSync throw
  const gov = new BudgetGovernor({ ledgerPath: join(dir, 'no-such-dir-deep', 'x'), limits: { maxTokensPerSession: 1 } });
  // mkdirSync(recursive) created it — break it by pointing at an existing FILE path's child
  const filePath = join(dir, 'blocker');
  writeFileSync(filePath, 'x');
  const gov2 = new BudgetGovernor({ ledgerPath: join(filePath, 'ledger.jsonl'), limits: { maxTokensPerSession: 1 } });
  assert.equal(gov2.broken, true);
  assert.equal(gov2.admit('s1').ok, false);
  assert.equal(gov2.admit('s1').rule, 'ledger_broken');
  // unconfigured + broken ledger still admits (observe-only mode)
  const gov3 = new BudgetGovernor({ ledgerPath: join(filePath, 'ledger2.jsonl'), limits: null });
  assert.equal(gov3.admit('s1').ok, true);
});

test('calls cap counts usage-bearing events across sources', () => {
  const { gov } = rig({ maxCallsPerSession: 3 });
  gov.record({ scope: 's1', source: 'turn', usage: { input: 1 } });
  gov.record({ scope: 's1', source: 'retry', usage: { input: 1 } });
  gov.record({ scope: 's1', source: 'compaction', usage: { input: 1 } });
  assert.equal(gov.admit('s1').ok, false);
  assert.equal(gov.breach('s1').rule, 'max_calls');
});

test('tryCommit: charging exactly to the limit is legal, then scope is exhausted', () => {
  const { gov } = rig({ maxTokensPerSession: 1000 });
  gov.record({ scope: 's1', source: 'turn', usage: { input: 400 }, countCall: false });
  const c = gov.tryCommit('s1', { total: 600 }, 'delegate_commit:x');
  assert.equal(c.ok, true);
  assert.equal(gov.consumed('s1').tokens, 1000);
  assert.equal(gov.admit('s1').ok, false); // exactly at cap — nothing left
});

test('tryCommit: overshoot rolls back atomically via refund row', () => {
  const { gov } = rig({ maxTokensPerSession: 1000 });
  gov.record({ scope: 's1', source: 'turn', usage: { input: 900 }, countCall: false });
  const c = gov.tryCommit('s1', { total: 200 }, 'delegate_commit:x'); // would hit 1100
  assert.equal(c.ok, false);
  assert.equal(gov.consumed('s1').tokens, 900, 'refund row restored the pre-commit balance');
  // ledger still append-only — the commit attempt is visible history
  const rows = readFileSync(gov.ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.filter((r) => r.source === 'delegate_commit:x').length, 1);
  assert.equal(rows.filter((r) => r.source === 'delegate_commit:x:rollback').length, 1);
});

test('refund: algebraically cancels a committed slice (spawn-failure path)', () => {
  const { gov } = rig({ maxTokensPerSession: 1000 });
  gov.tryCommit('s1', { total: 500, calls: 3 }, 'delegate_commit:y');
  assert.equal(gov.consumed('s1').tokens, 500);
  assert.equal(gov.consumed('s1').calls, 3);
  gov.refund('s1', { total: 500, calls: 3 }, 'delegate_refund:y');
  assert.equal(gov.consumed('s1').tokens, 0);
  assert.equal(gov.consumed('s1').calls, 0);
  assert.equal(gov.admit('s1').ok, true);
});

test('commit-on-issue is durable: a fresh governor sees the committed slice', () => {
  const { gov } = rig({ maxTokensPerSession: 1000 });
  gov.tryCommit('s1', { total: 700 }, 'delegate_commit:z');
  const gov2 = new BudgetGovernor({ ledgerPath: gov.ledgerPath, limits: { maxTokensPerSession: 1000 } });
  assert.equal(gov2.consumed('s1').tokens, 700, 'commit survives process restart — append-only ledger');
  assert.equal(gov2.remaining('s1').tokens, 300);
});

test('rollup aggregates across scopes with windowing, skips non-usage rows, nets refunds', () => {
  const { gov } = rig(null);
  // PIN THE CLOCK. The rows below are placed relative to `now` and bucketed by
  // UTC date, so with the real clock this test's meaning changes with the time
  // of day: run it within an hour after UTC midnight and `now - 1h` is still the
  // PREVIOUS day, so rows land in the wrong bucket and the split assertions fail.
  // It passed for months and then failed at 00:05Z. Ambient state the test does
  // not control is the defect — control it.
  const now = Date.UTC(2026, 8, 23, 12, 0, 0); // midday UTC: no boundary within ±24h
  // hand-write rows so `at` is pinned (record() stamps Date.now())
  const rows = [
    { at: now - 86_400_000, scope: 's-old', source: 'turn', tokens: 500, cost: 0.5, calls: 2 },
    { at: now - 3_600_000, scope: 's1', source: 'turn', tokens: 100, cost: 0.10, calls: 1 },
    { at: now - 1_800_000, scope: 's2', source: 'subagent', tokens: 200, cost: 0.20, calls: 3 },
    { at: now - 900_000, scope: 's1', source: 'delegate_refund', tokens: -40, cost: -0.04, calls: -1 },
    { at: now - 600_000, kind: 'ledger_open' }, // non-usage row — must be skipped
    { at: now - 300_000, scope: 's2', source: 'job', tokens: 50, cost: 0.05, calls: 1 },
  ];
  for (const r of rows) appendFileSync(gov.ledgerPath, JSON.stringify(r) + '\n');

  const all = gov.rollup();
  assert.equal(all.rows, 5, 'kind rows excluded from the count');
  assert.equal(all.total.tokens, 810);
  assert.equal(all.total.calls, 6);
  assert.ok(Math.abs(all.total.cost - 0.81) < 1e-9, 'refund nets against the total');
  assert.equal(all.byScope['s1'].tokens, 60);
  assert.equal(all.byScope['s1'].calls, 0, 'refund cancels the call too');
  assert.equal(all.byScope['s2'].tokens, 250);
  const oldDay = new Date(now - 86_400_000).toISOString().slice(0, 10);
  const today = new Date(now).toISOString().slice(0, 10);
  assert.equal(all.byDay[oldDay].tokens, 500);
  assert.equal(all.byDay[today].tokens, 310, 'UTC day buckets split the window honestly');

  const recent = gov.rollup({ since: now - 2_000_000 });
  assert.equal(recent.rows, 3, 'window excludes s-old and the oldest s1 row');
  assert.equal(recent.total.tokens, 210);

  const none = gov.rollup({ since: now + 1_000 });
  assert.equal(none.rows, 0);
  assert.equal(none.total.tokens, 0);
});

test('rollup on a ledger with only non-usage rows returns zeros, not an error', () => {
  const { gov } = rig(null); // construction wrote only the ledger_open kind row
  const r = gov.rollup({ since: 0 });
  assert.equal(r.rows, 0);
  assert.deepEqual(r.total, { tokens: 0, cost: 0, calls: 0 });
});

test('read-path cache: external (cross-process) appends invalidate via stat fingerprint', () => {
  const { gov } = rig(null);
  gov.record({ scope: 's1', usage: { input: 10 } });
  assert.equal(gov.consumed('s1').tokens, 10);
  assert.equal(gov.consumed('s1').tokens, 10, 'warm cache hit — same value');
  // a delegate child in ANOTHER process appends directly to the shared ledger
  appendFileSync(gov.ledgerPath, JSON.stringify({ at: Date.now(), scope: 's1', source: 'job', tokens: 77, cost: 0, calls: 1 }) + '\n');
  assert.equal(gov.consumed('s1').tokens, 87, 'external append visible on the next read');
  assert.equal(gov.rollup().total.tokens, 87);
});

// dedup-h #2263 — per-call trace surface: record() persists model + token
// split; traces() returns last-N rows, cache-hit rate, per-model rollup.
test('#2263 traces: model stamp, token split, cache-hit rate, byModel, scope filter', () => {
  const { gov } = rig(null);
  gov.record({ scope: 's1', source: 'turn', usage: { input: 700, output: 100, cacheRead: 200, cacheWrite: 0, cost: { total: 0.05 } }, countCall: false, model: 'gpt-x' });
  gov.record({ scope: 's1', source: 'compaction', usage: { input: 300, output: 50, cost: { total: 0.02 } }, countCall: false, model: 'haiku' });
  gov.record({ scope: 's2', source: 'turn', usage: { input: 10, output: 5 }, countCall: false, model: 'other' }); // foreign scope
  appendFileSync(gov.ledgerPath, JSON.stringify({ at: Date.now(), scope: 's1', source: 'turn', tokens: 42, cost: 0.001, calls: 1 }) + '\n'); // legacy row, no detail/model

  const t = gov.traces({ scope: 's1', n: 20 });
  assert.equal(t.shown, 3, 'foreign scope excluded; legacy row included');
  assert.equal(t.rows[0].model, 'gpt-x');
  assert.deepEqual({ input: t.rows[0].input, output: t.rows[0].output, cacheRead: t.rows[0].cacheRead }, { input: 700, output: 100, cacheRead: 200 });
  assert.equal(t.rows[2].model, null, 'legacy row honestly unattributed');
  assert.equal(t.rows[2].input, null, 'legacy row has no token split');
  // cacheHitRate = cacheRead / (input + cacheRead) = 200 / 1200
  assert.ok(Math.abs(t.cacheHitRate - 200 / 1200) < 1e-9, `hit rate ${t.cacheHitRate}`);
  assert.equal(t.byModel['gpt-x'].tokens, 1000);
  assert.equal(t.byModel['haiku'].calls, 0, 'countCall:false bills zero calls');
  assert.ok('(unattributed)' in t.byModel, 'legacy rows bucket as unattributed');

  const capped = gov.traces({ scope: 's1', n: 1 });
  assert.equal(capped.shown, 1, 'n bounds the tail slice');

  const noCache = gov.traces({ scope: 's2' });
  assert.equal(noCache.cacheHitRate, 0, 'input-bearing calls with zero cache → honest 0%');
  // a scope whose rows carry no detail at all → null, never a fabricated rate
  appendFileSync(gov.ledgerPath, JSON.stringify({ at: Date.now(), scope: 's3', source: 'turn', tokens: 5, cost: 0, calls: 1 }) + '\n');
  assert.equal(gov.traces({ scope: 's3' }).cacheHitRate, null, 'detail-less rows → null, not a fake 0%');
});
