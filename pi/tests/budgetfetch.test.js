/**
 * Provider-request budget gate — the authoritative admission layer.
 *
 * What must be proven:
 *  - an admitted provider request passes through AND counts one call
 *  - an over-budget request gets a synthetic 402 BEFORE any bytes leave —
 *    covering assistant turns, auto-retries, compaction, deferred calls
 *    (they all bottom out in fetch)
 *  - non-provider hosts are never gated nor billed
 *  - retries each consume call budget (N attempts = N calls)
 *  - a broken ledger + configured limits denies (fail-closed)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetGovernor } from '../../host/src/core/budget.js';
import { installBudgetFetch, collectProviderHosts } from '../src/adapter/budgetfetch.js';

const PROVIDER = 'http://api.testprovider.local/v1/chat';

function makeBudget(limits) {
  const dir = mkdtempSync(join(tmpdir(), 'pai-bfetch-'));
  const auditRows = [];
  const budget = new BudgetGovernor({
    ledgerPath: join(dir, 'ledger.jsonl'),
    limits,
    audit: { write: (r) => auditRows.push(r) },
  });
  return { budget, auditRows };
}

function harness({ limits = null, hosts = [new URL(PROVIDER).host], scope = 'sess-1' }) {
  const { budget, auditRows } = makeBudget(limits);
  const calls = [];
  const realFetch = globalThis.fetch;
  // deterministic stub standing in for the network
  globalThis.fetch = async (url) => { calls.push(String(url)); return new Response('{}', { status: 200 }); };
  const ungate = installBudgetFetch({
    budget,
    getScope: () => scope,
    getProviderHosts: () => new Set(hosts),
    audit: { write: (r) => auditRows.push(r) },
  });
  return {
    budget, auditRows, calls,
    done: () => { ungate(); globalThis.fetch = realFetch; },
  };
}

test('provider request under cap: admitted, forwarded, one call billed', async () => {
  const h = harness({ limits: { maxCallsPerSession: 3 } });
  try {
    const r = await globalThis.fetch(PROVIDER, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.deepEqual(h.calls, [PROVIDER]);
    assert.equal(h.budget.consumed('sess-1').calls, 1);
  } finally { h.done(); }
});

test('over-budget provider request: synthetic 402, network never touched', async () => {
  const h = harness({ limits: { maxTokensPerSession: 10 } });
  try {
    // seed the scope past the token cap
    h.budget.record({ scope: 'sess-1', source: 'turn', usage: { input: 20 }, countCall: false });
    const r = await globalThis.fetch(PROVIDER, { method: 'POST' });
    assert.equal(r.status, 402);
    const body = await r.json();
    assert.equal(body.error.type, 'budget_exceeded');
    assert.match(body.error.message, /max_tokens 20 >= 10/);
    assert.equal(h.calls.length, 0, 'denied request must not reach the network');
    assert.ok(h.auditRows.some((a) => a.kind === 'BUDGET_PROVIDER_DENY'));
  } finally { h.done(); }
});

test('each retry attempt consumes call budget — N attempts = N calls', async () => {
  const h = harness({ limits: { maxCallsPerSession: 2 } });
  try {
    assert.equal((await globalThis.fetch(PROVIDER)).status, 200); // attempt 1
    assert.equal((await globalThis.fetch(PROVIDER)).status, 200); // attempt 2
    // attempt 3 hits the call cap → denied at admission, no network
    const r = await globalThis.fetch(PROVIDER);
    assert.equal(r.status, 402);
    assert.equal(h.calls.length, 2, 'third request never reached the network');
    assert.equal(h.budget.consumed('sess-1').calls, 2);
  } finally { h.done(); }
});

test('non-provider hosts pass through unbilled', async () => {
  const h = harness({ limits: { maxCallsPerSession: 1 } });
  try {
    const r = await globalThis.fetch('http://127.0.0.1:8317/health');
    assert.equal(r.status, 200);
    assert.equal(h.budget.consumed('sess-1').calls, 0);
  } finally { h.done(); }
});

test('unconfigured budget: observe-only, everything admitted', async () => {
  const h = harness({ limits: null });
  try {
    for (let i = 0; i < 5; i++) await globalThis.fetch(PROVIDER);
    assert.equal(h.calls.length, 5);
  } finally { h.done(); }
});

test('broken ledger + configured limits: fail-closed deny', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-bfetch-broken-'));
  const auditRows = [];
  const budget = new BudgetGovernor({
    // a path that cannot be created: file-as-directory
    ledgerPath: join(dir, 'blocker', 'ledger.jsonl'),
    limits: { maxTokensPerSession: 100 },
    audit: { write: (r) => auditRows.push(r) },
  });
  // force the broken state deterministically
  budget.broken = true;
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { calls.push(u); return new Response('{}'); };
  const ungate = installBudgetFetch({
    budget,
    getScope: () => 's',
    getProviderHosts: () => new Set([new URL(PROVIDER).host]),
    audit: { write: (r) => auditRows.push(r) },
  });
  try {
    const r = await globalThis.fetch(PROVIDER);
    assert.equal(r.status, 402);
    assert.equal(calls.length, 0);
  } finally { ungate(); globalThis.fetch = realFetch; }
});

test('collectProviderHosts unions built-ins with configured baseUrls', () => {
  const hosts = collectProviderHosts({
    getProviders: () => [
      { baseUrl: 'http://127.0.0.1:8317/v1' },
      { baseUrl: 'not a url' },
      {},
    ],
  });
  assert.ok(hosts.has('127.0.0.1:8317'), 'custom provider host included');
  assert.ok(hosts.has('api.openai.com'), 'built-in default included');
  assert.ok(collectProviderHosts(null).has('api.anthropic.com'), 'null runtime still yields built-ins');
});

test('ungate restores the original fetch', async () => {
  const real = globalThis.fetch;
  const h = harness({ limits: { maxCallsPerSession: 1 } });
  assert.notEqual(globalThis.fetch, real);
  h.done();
  assert.equal(globalThis.fetch, real);
});
