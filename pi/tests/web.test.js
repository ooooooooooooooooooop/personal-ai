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
