/**
 * web_fetch / web_search — network tools against a local test server.
 * No external egress in tests: the endpoint is always 127.0.0.1.
 */
import { createServer } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { webFetchTool, webSearchTool } from '../src/adapter/web.js';

function serve(handler) {
  return new Promise((resolve) => {
    const s = createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
  });
}

test('web_fetch refuses non-http protocols and bad URLs', async () => {
  const t = webFetchTool();
  assert.match((await t.execute('c', { url: 'file:///etc/passwd' })).content[0].text, /http\/https/);
  assert.match((await t.execute('c', { url: 'not a url' })).content[0].text, /valid URL/);
});

test('web_fetch enforces the body cap DURING the read — declared and streamed overflow both refused', async () => {
  // declared overflow: content-length alone must refuse before the body streams
  const big1 = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 5 * 1024 * 1024 });
    res.write('x'.repeat(1024)); // only a sliver sent — refusal must not wait for 5MB
    // deliberately never end: if the client waited for the body, it would hang
    setTimeout(() => { try { res.end(); } catch { /* aborted */ } }, 5000);
  });
  try {
    const t = webFetchTool({ timeoutMs: 8000 });
    const r = await t.execute('c', { url: `http://127.0.0.1:${big1.port}/huge` });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /too large/, 'declared length refused pre-read');
  } finally { big1.server.close(); }

  // streamed overflow: no content-length — the cap must cut the stream mid-flight
  const big2 = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' }); // chunked — no length
    const chunk = Buffer.alloc(64 * 1024, 'y');
    let sent = 0;
    const push = () => {
      if (sent >= 2 * 1024 * 1024 || !res.writable) { try { res.end(); } catch { /* gone */ } return; }
      sent += chunk.length;
      res.write(chunk, push);
    };
    push();
  });
  try {
    const t = webFetchTool({ timeoutMs: 8000 });
    const r = await t.execute('c', { url: `http://127.0.0.1:${big2.port}/stream` });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /too large/, 'mid-stream overflow cut at the cap');
  } finally { big2.server.close(); }
});

test('web_fetch strips markup and reports status', async () => {
  const { server, port } = await serve((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<html><style>body{x}</style><body><h1>Hello</h1><script>evil()</script><p>World</p></body></html>');
  });
  try {
    const t = webFetchTool();
    const r = await t.execute('c', { url: `http://127.0.0.1:${port}/page` });
    assert.equal(r.details.status, 200);
    assert.match(r.content[0].text, /Hello/);
    assert.match(r.content[0].text, /World/);
    assert.ok(!r.content[0].text.includes('evil()'));
    assert.ok(!r.content[0].text.includes('<script'));
  } finally {
    server.close();
  }
});

test('web_fetch reports HTTP errors without throwing', async () => {
  const { server, port } = await serve((req, res) => { res.statusCode = 404; res.end('nope'); });
  try {
    const t = webFetchTool();
    const r = await t.execute('c', { url: `http://127.0.0.1:${port}/missing` });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /404/);
  } finally {
    server.close();
  }
});

test('web_fetch truncates over-long bodies and marks it', async () => {
  const { server, port } = await serve((req, res) => res.end('x'.repeat(5000)));
  try {
    const t = webFetchTool();
    const r = await t.execute('c', { url: `http://127.0.0.1:${port}/`, max_chars: 100 });
    assert.equal(r.details.truncated, true);
    assert.match(r.content[0].text, /truncated="100"/);
  } finally {
    server.close();
  }
});

test('web_search posts {q,count} and normalizes result rows', async () => {
  let got = null;
  const { server, port } = await serve((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      got = JSON.parse(body);
      assert.equal(req.headers.authorization, 'Bearer k1');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ results: [{ title: 'T', url: 'https://x', snippet: 'S' }, { title: 'T2', link: 'https://y', description: 'D2' }] }));
    });
  });
  try {
    const t = webSearchTool({ endpoint: `http://127.0.0.1:${port}/search`, apiKey: 'k1' });
    const r = await t.execute('c', { q: 'test query', count: 5 });
    assert.deepEqual(got, { q: 'test query', count: 5 });
    assert.match(r.content[0].text, /1\. T\n +https:\/\/x/);
    assert.match(r.content[0].text, /2\. T2/);
  } finally {
    server.close();
  }
});

test('web_search rejects empty queries and surfaces endpoint failures', async () => {
  const t = webSearchTool({ endpoint: 'http://127.0.0.1:1/unreachable' });
  assert.equal((await t.execute('c', { q: ' ' })).isError, true);
  const r = await t.execute('c', { q: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /failed/);
});

test('egress allowlist: exact/suffix match, redirect host also gated', async () => {
  const { domainAllowed } = await import('../src/adapter/web.js');
  const allow = ['docs.example.com', '.corp.internal'];
  assert.equal(domainAllowed('docs.example.com', allow), true);
  assert.equal(domainAllowed('api.corp.internal', allow), true); // suffix
  assert.equal(domainAllowed('corp.internal', allow), true);    // suffix covers apex
  assert.equal(domainAllowed('evil.com', allow), false);
  assert.equal(domainAllowed('docs.example.com.evil.com', allow), false); // no suffix spoof
  assert.equal(domainAllowed('anything.test', null), true);     // no list = open
  assert.equal(domainAllowed('anything.test', []), true);
});

test('SSRF: link-local/metadata hosts refused even with no allowlist; explicit entry overrides', async () => {
  const { domainAllowed } = await import('../src/adapter/web.js');
  // cloud metadata + link-local always blocked on the unrestricted baseline
  assert.equal(domainAllowed('169.254.169.254', null), false);
  assert.equal(domainAllowed('169.254.1.1', null), false);
  assert.equal(domainAllowed('[fe80::1]', null), false);
  assert.equal(domainAllowed('[::ffff:169.254.169.254]', null), false); // v4-mapped dodge
  assert.equal(domainAllowed('::1', null), false);
  // loopback + RFC1918 stay reachable — local dev servers are a real use
  assert.equal(domainAllowed('localhost', null), true);
  assert.equal(domainAllowed('127.0.0.1', null), true);
  assert.equal(domainAllowed('192.168.1.10', null), true);
  // explicit allowlist still wins for a declared link-local host
  assert.equal(domainAllowed('169.254.169.254', ['169.254.169.254']), true);
});

test('M63: manual redirect following — a forbidden hop is refused BEFORE its server is hit', async () => {
  // Sentinel that proves ordering, not just refusal: stand a REAL forbidden
  // server up on 127.0.0.2 (whole 127/8 is loopback), allowlist only
  // 127.0.0.1 — if the check ran before the request, its hit counter is 0.
  let forbiddenHits = 0;
  let forbiddenSrv = null, forbiddenPort = null;
  await new Promise((resolve) => {
    const s = createServer((req, res) => { forbiddenHits += 1; res.end('nope'); });
    s.once('error', () => resolve()); // 127.0.0.2 unbindable → fall back to unroutable target
    s.listen(0, '127.0.0.2', () => { forbiddenSrv = s; forbiddenPort = s.address().port; resolve(); });
  });
  const { server: redirSrv, port: redirPort } = await serve((req, res) => {
    res.statusCode = 302;
    res.setHeader('location', forbiddenSrv
      ? `http://127.0.0.2:${forbiddenPort}/meta`
      : 'http://169.254.169.254/latest/meta-data');
    res.end();
  });
  try {
    const t = webFetchTool({ egressAllow: () => ['127.0.0.1'] });
    const r = await t.execute('c', { url: `http://127.0.0.1:${redirPort}/go` });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /refused/);
    assert.equal(forbiddenHits, 0, 'forbidden server must never be hit');
    // allowed → allowed redirect still works through the allowlist
    const { server: relSrv, port: relPort } = await serve((req, res) => {
      if (req.url === '/next') { res.end('hop2 ok'); return; }
      res.statusCode = 302; res.setHeader('location', '/next'); res.end();
    });
    try {
      const r2 = await t.execute('c', { url: `http://127.0.0.1:${relPort}/start` });
      assert.match(r2.content[0].text, /hop2 ok/);
    } finally {
      relSrv.close();
    }
  } finally {
    redirSrv.close(); forbiddenSrv?.close();
  }
});

test('M66: DNS resolution is validated — IPv6 literals normalized, forbidden addresses refused', async () => {
  const { resolveChecked, isForbiddenAddress } = await import('../src/adapter/web.js');
  // R1 regression: URL.hostname keeps [] on IPv6 literals — they must be
  // stripped before isIP(), else legit public v6 falls into a failing lookup
  const pub = await resolveChecked('[2001:db8::1]', null);
  assert.equal(pub.ok, true, 'public IPv6 literal must not be refused');
  for (const h of ['[::1]', '[fe80::1]', '::ffff:169.254.169.254', '[::ffff:169.254.169.254]']) {
    const r = await resolveChecked(h, null);
    assert.equal(r.ok, false, `${h} must be refused`);
  }
  // R2 CIDR completeness — fe80::/10 is fe80–febf, ULA fc00::/7 is fc AND fd
  for (const bad of ['fe80::1', 'fe90::1', 'fea0::1', 'feb0::1', 'fc00::1', 'fd12::1', '::1',
                     '169.254.169.254', '0:0:0:0:0:0:0:1', '::', '0::1', '00::0001',
                     '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:169.254.169.254']) {
    assert.equal(isForbiddenAddress(bad), true, bad);
  }
  for (const ok of ['2001:db8::1', 'fec0::1', '8.8.8.8', 'example.com']) {
    assert.equal(isForbiddenAddress(ok), false, ok);
  }
  // end-to-end: literal forbidden IP is refused by the tool itself
  const t = webFetchTool();
  const r = await t.execute('c', { url: 'http://169.254.169.254/' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /refused/);
});

test('M66 checkResolvedHost: reviewer sentinels — allowlist/local/private ordering', async () => {
  const { checkResolvedHost } = await import('../src/adapter/web.js');
  // allowlisted name trusts its own resolution — resolved IPs are NOT
  // re-matched against the name allowlist (regression: docs.example.com→8.8.8.8
  // used to be refused because the IP didn't match the domain entry)
  assert.equal(checkResolvedHost('docs.example.com', [{ address: '8.8.8.8' }], ['docs.example.com']).ok, true);
  // non-allowlisted name under an allowlist policy is refused at the name level
  assert.equal(checkResolvedHost('other.example', [{ address: '8.8.8.8' }], ['docs.example.com']).ok, false);
  // private pivot without allowlist
  assert.equal(checkResolvedHost('evil.example', [{ address: '127.0.0.1' }], null).ok, false);
  assert.equal(checkResolvedHost('evil.example', [{ address: '10.0.0.1' }], null).ok, false);
  // localhost intent passes resolved checks (regression: ::1 was refused
  // by the per-address baseline before the local-intent branch ran)
  assert.equal(checkResolvedHost('localhost', [{ address: '::1' }], null).ok, true);
  assert.equal(checkResolvedHost('x.localhost', [{ address: '127.0.0.1' }], null).ok, true);
  // public name → public IP passes
  assert.equal(checkResolvedHost('ok.example', [{ address: '8.8.8.8' }], null).ok, true);
  // allowlisted name resolving to private space is operator-trusted
  assert.equal(checkResolvedHost('internal.example', [{ address: '10.0.0.1' }], ['internal.example']).ok, true);
  // literal IP path unchanged
  assert.equal(checkResolvedHost('169.254.169.254', [], null).ok, false);
  assert.equal(checkResolvedHost('8.8.8.8', [], null).ok, true);
});

test('M133: >15K body routes to the summarizer; absent/failed summarizer falls back to honest truncation', async () => {
  const big = 'data '.repeat(5000); // 25k chars
  const { server, port } = await serve((req, res) => {
    res.setHeader('content-type', 'text/plain');
    res.end(big);
  });
  try {
    // summarizer wired → summary returned, honestly flagged
    const seen = [];
    const t = webFetchTool({ summarize: async (text, url) => { seen.push([text.length, url]); return 'SUMMARY: page lists data rows'; } });
    const r = await t.execute('c', { url: `http://127.0.0.1:${port}/big` });
    assert.equal(r.details.summarized, true);
    assert.equal(r.details.sourceChars, big.length);
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], Math.min(big.length, 60_000), 'summarizer input bounded');
    assert.match(r.content[0].text, /summarized="true"/);
    assert.match(r.content[0].text, /SUMMARY: page lists data rows/);

    // summarizer that fails → honest truncation, no fake summary
    const t2 = webFetchTool({ summarize: async () => { throw new Error('provider down'); } });
    const r2 = await t2.execute('c', { url: `http://127.0.0.1:${port}/big` });
    assert.equal(r2.details.summarized, undefined);
    assert.equal(r2.details.truncated, true);
    assert.match(r2.content[0].text, /truncated="/);

    // no summarizer → same honest truncation
    const t3 = webFetchTool();
    const r3 = await t3.execute('c', { url: `http://127.0.0.1:${port}/big` });
    assert.equal(r3.details.summarized, undefined);
    assert.equal(r3.details.truncated, true);
  } finally {
    server.close();
  }
});

// dedup-h #1815 — inline session network policy: a non-allowlisted host asks
// the operator instead of flat-refusing; allow_session grants, deny latches.
test('#1815: allow_session grants the host for the session (one ask)', async () => {
  const { server, port } = await serve((req, res) => res.end('granted page'));
  try {
    const grants = new Set();
    const denies = new Set();
    let askCount = 0;
    const t = webFetchTool({
      egressAllow: () => ['10.255.255.1'], // allowlist in force, localhost not on it
      askEgress: async (host) => { askCount += 1; assert.equal(host, 'localhost'); return 'allow_session'; },
      sessionGrants: grants,
      sessionDenies: denies,
    });
    const r = await t.execute('c', { url: `http://localhost:${port}/` });
    assert.equal(r.isError, undefined);
    assert.match(r.content[0].text, /granted page/);
    assert.ok(grants.has('localhost'), 'host joined sessionGrants');
    const r2 = await t.execute('c', { url: `http://localhost:${port}/` });
    assert.equal(r2.isError, undefined);
    assert.equal(askCount, 1, 'session grant must not re-ask');
  } finally {
    server.close();
  }
});

test('#1815: allow once admits only this call — next hop re-asks', async () => {
  const { server, port } = await serve((req, res) => res.end('once page'));
  try {
    const grants = new Set();
    let askCount = 0;
    const t = webFetchTool({
      egressAllow: () => ['10.255.255.1'],
      askEgress: async () => { askCount += 1; return 'allow'; },
      sessionGrants: grants,
      sessionDenies: new Set(),
    });
    const r = await t.execute('c', { url: `http://localhost:${port}/` });
    assert.equal(r.isError, undefined);
    assert.equal(grants.size, 0, 'allow once must not join sessionGrants');
    await t.execute('c', { url: `http://localhost:${port}/` });
    assert.equal(askCount, 2, 'each call re-asks under allow-once');
  } finally {
    server.close();
  }
});

test('#1815: deny latches the host for the session — no re-ask', async () => {
  const { server, port } = await serve((req, res) => res.end('denied page'));
  try {
    const grants = new Set();
    const denies = new Set();
    let askCount = 0;
    const t = webFetchTool({
      egressAllow: () => ['10.255.255.1'],
      askEgress: async () => { askCount += 1; return 'deny'; },
      sessionGrants: grants,
      sessionDenies: denies,
    });
    const r = await t.execute('c', { url: `http://localhost:${port}/` });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /not on the operator egress allowlist/);
    assert.ok(denies.has('localhost'), 'deny latches sessionDenies');
    const r2 = await t.execute('c', { url: `http://localhost:${port}/` });
    assert.equal(r2.isError, true);
    assert.match(r2.content[0].text, /denied for this session/);
    assert.equal(askCount, 1, 'session deny must refuse without re-asking');
    assert.equal(grants.size, 0);
  } finally {
    server.close();
  }
});

test('#1815: forbidden literals and unrestricted baseline never reach the ask', async () => {
  let askCount = 0;
  const grants = new Set();
  const t = webFetchTool({
    egressAllow: () => ['127.0.0.1'],
    askEgress: async () => { askCount += 1; return 'allow_session'; },
    sessionGrants: grants,
    sessionDenies: new Set(),
  });
  // link-local/metadata literal → flat refuse, the ask must never fire
  const r = await t.execute('c', { url: 'http://169.254.169.254/latest/meta-data' });
  assert.equal(r.isError, true);
  assert.equal(askCount, 0, 'forbidden literal bypasses the ask path');
  assert.equal(grants.size, 0);
  // unrestricted baseline (no allowlist file) → no ask either
  let askCount2 = 0;
  const { server, port } = await serve((req, res) => res.end('open'));
  try {
    const t2 = webFetchTool({
      egressAllow: () => null,
      askEgress: async () => { askCount2 += 1; return 'deny'; },
      sessionGrants: new Set(),
      sessionDenies: new Set(),
    });
    const r2 = await t2.execute('c', { url: `http://localhost:${port}/` });
    assert.equal(r2.isError, undefined);
    assert.equal(askCount2, 0, 'unrestricted baseline never asks');
  } finally {
    server.close();
  }
});
