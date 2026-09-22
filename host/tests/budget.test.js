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
  const now = Date.now();
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
