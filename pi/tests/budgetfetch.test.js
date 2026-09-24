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
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetGovernor } from '../../host/src/core/budget.js';
import { installBudgetFetch, collectProviderHosts, collectPrivateAllowedHosts, collectKeyPool } from '../src/adapter/budgetfetch.js';

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

function harness({ limits = null, hosts = [new URL(PROVIDER).host], scope = 'sess-1', privateHosts = new Set() }) {
  const { budget, auditRows } = makeBudget(limits);
  const calls = [];
  const realFetch = globalThis.fetch;
  // deterministic stub standing in for the network
  globalThis.fetch = async (url) => { calls.push(String(url)); return new Response('{}', { status: 200 }); };
  const ungate = installBudgetFetch({
    budget,
    getScope: () => scope,
    getProviderHosts: () => new Set(hosts),
    getPrivateAllowedHosts: () => privateHosts,
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

// ── dedup-h #1402: egress allowPrivateNetwork per-provider ──────────────────
// The egress check runs ahead of the budget short-circuit (it is not a spend
// rule). IP-literal providers keep the tests DNS-free and deterministic.

const PRIV = 'http://10.9.8.7:11434/v1/chat';      // RFC1918 self-hosted
const PRIV_HOST = new URL(PRIV).host;
const LOOP = 'http://127.0.0.1:11434/v1/chat';     // loopback self-hosted
const META = 'http://169.254.169.254/latest/meta'; // link-local / metadata
const PUB_IP = 'http://203.0.113.9/v1/chat';       // public literal, no DNS

test('private provider without opt-in: synthetic 403 before any bytes leave', async () => {
  const h = harness({ hosts: [PRIV_HOST] });
  try {
    const r = await globalThis.fetch(PRIV, { method: 'POST' });
    assert.equal(r.status, 403);
    const body = await r.json();
    assert.equal(body.error.type, 'private_egress_refused');
    assert.match(body.error.message, /allowPrivateNetwork/);
    assert.equal(h.calls.length, 0, 'refused request must not reach the network');
    const row = h.auditRows.find((a) => a.kind === 'PROVIDER_PRIVATE_EGRESS_REFUSED');
    assert.ok(row, 'denial is audited');
    assert.equal(row.data.host, PRIV_HOST);
    assert.equal(row.data.resolved, '10.9.8.7');
  } finally { h.done(); }
});

test('loopback and link-local metadata providers are refused by default', async () => {
  const h = harness({ hosts: [new URL(LOOP).host, new URL(META).host] });
  try {
    assert.equal((await globalThis.fetch(LOOP)).status, 403);
    assert.equal((await globalThis.fetch(META)).status, 403);
    assert.equal(h.calls.length, 0);
    assert.equal(h.auditRows.filter((a) => a.kind === 'PROVIDER_PRIVATE_EGRESS_REFUSED').length, 2);
  } finally { h.done(); }
});

test('allowPrivateNetwork opt-in admits exactly the declared host — scoped, not global', async () => {
  const h = harness({
    hosts: [PRIV_HOST, new URL(LOOP).host],
    privateHosts: new Set([PRIV_HOST]),
  });
  try {
    const r = await globalThis.fetch(PRIV, { method: 'POST' });
    assert.equal(r.status, 200, 'opted-in private provider admitted');
    assert.deepEqual(h.calls, [PRIV]);
    // another private provider without the flag stays refused
    assert.equal((await globalThis.fetch(LOOP)).status, 403);
    assert.deepEqual(h.calls, [PRIV], 'non-opted private host still blocked');
  } finally { h.done(); }
});

test('public provider literal is unaffected by the egress gate', async () => {
  const h = harness({ hosts: [new URL(PUB_IP).host] });
  try {
    const r = await globalThis.fetch(PUB_IP, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.deepEqual(h.calls, [PUB_IP]);
    assert.ok(!h.auditRows.some((a) => a.kind === 'PROVIDER_PRIVATE_EGRESS_REFUSED'));
  } finally { h.done(); }
});

test('non-provider traffic to private space is untouched by the provider gate', async () => {
  const h = harness({ hosts: [PUB_IP ? new URL(PUB_IP).host : 'x'] });
  try {
    // same private address, but not a registered provider host → pass-through
    const r = await globalThis.fetch('http://127.0.0.1:9/local-thing');
    assert.equal(r.status, 200);
    assert.ok(!h.auditRows.some((a) => a.kind === 'PROVIDER_PRIVATE_EGRESS_REFUSED'));
  } finally { h.done(); }
});

test('egress refusal precedes the budget rule — not a spend decision', async () => {
  const h = harness({ hosts: [PRIV_HOST], limits: { maxCallsPerSession: 0 } });
  try {
    const r = await globalThis.fetch(PRIV, { method: 'POST' });
    assert.equal(r.status, 403, 'egress refusal, not a 402 budget denial');
    assert.ok(!h.auditRows.some((a) => a.kind === 'BUDGET_PROVIDER_DENY'));
  } finally { h.done(); }
});

test('collectPrivateAllowedHosts reads models.json flag + auth.json override only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-privhosts-'));
  writeFileSync(join(dir, 'models.json'), JSON.stringify({
    providers: {
      ollama: { baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions', allowPrivateNetwork: true },
      lan: { baseUrl: 'http://192.168.1.20:8080/v1', api: 'openai-completions', allowPrivateNetwork: true },
      other: { baseUrl: 'http://10.1.2.3/v1', api: 'openai-completions' },          // no flag → not allowed
      pub: { baseUrl: 'https://api.example.com/v1', api: 'openai-completions', allowPrivateNetwork: true },
      broken: { baseUrl: 'not a url', allowPrivateNetwork: true },                  // malformed → no host
    },
  }));
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({
    lan: { type: 'api_key', key: 'k', baseUrl: 'http://192.168.1.99:9000/v1' },     // override inherits lan's flag
    other: { type: 'api_key', key: 'k', baseUrl: 'http://10.9.9.9/v1' },            // unflagged provider → ignored
  }));
  const allowed = collectPrivateAllowedHosts(dir);
  assert.ok(allowed.has('127.0.0.1:11434'));
  assert.ok(allowed.has('192.168.1.20:8080'));
  assert.ok(allowed.has('192.168.1.99:9000'), 'auth.baseUrl override inherits the provider flag');
  assert.ok(allowed.has('api.example.com'), 'flagged public host listed (harmless — gate only fires on private hits)');
  assert.ok(!allowed.has('10.1.2.3'), 'unflagged provider never enters the set');
  assert.ok(!allowed.has('10.9.9.9'), 'auth override for unflagged provider ignored');
});

test('collectPrivateAllowedHosts resolves $ENV baseUrl refs; unresolvable stays refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-privhosts-'));
  process.env.PAI_TEST_PRIV_BASE = 'http://172.16.5.5:4000/v1';
  try {
    writeFileSync(join(dir, 'models.json'), JSON.stringify({
      providers: {
        envp: { baseUrl: '$PAI_TEST_PRIV_BASE', api: 'openai-completions', allowPrivateNetwork: true },
        gone: { baseUrl: '$PAI_TEST_NOPE_UNSET', api: 'openai-completions', allowPrivateNetwork: true },
      },
    }));
    const allowed = collectPrivateAllowedHosts(dir);
    assert.ok(allowed.has('172.16.5.5:4000'), 'env-ref resolved to its concrete host');
    assert.equal(allowed.size, 1, 'unset env-ref contributes nothing — fail-closed');
  } finally { delete process.env.PAI_TEST_PRIV_BASE; }
});

// ── dedup-h #1590: provider-declared `host` header reaches the wire ──────────
// undici fetch silently strips `host` (Fetch forbidden-header list). A
// virtual-host-routed OpenAI-compatible gateway needs the declared value on
// the wire, so gated requests carrying one dispatch through node:http(s)
// AFTER the same egress/budget gates — the CONNECT target still comes from
// the URL, the Host header is presentation only.

function realServer() {
  const seen = [];
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ host: req.headers.host, method: req.method, body: Buffer.concat(chunks).toString() });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, port: srv.address().port }));
  });
}

test('declared host header is sent verbatim — virtual-host gateway works', async () => {
  const { srv, seen, port } = await realServer();
  const url = `http://127.0.0.1:${port}/v1/chat`;
  const h = harness({ hosts: [`127.0.0.1:${port}`], privateHosts: new Set([`127.0.0.1:${port}`]) });
  try {
    const r = await globalThis.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'virtual.gateway.local' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].host, 'virtual.gateway.local', 'declared host reached the wire (undici would strip it)');
    assert.equal(seen[0].body, JSON.stringify({ model: 'm', messages: [] }), 'POST body round-trips intact');
  } finally { h.done(); srv.close(); }
});

test('host-declared request still passes egress and budget gates', async () => {
  const { srv, seen, port } = await realServer();
  const url = `http://127.0.0.1:${port}/v1/chat`;
  // no private opt-in → egress refusal precedes the transport entirely
  const denied = harness({ hosts: [`127.0.0.1:${port}`] });
  try {
    const r = await globalThis.fetch(url, { method: 'POST', headers: { host: 'v.gw.local' } });
    assert.equal(r.status, 403);
    assert.equal(seen.length, 0, 'egress refusal never reached the wire');
  } finally { denied.done(); }
  // opted in but over budget → 402, still no wire traffic
  const over = harness({ hosts: [`127.0.0.1:${port}`], privateHosts: new Set([`127.0.0.1:${port}`]), limits: { maxTokensPerSession: 10 } });
  over.budget.record({ scope: 'sess-1', source: 'turn', usage: { input: 20 }, countCall: false });
  try {
    const r = await globalThis.fetch(url, { method: 'POST', headers: { host: 'v.gw.local' } });
    assert.equal(r.status, 402);
    assert.equal(seen.length, 0, 'budget denial never reached the wire');
  } finally { over.done(); srv.close(); }
});

test('requests without a host header keep the undici path (streaming intact)', async () => {
  const h = harness({ limits: { maxCallsPerSession: 1 } });
  try {
    const r = await globalThis.fetch(PROVIDER, { method: 'POST', body: 'x' });
    assert.equal(r.status, 200);
    assert.deepEqual(h.calls, [PROVIDER], 'non-declared request routes through base fetch');
  } finally { h.done(); }
});

// ── dedup-h #1636: same-provider API-key pool, automatic rotation ────────────
// A declared key-pool is authoritative for the provider's bearer. On an
// auth/quota-class response (401/403/429 — after the SDK's same-key retries)
// the gated fetch replays the request with the next key; the cursor is
// process-sticky so dead keys are not retried per call. Bound = pool length.

function keyPoolServer() {
  const seen = [];
  const srv = createServer((req, res) => {
    seen.push(req.headers.authorization ?? null);
    const key = (req.headers.authorization ?? '').replace(/^bearer /i, '');
    res.setHeader('content-type', 'application/json');
    if (key === 'sk-good') res.end(JSON.stringify({ ok: true }));
    else { res.statusCode = 401; res.end(JSON.stringify({ error: 'invalid key' })); }
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, port: srv.address().port }));
  });
}

function poolHarness({ hosts, privateHosts, pool, limits = null, scope = 'sess-1' }) {
  const { budget, auditRows } = makeBudget(limits);
  const realFetch = globalThis.fetch;
  const ungate = installBudgetFetch({
    budget,
    getScope: () => scope,
    getProviderHosts: () => new Set(hosts),
    getPrivateAllowedHosts: () => privateHosts,
    getKeyPool: () => pool,
    audit: { write: (r) => auditRows.push(r) },
  });
  return { budget, auditRows, done: () => { ungate(); globalThis.fetch = realFetch; } };
}

test('401 on primary key rotates to the next pool key — cursor stays rotated', async () => {
  const { srv, seen, port } = await keyPoolServer();
  const host = `127.0.0.1:${port}`;
  const url = `http://${host}/v1/chat`;
  const h = poolHarness({
    hosts: [host], privateHosts: new Set([host]),
    pool: new Map([[host, ['sk-dead', 'sk-good']]]),
  });
  try {
    const r1 = await globalThis.fetch(url, { method: 'POST', headers: { authorization: 'Bearer sk-dead' }, body: 'x' });
    assert.equal(r1.status, 200, 'rotated retry succeeds');
    assert.deepEqual(seen, ['Bearer sk-dead', 'Bearer sk-good'], 'dead key tried once, then rotated');
    // second call starts at the rotated cursor — dead key never re-tried
    const r2 = await globalThis.fetch(url, { method: 'POST', body: 'y' });
    assert.equal(r2.status, 200);
    assert.deepEqual(seen, ['Bearer sk-dead', 'Bearer sk-good', 'Bearer sk-good'],
      'sticky cursor: no Authorization input still gets the live pool key');
    assert.ok(h.auditRows.some((a) => a.kind === 'PROVIDER_KEY_ROTATED' && a.data.keyIndex === 1 && a.data.status === 401));
  } finally { h.done(); srv.close(); }
});

test('pool exhaustion returns the last auth failure honestly — bounded retries', async () => {
  const { srv, seen, port } = await keyPoolServer();
  const host = `127.0.0.1:${port}`;
  const h = poolHarness({
    hosts: [host], privateHosts: new Set([host]),
    pool: new Map([[host, ['sk-dead-1', 'sk-dead-2', 'sk-dead-3']]]),
  });
  try {
    const r = await globalThis.fetch(`http://${host}/v1/chat`, { method: 'POST', body: 'x' });
    assert.equal(r.status, 401, 'last failure surfaces honestly');
    assert.equal(seen.length, 3, 'exactly pool-length attempts — bounded');
    assert.equal(h.auditRows.filter((a) => a.kind === 'PROVIDER_KEY_ROTATED').length, 2);
    assert.ok(h.auditRows.some((a) => a.kind === 'PROVIDER_KEY_POOL_NEAR_EXHAUSTION'));
  } finally { h.done(); srv.close(); }
});

test('non-bearer Authorization is never rewritten; success path untouched', async () => {
  const { srv, seen, port } = await keyPoolServer();
  const host = `127.0.0.1:${port}`;
  const h = poolHarness({
    hosts: [host], privateHosts: new Set([host]),
    pool: new Map([[host, ['sk-good', 'sk-good-2']]]),
  });
  try {
    const r = await globalThis.fetch(`http://${host}/v1/chat`, { method: 'POST', headers: { authorization: 'Basic abc' }, body: 'x' });
    assert.equal(r.status, 401, 'basic auth passes through unrewritten — server sees Basic, rejects honestly');
    assert.deepEqual(seen, ['Basic abc'], 'single attempt, header preserved verbatim');
  } finally { h.done(); srv.close(); }
});

test('collectKeyPool maps provider→host via models.json + auth.json; $ENV resolves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-keypool-'));
  writeFileSync(join(dir, 'models.json'), JSON.stringify({
    providers: { acme: { baseUrl: 'http://203.0.113.8:9000/v1', api: 'openai-completions' } },
  }));
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({
    acme: { type: 'api_key', key: 'k', baseUrl: 'http://203.0.113.9:9000/v1' },
  }));
  writeFileSync(join(dir, 'key-pool.json'), JSON.stringify({
    providers: {
      acme: ['$PAI_TEST_POOL_KEY', 'sk-literal'],
      nopool: ['only-one-key'],
      malformed: 'not-an-array',
    },
  }));
  process.env.PAI_TEST_POOL_KEY = 'sk-env';
  try {
    const pool = collectKeyPool(dir);
    assert.deepEqual(pool.get('203.0.113.8:9000'), ['sk-env', 'sk-literal'], 'models.json host mapped');
    assert.deepEqual(pool.get('203.0.113.9:9000'), ['sk-env', 'sk-literal'], 'auth.json override host mapped');
    assert.equal(pool.size, 2, 'single-key and malformed entries contribute nothing');
  } finally { delete process.env.PAI_TEST_POOL_KEY; }
});

test('no key-pool.json → empty pool → requests untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-keypool-none-'));
  assert.equal(collectKeyPool(dir).size, 0);
  const h = harness({ limits: { maxCallsPerSession: 2 } });
  try {
    const r = await globalThis.fetch(PROVIDER, { method: 'POST', headers: { authorization: 'Bearer x' } });
    assert.equal(r.status, 200);
    assert.deepEqual(h.calls, [PROVIDER]);
  } finally { h.done(); }
});
