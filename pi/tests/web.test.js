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
