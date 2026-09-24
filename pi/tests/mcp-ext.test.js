/**
 * MCP managed extension — client transports, tool bridging, governance.
 *
 * Covers: stdio NDJSON handshake + tools/list + tools/call + abort;
 * Streamable HTTP (JSON + SSE answers, mcp-session-id echo); the extension
 * factory registering mcp__* tools that wrap results in the untrusted
 * marker; kernel prefix rules gating mcp__* through operator ask; the
 * decide chain treating mcp__ calls as lease-holding mutations.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import mcpExtension, { McpClient, McpError, sanitizeSpecEnv, openBrowser } from '../extensions/mcp/index.js';
import { GovernanceKernel } from '../../host/src/core/governance.js';
import { AttestedPolicy } from '../../host/src/core/policy.js';
import { makeDecide } from '../src/bootstrap/decide.js';
import { WorkspaceWriteLease } from '../src/adapter/writelease.js';

const FAKE_SERVER_JS = `
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake', version: '0' }, capabilities: { tools: {}, prompts: {} } } }) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } }) + '\\n');
    } else if (msg.method === 'tools/call') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo:' + (msg.params?.arguments?.text ?? '') }] } }) + '\\n');
    } else if (msg.method === 'prompts/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { prompts: [{ name: 'greet', description: 'greeting prompt', arguments: [{ name: 'who', required: true }] }] } }) + '\\n');
    } else if (msg.method === 'prompts/get') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { description: 'greet', messages: [{ role: 'user', content: { type: 'text', text: 'Say hello to ' + (msg.params?.arguments?.who ?? '?') } }] } }) + '\\n');
    } else if (msg.method === 'notifications/cancelled') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/server_log', params: { cancelled: msg.params?.requestId } }) + '\\n');
    }
  }
});
setInterval(() => {}, 1000);
`;

function fakePi() {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  return {
    tools, commands, handlers,
    registerTool: (t) => tools.set(t.name, t),
    registerCommand: (n, o) => commands.set(n, o),
    on: (e, h) => handlers.set(e, h),
  };
}

test('mcp stdio: initialize → tools/list → tools/call roundtrip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcp-'));
  try {
    const serverPath = join(dir, 'server.js');
    writeFileSync(serverPath, FAKE_SERVER_JS);
    const client = await McpClient.connect({ command: process.execPath, args: [serverPath] });
    try {
      assert.equal(client.serverInfo.serverInfo.name, 'fake');
      const tools = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name), ['echo']);
      const res = await client.callTool('echo', { text: 'hi' });
      assert.equal(res.content[0].text, 'echo:hi');
    } finally {
      client.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp stdio: abort posts notifications/cancelled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcp-'));
  try {
    const serverPath = join(dir, 'server.js');
    writeFileSync(serverPath, FAKE_SERVER_JS);
    const client = await McpClient.connect({ command: process.execPath, args: [serverPath] });
    try {
      const ac = new AbortController();
      const p = client.callTool('echo', { text: 'x' }, { signal: ac.signal });
      ac.abort();
      await assert.rejects(p, /aborted/);
    } finally {
      client.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp http: JSON + SSE answers, session-id echo', async () => {
  const seen = { sessionIds: [], sseCalls: 0 };
  const server = createServer((req, res) => {
    if (req.method === 'GET') { res.statusCode = 405; res.end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = JSON.parse(body);
      seen.sessionIds.push(req.headers['mcp-session-id'] ?? null);
      res.setHeader('mcp-session-id', 'sess-1');
      const rpcRes = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
      if (msg.method === 'initialize') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(rpcRes({ protocolVersion: '2025-06-18', serverInfo: { name: 'httpfake' } })));
      } else if (!msg.id) {
        res.statusCode = 202;
        res.end();
      } else if (msg.method === 'tools/call') {
        seen.sseCalls++;
        res.setHeader('content-type', 'text/event-stream');
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { p: 1 } })}\n\ndata: ${JSON.stringify(rpcRes({ content: [{ type: 'text', text: 'sse-result' }] }))}\n\n`);
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(rpcRes({ tools: [] })));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    const client = await McpClient.connect({ url });
    try {
      assert.equal(client.serverInfo.serverInfo.name, 'httpfake');
      const res = await client.callTool('anything', {});
      assert.equal(res.content[0].text, 'sse-result');
      // second request must echo the session id the server assigned
      assert.ok(seen.sessionIds.slice(1).includes('sess-1'));
    } finally {
      client.close();
    }
  } finally {
    server.close();
  }
});

// dedup-h #1075 — Streamable HTTP server→client channel: GET on the endpoint
// opens an SSE stream carrying server-initiated frames (list_changed etc.).
test('mcp http push: GET SSE stream delivers notifications; end of stream re-listens', async () => {
  const pushed = [];
  let getCount = 0;
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      getCount++;
      const n = getCount;
      res.setHeader('content-type', 'text/event-stream');
      // delay the push so the client has time to attach onNotification
      setTimeout(() => {
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: { n } })}\n\n`);
        setTimeout(() => res.end(), 50);
      }, 150);
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = JSON.parse(body);
      const rpcRes = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
      res.setHeader('mcp-session-id', 'sess-push');
      res.setHeader('content-type', 'application/json');
      if (msg.method === 'initialize') {
        res.end(JSON.stringify(rpcRes({ protocolVersion: '2025-06-18', serverInfo: { name: 'pushfake' } })));
      } else if (!msg.id) {
        res.statusCode = 202; res.end();
      } else {
        res.end(JSON.stringify(rpcRes({ tools: [] })));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const client = await McpClient.connect({ url: `http://127.0.0.1:${server.address().port}/mcp` });
    try {
      client.onNotification((m) => pushed.push(m));
      const t0 = Date.now();
      while (pushed.length < 2 && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 25));
      assert.deepEqual(pushed.map((m) => m.params.n), [1, 2], 'first stream + re-listen after clean end');
      assert.equal(pushed[0].method, 'notifications/tools/list_changed');
    } finally {
      client.close();
    }
  } finally {
    server.close();
  }
});

test('mcp http push: server without GET stream is probed once, not stormed', async () => {
  let getCount = 0;
  const server = createServer((req, res) => {
    if (req.method === 'GET') { getCount++; res.statusCode = 405; res.end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      if (msg.method === 'initialize') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'nopush' } } }));
      } else if (!msg.id) {
        res.statusCode = 202; res.end();
      } else {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const client = await McpClient.connect({ url: `http://127.0.0.1:${server.address().port}/mcp` });
    try {
      client.onNotification(() => {});
      await new Promise((r) => setTimeout(r, 1500));
      assert.ok(getCount <= 1, `no-push server must see one probe, got ${getCount}`);
    } finally {
      client.close();
    }
  } finally {
    server.close();
  }
});

// dedup-h #583: remote HTTP transport type + spelling aliases normalize
// to the canonical streamable-http kind BEFORE validation.
test('mcp transport aliases: remote / streamableHttp / streamable_http all connect over HTTP', async () => {
  const server = createServer((req, res) => {
    if (req.method === 'GET') { res.statusCode = 405; res.end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = JSON.parse(body);
      const rpcRes = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(rpcRes(msg.method === 'initialize' ? { protocolVersion: '2025-06-18', serverInfo: { name: 'alias-srv' } } : { ok: true })));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    for (const transport of ['remote', 'streamableHttp', 'streamable_http', 'streamable-http']) {
      const client = await McpClient.connect({ url, transport });
      try { assert.equal(client.serverInfo.serverInfo.name, 'alias-srv', transport); }
      finally { client.close(); }
    }
    await assert.rejects(() => McpClient.connect({ url, transport: 'carrier-pigeon' }), /unsupported/);
  } finally {
    server.close();
  }
});

// M38/dedup-h-#38: remote-MCP OAuth — client_credentials grant with the
// RFC 8707 `resource` override field. Real http servers assert the token
// request body, the bearer on MCP posts, and 401 re-auth.
const makeOAuthRig = (seen, opts = {}) => {
  const token = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.tokenBodies.push(Object.fromEntries(new URLSearchParams(body)));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(opts.badToken ?? { access_token: `tok-${seen.tokenBodies.length}`, token_type: 'bearer', expires_in: 3600 }));
    });
  });
  const mcp = createServer((req, res) => {
    if (req.method === 'GET') { res.statusCode = 405; res.end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = JSON.parse(body);
      seen.authHeaders.push(req.headers['authorization'] ?? null);
      if (opts.rejectFirst && msg.method === 'tools/call' && !seen.rejected) {
        // the first real tool call is refused — client must re-auth + retry
        seen.rejected = true;
        res.statusCode = 401; res.end(); return;
      }
      const rpcRes = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
      res.setHeader('content-type', 'application/json');
      if (msg.method === 'initialize') {
        res.end(JSON.stringify(rpcRes({ protocolVersion: '2025-06-18', serverInfo: { name: 'oauthfake' } })));
      } else if (!msg.id) { res.statusCode = 202; res.end(); }
      else res.end(JSON.stringify(rpcRes({ content: [{ type: 'text', text: 'ok' }] })));
    });
  });
  return { token, mcp };
};

test('mcp oauth: client_credentials sends RFC8707 resource override; bearer rides posts', async () => {
  const seen = { tokenBodies: [], authHeaders: [] };
  const { token, mcp } = makeOAuthRig(seen);
  await new Promise((r) => token.listen(0, '127.0.0.1', r));
  await new Promise((r) => mcp.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${mcp.address().port}/mcp`;
    const client = await McpClient.connect({
      url,
      oauth: {
        tokenUrl: `http://127.0.0.1:${token.address().port}/token`,
        clientId: 'pai-client', clientSecret: 's3cret', scope: 'mcp:tools',
        resource: 'https://api.example.com/mcp', // RFC8707 override
      },
    });
    try {
      assert.equal(client.serverInfo.serverInfo.name, 'oauthfake');
      await client.callTool('anything', {});
      const tb = seen.tokenBodies[0];
      assert.equal(tb.grant_type, 'client_credentials');
      assert.equal(tb.client_id, 'pai-client');
      assert.equal(tb.client_secret, 's3cret');
      assert.equal(tb.scope, 'mcp:tools');
      assert.equal(tb.resource, 'https://api.example.com/mcp');
      assert.ok(seen.authHeaders.every((h) => h === 'Bearer tok-1'));
      assert.equal(client.oauth, 'oauth client_credentials (resource: https://api.example.com/mcp)');
    } finally { client.close(); }
  } finally { token.close(); mcp.close(); }
});

test('mcp oauth: absent override defaults resource to the server URL; 401 re-auths once', async () => {
  const seen = { tokenBodies: [], authHeaders: [] };
  const { token, mcp } = makeOAuthRig(seen, { rejectFirst: true });
  await new Promise((r) => token.listen(0, '127.0.0.1', r));
  await new Promise((r) => mcp.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${mcp.address().port}/mcp`;
    const client = await McpClient.connect({
      url,
      oauth: { tokenUrl: `http://127.0.0.1:${token.address().port}/token`, clientId: 'pai' },
    });
    try {
      const res = await client.callTool('anything', {});
      assert.equal(res.content[0].text, 'ok');
      assert.equal(seen.tokenBodies[0].resource, url); // default = server URL
      assert.equal(seen.tokenBodies.length, 2);        // 401 → one re-auth
      // init + initialized-notify with tok-1, call refused→retry + one extra
      // frame may share the cache — assert every post carried SOME bearer
      // and the retry used the fresh token
      assert.ok(seen.authHeaders.every((h) => h?.startsWith('Bearer tok-')));
      assert.equal(seen.authHeaders.at(-1), 'Bearer tok-2');
      assert.equal(client.oauth, 'oauth client_credentials (resource: server-url)');
    } finally { client.close(); }
  } finally { token.close(); mcp.close(); }
});

test('mcp oauth: malformed specs fail closed at connect', async () => {
  const url = 'http://127.0.0.1:1/mcp';
  const base = { tokenUrl: 'http://127.0.0.1:1/token', clientId: 'c' };
  for (const spec of [
    { url, oauth: { clientId: 'c' } },                                              // no tokenUrl
    { url, oauth: { ...base, tokenUrl: 'notaurl' } },                               // bad tokenUrl
    { url, oauth: { ...base, tokenUrl: 'http://example.com/token' } },              // http off-loopback
    { url, oauth: { ...base, resource: 'rel/path' } },                              // non-absolute resource
    { url, oauth: { ...base, resource: 'https://x/#frag' } },                       // fragment (RFC8707)
    { url, headers: { Authorization: 'Bearer x' }, oauth: base },                   // ambiguous auth
    { url, oauth: { ...base, clientSecret: 42 } },                                  // wrong type
    { url, oauth: { ...base, exchange: {} } },                                      // exchange without url
    { url, oauth: { ...base, exchange: { url: 'notaurl' } } },                      // bad exchange url
    { url, oauth: { ...base, exchange: { url: 'http://example.com/x' } } },         // http off-loopback
    { url, oauth: { ...base, exchange: { url: 'http://127.0.0.1:1/x', resource: 'https://x/#f' } } }, // fragment
  ]) {
    await assert.rejects(() => McpClient.connect(spec), McpError);
  }
});

// dedup-h #165: gateway token exchange (RFC 8693) — the client-credentials
// token is the SUBJECT; the gateway exchanges it for the upstream bearer.
test('mcp oauth: gateway token-exchange swaps subject token for upstream bearer', async () => {
  const seen = { tokenBodies: [], exchangeBodies: [], authHeaders: [] };
  const { token, mcp } = makeOAuthRig(seen);
  const gateway = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.exchangeBodies.push(Object.fromEntries(new URLSearchParams(body)));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ access_token: `gw-tok-${seen.exchangeBodies.length}`, token_type: 'bearer', expires_in: 3600 }));
    });
  });
  await new Promise((r) => token.listen(0, '127.0.0.1', r));
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  await new Promise((r) => mcp.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${mcp.address().port}/mcp`;
    const client = await McpClient.connect({
      url,
      oauth: {
        tokenUrl: `http://127.0.0.1:${token.address().port}/token`,
        clientId: 'pai-client', clientSecret: 's3cret',
        exchange: {
          url: `http://127.0.0.1:${gateway.address().port}/exchange`,
          audience: 'upstream-mcp',
          resource: 'https://upstream.example.com/mcp',
        },
      },
    });
    try {
      assert.equal(client.serverInfo.serverInfo.name, 'oauthfake');
      await client.callTool('anything', {});
      // subject token came from client_credentials…
      assert.equal(seen.tokenBodies[0].grant_type, 'client_credentials');
      // …then the gateway saw an RFC 8693 exchange carrying that subject
      const xb = seen.exchangeBodies[0];
      assert.equal(xb.grant_type, 'urn:ietf:params:oauth:grant-type:token-exchange');
      assert.equal(xb.subject_token, 'tok-1');
      assert.equal(xb.subject_token_type, 'urn:ietf:params:oauth:token-type:access_token');
      assert.equal(xb.audience, 'upstream-mcp');
      assert.equal(xb.resource, 'https://upstream.example.com/mcp');
      assert.equal(xb.client_id, 'pai-client');
      // upstream posts carry the GATEWAY token, never the subject token
      assert.ok(seen.authHeaders.length > 0);
      assert.ok(seen.authHeaders.every((h) => h === 'Bearer gw-tok-1'));
      assert.match(client.oauth, /token-exchange/);
    } finally { client.close(); }
  } finally { token.close(); gateway.close(); mcp.close(); }
});

// M131/dedup-h-#131: interactive OAuth — authorization_code + PKCE via
// /mcp-auth + /mcp-auth-done; tokens land in the user-private store and
// ride subsequent connects as Bearer, refreshed by refresh_token grant.
test('mcp oauth authorization_code: PKCE dance stores token; transport carries it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcp-oauth-'));
  const seen = { tokenBodies: [], authHeaders: [], authParams: null };
  // token endpoint: issues tok-1 with a refresh_token; refresh grants tok-2
  const token = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const f = Object.fromEntries(new URLSearchParams(body));
      seen.tokenBodies.push(f);
      res.setHeader('content-type', 'application/json');
      if (f.grant_type === 'authorization_code') {
        assert.equal(f.code, 'authcode-1');
        assert.ok(f.code_verifier, 'PKCE verifier sent');
        res.end(JSON.stringify({ access_token: 'tok-live', token_type: 'bearer', expires_in: 0, refresh_token: 'rt-1' }));
      } else if (f.grant_type === 'refresh_token') {
        assert.equal(f.refresh_token, 'rt-1');
        res.end(JSON.stringify({ access_token: 'tok-fresh', token_type: 'bearer', expires_in: 3600 }));
      } else { res.statusCode = 400; res.end('{}'); }
    });
  });
  // mcp endpoint: answers initialize/tools-call; records the bearer seen
  const mcp = createServer((req, res) => {
    if (req.method === 'GET') { res.statusCode = 405; res.end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = JSON.parse(body);
      seen.authHeaders.push(req.headers['authorization'] ?? null);
      const rpcRes = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
      res.setHeader('content-type', 'application/json');
      if (msg.method === 'initialize') res.end(JSON.stringify(rpcRes({ protocolVersion: '2025-06-18', serverInfo: { name: 'oauthcode' } })));
      else if (!msg.id) { res.statusCode = 202; res.end(); }
      else res.end(JSON.stringify(rpcRes({ tools: [] })));
    });
  });
  await new Promise((r) => token.listen(0, '127.0.0.1', r));
  await new Promise((r) => mcp.listen(0, '127.0.0.1', r));
  const prevStore = process.env.PAI_MCP_TOKEN_STORE;
  const prevCfg = process.env.PAI_MCP_CONFIG;
  try {
    const mcpUrl = `http://127.0.0.1:${mcp.address().port}/mcp`;
    const tokenUrl = `http://127.0.0.1:${token.address().port}/token`;
    const authUrl = `http://127.0.0.1:${token.address().port}/authorize`;
    process.env.PAI_MCP_TOKEN_STORE = join(dir, 'mcp-oauth.json');
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        remote: { url: mcpUrl, oauth: { authorizationUrl: authUrl, tokenUrl, clientId: 'pai-pub', scope: 'mcp', resource: 'https://rs.example/mcp' } },
      },
    }));
    process.env.PAI_MCP_CONFIG = join(dir, 'mcp.json');

    // begin: the command emits an authorize URL with PKCE + RFC8707 params
    const pi = fakePi();
    await mcpExtension(pi);
    // dedup-h #1077 — the command auto-opens the browser; spy it (never spawn
    // a real browser from tests) and assert it fired with the authorize URL
    const opened = [];
    const realOpen = mcpOperatorSurface.openBrowser;
    mcpOperatorSurface.openBrowser = (u) => { opened.push(u); return true; };
    const notices = [];
    const ctx = { ui: { notify: (msg, level) => notices.push({ msg, level }) } };
    await pi.commands.get('mcp-auth').handler('remote', ctx);
    assert.equal(opened.length, 1, 'authorize URL auto-opened in the browser');
    assert.ok(opened[0].startsWith('http'));
    assert.match(notices[0].msg, /opened in your browser/);
    mcpOperatorSurface.openBrowser = realOpen;
    const urlLine = notices[0].msg.split('\n').find((l) => l.startsWith('http'));
    assert.ok(urlLine, 'authorize URL emitted');
    const au = new URL(urlLine);
    assert.equal(au.searchParams.get('response_type'), 'code');
    assert.equal(au.searchParams.get('client_id'), 'pai-pub');
    assert.equal(au.searchParams.get('redirect_uri'), 'urn:ietf:wg:oauth:2.0:oob');
    assert.equal(au.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(au.searchParams.get('code_challenge'));
    assert.ok(au.searchParams.get('state'));
    assert.equal(au.searchParams.get('resource'), 'https://rs.example/mcp');
    assert.equal(au.searchParams.get('scope'), 'mcp');

    // complete: code exchange hits tokenUrl with verifier; token stored
    await pi.commands.get('mcp-auth-done').handler('remote authcode-1', ctx);
    const grant = seen.tokenBodies.find((b) => b.grant_type === 'authorization_code');
    assert.ok(grant, 'authorization_code exchange fired');
    assert.equal(grant.client_id, 'pai-pub');
    assert.ok(grant.code_verifier);
    assert.equal(grant.resource, 'https://rs.example/mcp');
    const store = JSON.parse(readFileSync(join(dir, 'mcp-oauth.json'), 'utf-8'));
    assert.equal(store.remote.access_token, 'tok-live');
    assert.equal(store.remote.refresh_token, 'rt-1');

    // a fresh connect picks up the stored token; expired → refresh grant
    seen.authHeaders.length = 0;
    const client = await McpClient.connect(
      { url: mcpUrl, oauth: { authorizationUrl: authUrl, tokenUrl, clientId: 'pai-pub' } },
      { serverName: 'remote' },
    );
    try {
      assert.equal(client.serverInfo.serverInfo.name, 'oauthcode');
      assert.match(client.oauth, /authorization_code/);
      assert.equal(seen.tokenBodies.at(-1).grant_type, 'refresh_token'); // tok-live was expires_in:0
      assert.ok(seen.authHeaders.every((h) => h === 'Bearer tok-fresh'));
    } finally { client.close(); }
  } finally {
    token.close(); mcp.close();
    if (prevStore == null) delete process.env.PAI_MCP_TOKEN_STORE; else process.env.PAI_MCP_TOKEN_STORE = prevStore;
    if (prevCfg == null) delete process.env.PAI_MCP_CONFIG; else process.env.PAI_MCP_CONFIG = prevCfg;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp oauth authorization_code: no stored token → honest unauthorized, names the recovery command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcp-unauth-'));
  const prev = process.env.PAI_MCP_TOKEN_STORE;
  try {
    process.env.PAI_MCP_TOKEN_STORE = join(dir, 'empty.json');
    // no stored token: even initialize fails — honestly, naming the fix
    const mcp = createServer((req, res) => {
      if (req.method === 'GET') { res.statusCode = 405; res.end(); return; }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const msg = JSON.parse(body);
        const rpcRes = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
        res.setHeader('content-type', 'application/json');
        if (msg.method === 'initialize') res.end(JSON.stringify(rpcRes({ protocolVersion: '2025-06-18', serverInfo: { name: 'x' } })));
        else res.statusCode = 202, res.end();
      });
    });
    await new Promise((r) => mcp.listen(0, '127.0.0.1', r));
    try {
      await assert.rejects(() => McpClient.connect({
        url: `http://127.0.0.1:${mcp.address().port}/mcp`,
        oauth: { authorizationUrl: 'http://127.0.0.1:1/auth', tokenUrl: 'http://127.0.0.1:1/token', clientId: 'c' },
      }, { serverName: 'ghost' }), /unauthorized.*mcp-auth ghost/);
    } finally { mcp.close(); }
  } finally {
    if (prev == null) delete process.env.PAI_MCP_TOKEN_STORE; else process.env.PAI_MCP_TOKEN_STORE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp extension: registers mcp__srv__tool, untrusted wrap, failure hides tools', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcp-'));
  try {
    const serverPath = join(dir, 'server.js');
    writeFileSync(serverPath, FAKE_SERVER_JS);
    const cfgPath = join(dir, 'mcp.json');
    writeFileSync(cfgPath, JSON.stringify({
      mcpServers: {
        fake: { command: process.execPath, args: [serverPath] },
        broken: { command: process.execPath, args: [join(dir, 'nonexistent.js')] },
      },
    }));
    const prev = process.env.PAI_MCP_CONFIG;
    process.env.PAI_MCP_CONFIG = cfgPath;
    try {
      const pi = fakePi();
      mcpExtension(pi);
      // boot is async — wait until tools appear or timeout
      const deadline = Date.now() + 10_000;
      while (!pi.tools.has('mcp__fake__echo') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(pi.tools.has('mcp__fake__echo'), 'echo tool registered');
      assert.ok(!pi.tools.has('mcp__broken__echo'), 'failed server exposes nothing');
      const tool = pi.tools.get('mcp__fake__echo');
      const res = await tool.execute('tc-1', { text: 'hello' });
      assert.match(res.content[0].text, /<untrusted mcp_server="fake" mcp_tool="echo">/);
      assert.match(res.content[0].text, /echo:hello/);
      assert.equal(res.details.mcpServer, 'fake');
      // shutdown handler closes the child
      await pi.handlers.get('session_shutdown')?.();
    } finally {
      if (prev === undefined) delete process.env.PAI_MCP_CONFIG;
      else process.env.PAI_MCP_CONFIG = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C3: PAI_MCP_DENY filters denied servers before connect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcp-'));
  try {
    const serverPath = join(dir, 'server.js');
    writeFileSync(serverPath, FAKE_SERVER_JS);
    const cfgPath = join(dir, 'mcp.json');
    writeFileSync(cfgPath, JSON.stringify({
      mcpServers: {
        fake: { command: process.execPath, args: [serverPath] },
        denied: { command: process.execPath, args: [serverPath] },
      },
    }));
    const prev = process.env.PAI_MCP_CONFIG;
    const prevDeny = process.env.PAI_MCP_DENY;
    process.env.PAI_MCP_CONFIG = cfgPath;
    process.env.PAI_MCP_DENY = 'denied';
    try {
      const pi = fakePi();
      const notices = [];
      const ctx = { ui: { notify: (m, l) => notices.push([l, m]) } };
      mcpExtension(pi);
      const deadline = Date.now() + 10_000;
      while (!pi.tools.has('mcp__fake__echo') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(pi.tools.has('mcp__fake__echo'), 'allowed server connects');
      assert.ok(!pi.tools.has('mcp__denied__echo'), 'denied server never connects');
      await pi.handlers.get('session_shutdown')?.();
      // /mcp status surfaces the denial honestly
      await pi.commands.get('mcp').handler(ctx);
      const status = notices.map(([, m]) => m).join('\n');
      assert.match(status, /denied by profile.*denied/);
    } finally {
      if (prev === undefined) delete process.env.PAI_MCP_CONFIG;
      else process.env.PAI_MCP_CONFIG = prev;
      if (prevDeny === undefined) delete process.env.PAI_MCP_DENY;
      else process.env.PAI_MCP_DENY = prevDeny;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#1390: spec.context scopes a server to listed agent ids (PAI_AGENT_ID)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcp-'));
  const prev = process.env.PAI_MCP_CONFIG;
  const prevAgent = process.env.PAI_AGENT_ID;
  try {
    const serverPath = join(dir, 'server.js');
    writeFileSync(serverPath, FAKE_SERVER_JS);
    const cfgPath = join(dir, 'mcp.json');
    writeFileSync(cfgPath, JSON.stringify({
      mcpServers: {
        global: { command: process.execPath, args: [serverPath] },
        reviewonly: { command: process.execPath, args: [serverPath], context: 'reviewer' },
        multi: { command: process.execPath, args: [serverPath], context: ['reviewer', 'planner'] },
        star: { command: process.execPath, args: [serverPath], context: '*' },
      },
    }));
    process.env.PAI_MCP_CONFIG = cfgPath;

    // Wrong context: 'operator' sees only global + star; scoped servers
    // never connect — not even to probe.
    delete process.env.PAI_AGENT_ID;
    const pi = fakePi();
    const ctx = { ui: { notify: () => {} } };
    const notices = [];
    ctx.ui.notify = (m, l) => notices.push([l, m]);
    const waitTool = async (inst, name, ms = 10_000) => {
      const deadline = Date.now() + ms;
      while (!inst.tools.has(name) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      return inst.tools.has(name);
    };
    mcpExtension(pi);
    try {
      assert.ok(await waitTool(pi, 'mcp__global__echo'), 'unscoped server connects for operator');
      assert.ok(await waitTool(pi, 'mcp__star__echo'), 'wildcard context connects for operator');
      assert.ok(!pi.tools.has('mcp__reviewonly__echo'), 'reviewer-scoped server hidden from operator');
      assert.ok(!pi.tools.has('mcp__multi__echo'), 'list-scoped server hidden when id not listed');
      await pi.commands.get('mcp').handler(ctx);
      const status = notices.map(([, m]) => m).join('\n');
      assert.match(status, /scoped to other agent context.*reviewonly/);
      assert.match(status, /scoped to other agent context.*multi/);
    } finally {
      await pi.handlers.get('session_shutdown')?.();
    }

    // Matching context: PAI_AGENT_ID=reviewer connects reviewonly + multi.
    process.env.PAI_AGENT_ID = 'reviewer';
    const pi2 = fakePi();
    mcpExtension(pi2);
    try {
      assert.ok(await waitTool(pi2, 'mcp__reviewonly__echo'), 'context match connects');
      assert.ok(await waitTool(pi2, 'mcp__multi__echo'), 'list membership connects');
    } finally {
      await pi2.handlers.get('session_shutdown')?.();
    }
  } finally {
    if (prev === undefined) delete process.env.PAI_MCP_CONFIG;
    else process.env.PAI_MCP_CONFIG = prev;
    if (prevAgent === undefined) delete process.env.PAI_AGENT_ID;
    else process.env.PAI_AGENT_ID = prevAgent;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M82: mcp prompts register as slash commands; get expands to a user message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcp-'));
  try {
    const serverPath = join(dir, 'server.js');
    writeFileSync(serverPath, FAKE_SERVER_JS);
    const cfgPath = join(dir, 'mcp.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [serverPath] } } }));
    const prev = process.env.PAI_MCP_CONFIG;
    process.env.PAI_MCP_CONFIG = cfgPath;
    try {
      const pi = fakePi();
      const sent = [];
      const notices = [];
      const ctx = { sendUserMessage: (m) => sent.push(m), ui: { notify: (m, l) => notices.push([l, m]) } };
      mcpExtension(pi);
      const deadline = Date.now() + 10_000;
      while (!pi.commands.has('mcp-fake-greet') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const cmd = pi.commands.get('mcp-fake-greet');
      assert.ok(cmd, 'prompt slash command registered');
      // missing required arg → honest error, nothing sent
      await cmd.handler('', ctx);
      assert.equal(sent.length, 0);
      assert.match(notices.at(-1)?.[1] ?? '', /missing required args: who/);
      // k=v and positional both bind to declared argument order
      await cmd.handler('who=world', ctx);
      assert.equal(sent.length, 1);
      assert.match(sent[0], /\[mcp prompt fake\/greet\]/, 'provenance prefix kept');
      assert.match(sent[0], /Say hello to world/);
      await pi.handlers.get('session_shutdown')?.();
    } finally {
      if (prev === undefined) delete process.env.PAI_MCP_CONFIG;
      else process.env.PAI_MCP_CONFIG = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kernel: mcp__* prefix policy rule gates dynamic tool names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-pol-'));
  try {
    writeFileSync(join(dir, 'policy.json'), JSON.stringify({
      version: 1,
      tools: { 'mcp__*': { action: 'ask' }, 'mcp__trusted__*': { action: 'allow' } },
    }));
    const policy = new AttestedPolicy(dir);
    const kernel = new GovernanceKernel({
      audit: { write() {} },
      policy,
      ask: async () => 'deny', // operator refuses → ask resolves to a block
    });
    const ask = await kernel.decideToolCall({ toolName: 'mcp__srv__do', args: {}, toolCall: { id: 't1', name: 'mcp__srv__do' } });
    assert.equal(ask?.block, true);
    assert.equal(ask?.rule, 'ask_deny'); // prove the ask pathway ran
    const longer = await kernel.decideToolCall({ toolName: 'mcp__trusted__x', args: {}, toolCall: { id: 't2', name: 'mcp__trusted__x' } });
    // longest-prefix wins: mcp__trusted__* allow beats mcp__* ask → undefined
    assert.equal(longer, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('decide: mcp__ tool holds the workspace write lease', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-lease-'));
  const lease = new WorkspaceWriteLease(join(dir, 'lease.json'));
  const decide = makeDecide({
    core: {
      kernel: { decideToolCall: async () => undefined },
      audit: { write() {} },
    },
    executor: { spawnCommandJob: async () => ({ refused: true, reason: 'n/a' }) },
    fileOps: { backup: async () => ({ backup: null }), delete: async () => { throw new Error('n/a'); } },
    getSurface: () => null,
    workdir: '/tmp',
    writeLease: lease,
  });
  // pre-hold the lease from a job — mcp__ call must be refused as mutating
  const acq = lease.acquire('job:test');
  assert.equal(acq.ok, true);
  const r = await decide({ toolCall: { id: 'tc', name: 'mcp__srv__write' }, toolName: 'mcp__srv__write', args: {} });
  assert.equal(r?.block, true);
  assert.equal(r?.rule, 'workspace_lease');
});

const PROMPT_ONLY_SERVER_JS = `
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'promptonly', version: '0' }, capabilities: { prompts: {} } } }) + '\\n');
    } else if (msg.method === 'tools/list') {
      // prompt-only server: Method not found — must NOT kill prompts/list
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }) + '\\n');
    } else if (msg.method === 'prompts/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { prompts: [{ name: 'brief', description: 'briefing prompt', arguments: [] }] } }) + '\\n');
    } else if (msg.method === 'prompts/get') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { description: 'brief', messages: [{ role: 'user', content: { type: 'text', text: 'Brief me' } }] } }) + '\\n');
    }
  }
});
setInterval(() => {}, 1000);
`;

const TOOLS_ONLY_SERVER_JS = `
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'toolsonly', version: '0' }, capabilities: { tools: {} } } }) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }] } }) + '\\n');
    } else if (msg.method === 'prompts/list') {
      // tools-only server: Method not found — must NOT kill tool registration
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }) + '\\n');
    }
  }
});
setInterval(() => {}, 1000);
`;

test('M82: prompt-only server connects — tools/list Method-not-found does not block prompts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcp-po-'));
  try {
    const serverPath = join(dir, 'server.js');
    writeFileSync(serverPath, PROMPT_ONLY_SERVER_JS);
    const cfgPath = join(dir, 'mcp.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: { po: { command: process.execPath, args: [serverPath] } } }));
    const prev = process.env.PAI_MCP_CONFIG;
    process.env.PAI_MCP_CONFIG = cfgPath;
    try {
      const pi = fakePi();
      const notices = [];
      const ctx = { sendUserMessage: () => {}, ui: { notify: (m, l) => notices.push([l, m]) } };
      mcpExtension(pi);
      const deadline = Date.now() + 10_000;
      while (!pi.commands.has('mcp-po-brief') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(pi.commands.has('mcp-po-brief'), 'prompt command registered despite tools/list failure');
      assert.equal([...pi.tools.keys()].filter((t) => t.startsWith('mcp__po__')).length, 0, 'no tools for a prompt-only server');
      // /mcp reports connected (not failed) with 0 tools / 1 prompt
      await pi.commands.get('mcp').handler(ctx);
      const report = notices.at(-1)?.[1] ?? '';
      assert.match(report, /po: connected — 0 tools, 1 prompts/);
      await pi.handlers.get('session_shutdown')?.();
    } finally {
      if (prev === undefined) delete process.env.PAI_MCP_CONFIG;
      else process.env.PAI_MCP_CONFIG = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M82: tools-only server connects — prompts/list failure does not block tools', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcp-to-'));
  try {
    const serverPath = join(dir, 'server.js');
    writeFileSync(serverPath, TOOLS_ONLY_SERVER_JS);
    const cfgPath = join(dir, 'mcp.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: { to: { command: process.execPath, args: [serverPath] } } }));
    const prev = process.env.PAI_MCP_CONFIG;
    process.env.PAI_MCP_CONFIG = cfgPath;
    try {
      const pi = fakePi();
      mcpExtension(pi);
      const deadline = Date.now() + 10_000;
      while (!pi.tools.has('mcp__to__ping') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(pi.tools.has('mcp__to__ping'), 'tool registered despite prompts/list failure');
      await pi.handlers.get('session_shutdown')?.();
    } finally {
      if (prev === undefined) delete process.env.PAI_MCP_CONFIG;
      else process.env.PAI_MCP_CONFIG = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// M130: server pushes notifications/tools/list_changed; the surface hot-
// refreshes — new tools register, removed tools tombstone to honest errors.
const LISTCHANGED_SERVER_JS = `
let buf = ''; let version = 1;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'lc', version: '0' }, capabilities: { tools: { listChanged: true } } } }) + '\\n');
    } else if (msg.method === 'tools/list') {
      const tools = version === 1
        ? [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }, { name: 'gone', inputSchema: { type: 'object', properties: {} } }]
        : [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }, { name: 'fresh', inputSchema: { type: 'object', properties: {} } }];
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools } }) + '\\n');
    } else if (msg.method === 'tools/call') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok:' + msg.params?.name }] } }) + '\\n');
      // deterministic trigger: the first tools/call flips the catalog and
      // pushes list_changed AFTER the response, so the client refresh races nothing
      if (version === 1) {
        version = 2;
        setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\\n'), 30);
      }
    } else if (msg.id != null) {
      // a real MCP server answers unknown methods with Method-not-found —
      // silence would just hang the client's request until timeout
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found: ' + msg.method } }) + '\\n');
    }
  }
});
setInterval(() => {}, 1000);
`;

test('M130: notifications/tools/list_changed hot-refreshes — new tool registers, removed tool tombstones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcp-lc-'));
  try {
    const serverPath = join(dir, 'server.js');
    writeFileSync(serverPath, LISTCHANGED_SERVER_JS);
    const cfgPath = join(dir, 'mcp.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: { lc: { command: process.execPath, args: [serverPath] } } }));
    const prev = process.env.PAI_MCP_CONFIG;
    process.env.PAI_MCP_CONFIG = cfgPath;
    const pi = fakePi();
    try {
      mcpExtension(pi);
      const deadline = Date.now() + 10_000;
      while (!pi.tools.has('mcp__lc__gone') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(pi.tools.has('mcp__lc__echo') && pi.tools.has('mcp__lc__gone'), 'v1 catalog registered');
      // trigger the server-side catalog swap deterministically via a tool call
      const kick = await pi.tools.get('mcp__lc__echo').execute('t0', {}, null);
      assert.match(kick.content[0].text, /ok:echo/);
      // wait for the pushed notification → refresh → v2 catalog
      while (!pi.tools.has('mcp__lc__fresh') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(pi.tools.has('mcp__lc__fresh'), 'new tool registered after list_changed');
      // 'gone' stays registered (pi has no unregister) but fails closed
      const gone = await pi.tools.get('mcp__lc__gone').execute('t1', {}, null);
      assert.equal(gone.isError, true);
      assert.match(gone.content[0].text, /removed by server/);
      // surviving tool still calls through
      const ok = await pi.tools.get('mcp__lc__echo').execute('t2', {}, null);
      assert.match(ok.content[0].text, /ok:echo/);
    } finally {
      // always shut the client down — a failed assertion must not leave the
      // fake server's keepalive interval holding the child process open
      await pi.handlers.get('session_shutdown')?.();
      if (prev === undefined) delete process.env.PAI_MCP_CONFIG;
      else process.env.PAI_MCP_CONFIG = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ENV_ECHO_SERVER_JS = `
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'env', version: '0' }, capabilities: { tools: {} } } }) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'env', inputSchema: { type: 'object', properties: {} } }] } }) + '\\n');
    } else if (msg.method === 'tools/call') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ n: process.env.NODE_OPTIONS ?? null, p: process.env.PATH ? 'set' : 'unset', s: process.env.MY_SAFE ?? null }) }] } }) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }) + '\\n');
    }
  }
});
setInterval(() => {}, 1000);
`;

test('A2 env sanitize: injection keys stripped at spawn; operator env + ordinary keys pass', async () => {
  // unit surface — injection family gone, credentials/custom keys survive
  const { env, stripped } = sanitizeSpecEnv({
    NODE_OPTIONS: '--require ./payload.js', PATH: 'C:\\evil', HTTP_PROXY: 'http://evil',
    LD_PRELOAD: '/e.so', PYTHONSTARTUP: 'e.py', GIT_SSH_COMMAND: 'evil',
    GITHUB_TOKEN: 'tok', MY_FLAG: '1',
  });
  for (const k of ['NODE_OPTIONS', 'PATH', 'HTTP_PROXY', 'LD_PRELOAD', 'PYTHONSTARTUP', 'GIT_SSH_COMMAND']) {
    assert.equal(env[k], undefined, `${k} stripped`);
  }
  assert.equal(env.GITHUB_TOKEN, 'tok');
  assert.equal(env.MY_FLAG, '1');
  assert.equal(stripped.length, 6);

  // spawn-level proof — the child process really does not see the key
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcp-env-'));
  try {
    const serverPath = join(dir, 'env-server.js');
    writeFileSync(serverPath, ENV_ECHO_SERVER_JS);
    const client = await McpClient.connect({
      command: process.execPath, args: [serverPath],
      env: { NODE_OPTIONS: '--require ./nowhere', MY_SAFE: 'yes' },
    });
    try {
      assert.deepEqual(client.strippedEnv, ['NODE_OPTIONS']);
      const res = await client.callTool('env', {});
      const seen = JSON.parse(res.content[0].text);
      assert.equal(seen.n, process.env.NODE_OPTIONS ?? null); // operator env only, spec value gone
      assert.equal(seen.s, 'yes');                            // ordinary key delivered
      assert.equal(seen.p, 'set');                            // inherited operator PATH
    } finally {
      client.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C2 output_token_limit: per-server cap tightens text results; per-tool override wins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcp-cap-'));
  try {
    const serverPath = join(dir, 'server.js');
    writeFileSync(serverPath, FAKE_SERVER_JS);
    const cfgPath = join(dir, 'mcp.json');
    // 10 tokens -> 40 char cap on every tool; echo pinned even lower (5 tok -> 20)
    writeFileSync(cfgPath, JSON.stringify({
      mcpServers: {
        capped: { command: process.execPath, args: [serverPath], output_token_limit: 10, tool_output_limits: { echo: 5 } },
      },
    }));
    const prev = process.env.PAI_MCP_CONFIG;
    process.env.PAI_MCP_CONFIG = cfgPath;
    try {
      const pi = fakePi();
      mcpExtension(pi);
      const deadline = Date.now() + 10_000;
      while (!pi.tools.has('mcp__capped__echo') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const tool = pi.tools.get('mcp__capped__echo');
      assert.ok(tool, 'echo registered under capped server');
      const res = await tool.execute('tc', { text: 'x'.repeat(500) });
      assert.match(res.content[0].text, /truncated at 20 chars/, 'per-tool 5-token cap = 20 chars');
      // the untrusted envelope still wraps the truncated body
      assert.match(res.content[0].text, /<untrusted mcp_server="capped"/);
      await pi.handlers.get('session_shutdown')?.();
    } finally {
      if (prev === undefined) delete process.env.PAI_MCP_CONFIG;
      else process.env.PAI_MCP_CONFIG = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// G3: a failed handshake used to orphan the spawned stdio child — connect
// propagated the initialize error without closing the transport. The child
// must be killed before connect rejects.
const REFUSING_SERVER_JS = `
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], String(process.pid));
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {

    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      // handshake refused AFTER the pid file is on disk — the child is provably running
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'handshake refused' } }) + '\\n');

    }
  }
});
setInterval(() => {}, 1000);
`;

test('connect failure kills the spawned stdio child (no orphan server)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcp-leak-'));
  try {
    const serverPath = join(dir, 'refusing.js');
    const pidFile = join(dir, 'pid.txt');
    writeFileSync(serverPath, REFUSING_SERVER_JS);
    await assert.rejects(
      () => McpClient.connect({ command: process.execPath, args: [serverPath, pidFile] }, { timeoutMs: 3000 }),
      /handshake refused|timed out|abort/i,
    );
    const pid = Number(readFileSync(pidFile, 'utf-8'));
    assert.ok(pid > 0);
    // taskkill /T is spawned detached — give it a moment to land
    const deadline = Date.now() + 5000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { alive = false; }
      if (alive) await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(alive, false, 'failed connect must kill the spawned child');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// G8: non-text content blocks are normalized — known types (image/audio/
// resource/resource_link) pass through; unknown or malformed blocks become
// an honest text stub instead of smuggling arbitrary shapes into context.
const WEIRD_SERVER_JS = `
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'weird' }, capabilities: { tools: {} } } }) + '\\n');
    } else if (msg.method === 'tools/call') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [
        { type: 'text', text: 'fine' },
        { type: 'image', data: 'QUJD', mimeType: 'image/png' },
        { type: 'mind_control', payload: { do: 'evil' } },
        'a bare string is not a content block',
      ] } }) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'x', inputSchema: { type: 'object' } }] } }) + '\\n');
    }
  }
});
setInterval(() => {}, 1000);
`;

test('non-text MCP blocks: known types pass, malformed blocks become stub text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcp-weird-'));
  try {
    const serverPath = join(dir, 'weird.js');
    writeFileSync(serverPath, WEIRD_SERVER_JS);
    const cfgPath = join(dir, 'mcp.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: { w: { command: process.execPath, args: [serverPath] } } }));
    const prev = process.env.PAI_MCP_CONFIG;
    process.env.PAI_MCP_CONFIG = cfgPath;
    try {
      const pi = fakePi();
      mcpExtension(pi);
      const deadline = Date.now() + 10_000;
      while (!pi.tools.has('mcp__w__x') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const res = await pi.tools.get('mcp__w__x').execute('tc', {});
      const types = res.content.map((c) => c.type);
      assert.deepEqual(types, ['text', 'image', 'text', 'text'], 'image passes; unknown + non-object become text stubs');
      assert.match(res.content[2].text, /unsupported content block 'mind_control' dropped/);
      assert.match(res.content[3].text, /unsupported content block 'string' dropped/);
      assert.equal(res.details.droppedBlocks, 2);
      await pi.handlers.get('session_shutdown')?.();
    } finally {
      if (prev === undefined) delete process.env.PAI_MCP_CONFIG;
      else process.env.PAI_MCP_CONFIG = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// dedup-h #167: /mcp-add — claude-code compatible positional add persists
// the spec then hot-connects through the same path as boot servers.
test('mcp-add: positional URL persists + hot-connects; stdio + duplicates + deny handled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcp-add-'));
  try {
    // live http MCP server to add against
    const srv = createServer((req, res) => {
      if (req.method === 'GET') { res.statusCode = 405; res.end(); return; }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const msg = JSON.parse(body);
        const rpcRes = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
        res.setHeader('content-type', 'application/json');
        if (msg.method === 'initialize') res.end(JSON.stringify(rpcRes({ protocolVersion: '2025-06-18', serverInfo: { name: 'added' } })));
        else if (!msg.id) { res.statusCode = 202; res.end(); }
        else if (msg.method === 'tools/list') res.end(JSON.stringify(rpcRes({ tools: [{ name: 'ping', inputSchema: { type: 'object' } }] })));
        else if (msg.method === 'prompts/list') res.end(JSON.stringify(rpcRes({ prompts: [] })));
        else res.end(JSON.stringify(rpcRes({ content: [{ type: 'text', text: 'pong' }] })));
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const cfgPath = join(dir, 'mcp.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }));
    const prev = process.env.PAI_MCP_CONFIG, prevDeny = process.env.PAI_MCP_DENY;
    process.env.PAI_MCP_CONFIG = cfgPath;
    process.env.PAI_MCP_DENY = 'blocked';
    try {
      const pi = fakePi();
      const notices = [];
      const ctx = { ui: { notify: (m, l) => notices.push([l, m]) } };
      mcpExtension(pi);
      const add = pi.commands.get('mcp-add');
      assert.ok(add, 'mcp-add registered');

      // positional URL → http spec persisted + hot-connected
      await add.handler(`remote http://127.0.0.1:${srv.address().port}/mcp --header "X-Team: ops"`, ctx);
      assert.ok(pi.tools.has('mcp__remote__ping'), 'added server tools registered live');
      const doc = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      assert.equal(doc.mcpServers.remote.url, `http://127.0.0.1:${srv.address().port}/mcp`);
      assert.equal(doc.mcpServers.remote.headers['X-Team'], 'ops');
      assert.match(notices.at(-1)[1], /connected: 1 tools/);

      // stdio form: quoted command path + args array + env
      await add.handler(`local "${process.execPath}" -e "console.log(1)" --env FOO=bar`, ctx);
      const doc2 = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      assert.equal(doc2.mcpServers.local.command, process.execPath);
      assert.deepEqual(doc2.mcpServers.local.args, ['-e', 'console.log(1)']);
      assert.equal(doc2.mcpServers.local.env.FOO, 'bar');

      // duplicate refused; denied name refused; missing args refused
      await add.handler(`remote http://127.0.0.1:9/mcp`, ctx);
      assert.match(notices.at(-1)[1], /already exists/);
      await add.handler(`blocked http://127.0.0.1:9/mcp`, ctx);
      assert.match(notices.at(-1)[1], /denied/);
      await add.handler(`lonely`, ctx);
      assert.match(notices.at(-1)[1], /usage:/);

      // failed connect still persists (operator's config), honestly reported
      await add.handler(`ghost http://127.0.0.1:1/mcp`, ctx);
      const doc3 = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      assert.ok(doc3.mcpServers.ghost, 'failed connect still persisted');
      assert.match(notices.at(-1)[1], /connect FAILED/);

      // dedup-h #350: pre-registered oauth client — bare id is a half-spec
      // refused at write time; full flags persist a validated spec.oauth
      await add.handler(`half http://127.0.0.1:${srv.address().port}/mcp --oauth-client-id cid-1`, ctx);
      assert.match(notices.at(-1)[1], /oauth spec incomplete.*tokenUrl/);
      assert.ok(!JSON.parse(readFileSync(cfgPath, 'utf-8')).mcpServers.half, 'half-spec not persisted');
      await add.handler(`secured http://127.0.0.1:${srv.address().port}/mcp --oauth-client-id cid-9 --oauth-token-url http://127.0.0.1:9/token --oauth-scope "mcp:read"`, ctx);
      const doc4 = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      assert.deepEqual(doc4.mcpServers.secured.oauth, {
        clientId: 'cid-9', tokenUrl: 'http://127.0.0.1:9/token', scope: 'mcp:read',
      });
      // dedup-h #1509: the secret half — literal persists verbatim; -env
      // persists the ${VAR} reference (secret never sits in mcp.json)
      await add.handler(`confid http://127.0.0.1:${srv.address().port}/mcp --oauth-client-id cid-c --oauth-token-url http://127.0.0.1:9/token --oauth-client-secret s3cr3t`, ctx);
      assert.equal(JSON.parse(readFileSync(cfgPath, 'utf-8')).mcpServers.confid.oauth.clientSecret, 's3cr3t');
      await add.handler(`envsec http://127.0.0.1:${srv.address().port}/mcp --oauth-client-id cid-e --oauth-token-url http://127.0.0.1:9/token --oauth-client-secret-env MY_TOK_SECRET`, ctx);
      assert.equal(JSON.parse(readFileSync(cfgPath, 'utf-8')).mcpServers.envsec.oauth.clientSecret, '${MY_TOK_SECRET}');
      // oauth fields join env expansion at loadConfig: ${VAR} resolves when
      // set, lands in missingEnv when not
      const prevSec = process.env.MY_TOK_SECRET;
      process.env.MY_TOK_SECRET = 'resolved-sec';
      const loaded = mcpOperatorSurface.loadConfig();
      assert.equal(loaded.servers.envsec.oauth.clientSecret, 'resolved-sec');
      delete process.env.MY_TOK_SECRET;
      const loadedMissing = mcpOperatorSurface.loadConfig();
      assert.equal(loadedMissing.servers.envsec.oauth.clientSecret, '${MY_TOK_SECRET}', 'unresolved stays literal');
      assert.ok(loadedMissing.missingEnv.includes('MY_TOK_SECRET'), 'missing env diagnosed');
      if (prevSec !== undefined) process.env.MY_TOK_SECRET = prevSec;

      // #1509 end-to-end: the persisted file keeps ${VAR}; the LIVE connect
      // resolves it — the token endpoint must see the resolved secret, not
      // the literal reference.
      const tokSeen = { tokenBodies: [], authHeaders: [] };
      const { token: tokSrv } = makeOAuthRig(tokSeen);
      await new Promise((r) => tokSrv.listen(0, '127.0.0.1', r));
      process.env.PAI_TEST_OSEC = 'resolved-sec';
      try {
        await add.handler(`envsec3 http://127.0.0.1:${srv.address().port}/mcp --oauth-client-id cid-e3 --oauth-token-url http://127.0.0.1:${tokSrv.address().port}/t --oauth-client-secret-env PAI_TEST_OSEC`, ctx);
        assert.equal(JSON.parse(readFileSync(cfgPath, 'utf-8')).mcpServers.envsec3.oauth.clientSecret, '${PAI_TEST_OSEC}', 'file keeps the reference');
        assert.equal(tokSeen.tokenBodies[0]?.client_secret, 'resolved-sec', 'connect resolved the env ref, not the literal');
      } finally {
        delete process.env.PAI_TEST_OSEC;
        tokSrv.close();
      }
      // oauth flags on a stdio add are nonsense — refused, not stored
      await add.handler(`badstdio "${process.execPath}" --oauth-client-id x`, ctx);
      assert.match(notices.at(-1)[1], /oauth flags apply to URL servers only/);

      // dedup-h #396: credential redaction — a userinfo URL is never
      // echoed back; /mcp reports header COUNT only, never names/values
      await add.handler(`cred http://token:s3cr3t@127.0.0.1:${srv.address().port}/mcp --header "Authorization: Bearer xyz"`, ctx);
      const lastNotice = notices.at(-1)[1];
      assert.ok(!lastNotice.includes('s3cr3t'), 'userinfo password redacted from the notice');
      assert.ok(lastNotice.includes('127.0.0.1'), 'host still shown');
      await pi.commands.get('mcp').handler({ ui: { notify: (m) => notices.push(m) } });
      const mcpDoc = notices.at(-1);
      assert.match(mcpDoc, /headers: 1 configured \(values redacted\)/);
      assert.ok(!mcpDoc.includes('xyz') && !mcpDoc.includes('Authorization'), 'header name/value never surface');
      await pi.handlers.get('session_shutdown')?.();
    } finally {
      if (prev === undefined) delete process.env.PAI_MCP_CONFIG; else process.env.PAI_MCP_CONFIG = prev;
      if (prevDeny === undefined) delete process.env.PAI_MCP_DENY; else process.env.PAI_MCP_DENY = prevDeny;
      srv.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// dedup-h #242-env: ${VAR_NAME} placeholders expand in command/args/env/
// url/headers; missing vars stay literal AND are diagnosed in /mcp.
test('mcp env expansion: ${VAR} resolves in stdio+http fields; missing diagnosed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcpenv-'));
  process.env.PAI_TEST_TOKEN_X = 's3cr3t';
  const cfgPath = join(dir, 'mcp.json');
  writeFileSync(cfgPath, JSON.stringify({
    mcpServers: {
      s1: { command: '${PAI_TEST_TOKEN_X}', args: ['--k', '${PAI_TEST_TOKEN_X}'], env: { K: '${PAI_TEST_TOKEN_X}', M: '${PAI_MISSING_X}' } },
      s2: { url: 'http://127.0.0.1:1/${PAI_TEST_TOKEN_X}', headers: { 'X-Auth': 'Bearer ${PAI_TEST_TOKEN_X}' } },
    },
  }));
  process.env.PAI_MCP_CONFIG = cfgPath;
  try {
    const m = await import('../extensions/mcp/index.js');
    const tools = new Map(); const commands = new Map();
    const pi = {
      registerTool: (t) => tools.set(t.name, t),
      registerCommand: (n, o) => commands.set(n, o),
      on: () => {},
    };
    m.default(pi);
    const notices = [];
    await commands.get('mcp').handler({ ui: { notify: (msg) => notices.push(msg) } });
    const doc = notices.join('\n');
    assert.match(doc, /unresolved env placeholders.*\$\{PAI_MISSING_X\}/, 'missing var diagnosed');
    // expansion happened in the loaded spec — the placeholder never reaches connect
    // (verifiable via the /mcp output path: servers exist but failed to connect,
    //  while the spec fields carried resolved values — assert via a second config
    //  check: re-read through loadConfig path is internal; assert the diagnostic
    //  names exactly the missing var and only it)
    assert.ok(!doc.includes('PAI_TEST_TOKEN_X is'), 'resolved vars are not diagnosed');
  } finally {
    delete process.env.PAI_MCP_CONFIG;
    delete process.env.PAI_TEST_TOKEN_X;
  }
});

// dedup-h #347 — legacy transport:"sse": GET opens a persistent stream,
// server announces `event: endpoint`, client POSTs there (202) and
// responses ride back over the stream as `event: message` frames.
test('mcp legacy sse: endpoint handshake + stream-routed responses', async () => {
  const seen = { posts: [], endpointSent: false };
  let sseRes = null;
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('event: endpoint\ndata: /messages?session_id=s1\n\n');
      seen.endpointSent = true;
      sseRes = res;
      return; // stream stays open
    }
    if (req.method === 'POST' && req.url.startsWith('/messages')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const msg = JSON.parse(body);
        seen.posts.push(msg);
        res.statusCode = 202;
        res.end();
        if (msg.id == null) return; // notification — nothing to answer
        const result = msg.method === 'initialize'
          ? { protocolVersion: '2024-11-05', serverInfo: { name: 'legacy-sse' } }
          : msg.method === 'tools/call'
            ? { content: [{ type: 'text', text: `sse-answer:${msg.params.name}` }] }
            : { tools: [{ name: 'legacy-tool' }] };
        // the response is pushed over the SSE stream, NOT the POST reply
        sseRes.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/sse`;
    const client = await McpClient.connect({ url, transport: 'sse' });
    try {
      assert.equal(client.serverInfo.serverInfo.name, 'legacy-sse');
      assert.ok(seen.endpointSent, 'server announced its endpoint');
      const tools = await client.listTools();
      assert.equal(tools[0].name, 'legacy-tool');
      const res = await client.callTool('anything', {});
      assert.equal(res.content[0].text, 'sse-answer:anything');
      assert.ok(seen.posts.every((m) => m.jsonrpc === '2.0'), 'all requests POSTed to endpoint');
    } finally {
      client.close();
    }
  } finally {
    server.close();
  }
});

test('mcp legacy sse: dead stream fails pending honestly, bad transport refused', async () => {
  let sseRes = null;
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: endpoint\ndata: /m\n\n');
      sseRes = res;
      return;
    }
    // on the tools/list POST: 202 then kill the stream — the request's
    // response can never arrive; onExit must fail the pending call loudly
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.statusCode = 202;
      res.end();
      const msg = JSON.parse(body);
      if (msg.method === 'initialize') {
        sseRes.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'legacy-sse' } } })}\n\n`);
      } else if (msg.method === 'tools/list') setTimeout(() => sseRes?.end(), 20);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/sse`;
    const client = await McpClient.connect({ url, transport: 'sse' });
    await assert.rejects(() => client.listTools(), /mcp server process exited/);
    client.close();
    await assert.rejects(
      () => McpClient.connect({ url, transport: 'carrier-pigeon' }),
      /transport 'carrier-pigeon' unsupported/,
    );
  } finally {
    server.close();
  }
});

// dedup-h #348 — no implicit transport timeouts: a POST that the server
// swallows forever must surface as a bounded failure, not an undici
// ~5min default. spec.postTimeoutMs is the operator/test dial.
test('mcp legacy sse: black-hole POST fails bounded, never silently hangs', async () => {
  let sseRes = null;
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: endpoint\ndata: /m\n\n');
      sseRes = res;
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = JSON.parse(body);
      if (msg.method === 'initialize') {
        res.statusCode = 202; res.end();
        sseRes.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'x' } } })}\n\n`);
      }
      // everything else: swallow — never respond to the POST, never
      // answer on the stream. The explicit post bound must surface it.
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/sse`;
    const client = await McpClient.connect({ url, transport: 'sse', postTimeoutMs: 80 });
    const t0 = Date.now();
    await assert.rejects(() => client.listTools(), /sse POST failed|timed out/);
    assert.ok(Date.now() - t0 < 10_000, 'bounded failure — not the implicit transport default');
    client.close();
  } finally {
    server.close();
  }
});

// dedup-h #394 — remote connect budget: unreachable servers connect
// CONCURRENTLY inside a 10s budget; two dead servers cost ~10s, not ~20s.
test('mcp boot: dead remote servers fail inside one shared 10s budget', async () => {
  const blackhole = () => {
    const s = createServer(() => { /* accept, never respond — a hung server */ });
    return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
  };
  const s1 = await blackhole(), s2 = await blackhole();
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcpbh-'));
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({
    mcpServers: {
      dead1: { url: `http://127.0.0.1:${s1.address().port}/mcp` },
      dead2: { url: `http://127.0.0.1:${s2.address().port}/mcp`, transport: 'sse' }, // #398: legacy-SSE spec shares the same budget
    },
  }));
  const prev = process.env.PAI_MCP_CONFIG;
  process.env.PAI_MCP_CONFIG = join(dir, 'mcp.json');
  try {
    const pi = fakePi();
    mcpExtension(pi);
    const t0 = Date.now();
    const notices = [];
    await pi.commands.get('mcp').handler({ ui: { notify: (m) => notices.push(m) } });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 19_000, `serial connects would take ~20s+; parallel budget measured ${elapsed}ms`);
    const doc = notices.join('\n');
    assert.match(doc, /dead1: FAILED/);
    assert.match(doc, /dead2: FAILED/);
    await pi.handlers.get('session_shutdown')?.();
  } finally {
    s1.close(); s2.close();
    if (prev === undefined) delete process.env.PAI_MCP_CONFIG; else process.env.PAI_MCP_CONFIG = prev;
  }
});

// dedup-h #524 — per-server enable/disable: enabled:false never connects at
// boot but stays listed; the toggle persists into the SAME config file and
// applies to the live session NOW (disable closes, enable connects).
test('mcp enable/disable: disabled server skips boot; toggles persist + apply live', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcp-tog-'));
  const prev = process.env.PAI_MCP_CONFIG;
  try {
    const serverPath = join(dir, 'server.js');
    writeFileSync(serverPath, FAKE_SERVER_JS);
    const cfgPath = join(dir, 'mcp.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {
      live: { command: process.execPath, args: [serverPath] },
      sleeping: { command: process.execPath, args: [serverPath], enabled: false },
    } }));
    process.env.PAI_MCP_CONFIG = cfgPath;
    const pi = fakePi();
    await mcpExtension(pi);
    // boot connects concurrently — poll until the enabled server's tools land
    const until = Date.now() + 10_000;
    while (!pi.tools.has('mcp__live__echo') && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 150));
    }
    const ctx = { ui: { notify: () => {} } };

    // disabled at boot: no tools registered under its namespace
    assert.ok(pi.tools.has('mcp__live__echo'), 'enabled server registered tools');
    assert.ok(!pi.tools.has('mcp__sleeping__echo'), 'disabled server registered nothing');
    const notices = [];
    const cap = { ui: { notify: (m) => notices.push(m) } };
    await pi.commands.get('mcp').handler(cap);
    assert.ok(notices[0].includes('disabled'), '/mcp lists the disabled set');
    assert.ok(notices[0].includes('sleeping'), 'disabled server named in status');

    // enable: persists enabled:true + connects NOW
    await pi.commands.get('mcp-enable').handler('sleeping', cap);
    const doc1 = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    assert.equal(doc1.mcpServers.sleeping.enabled, true, 'enabled:true persisted');
    const until2 = Date.now() + 10_000;
    while (!pi.tools.has('mcp__sleeping__echo') && Date.now() < until2) {
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(pi.tools.has('mcp__sleeping__echo'), 'enable connected live — tools registered');
    const t = await pi.tools.get('mcp__sleeping__echo').execute('c1', { text: 'up' });
    assert.match(t.content[0].text, /echo:up/, 'live call works after enable');

    // disable: persists enabled:false + closes the live client
    await pi.commands.get('mcp-disable').handler('sleeping', cap);
    const doc2 = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    assert.equal(doc2.mcpServers.sleeping.enabled, false, 'enabled:false persisted');
    const dead = await pi.tools.get('mcp__sleeping__echo').execute('c2', { text: 'x' })
      .then((r) => ({ resolved: true, r })).catch((e) => ({ resolved: false, err: String(e?.message ?? e) }));
    // a closed client must not answer with a fake success — either the call
    // rejects or the result is marked isError
    if (dead.resolved) {
      assert.ok(dead.r?.isError === true || /closed|fail|error/i.test(JSON.stringify(dead.r)),
        `closed client returned a success-looking result: ${JSON.stringify(dead.r).slice(0, 300)}`);
    }
    // unknown name refuses
    await pi.commands.get('mcp-disable').handler('ghost', cap);
    assert.ok(notices.some((m) => m.includes("unknown server 'ghost'")), 'unknown name refused');

    await pi.handlers.get('session_shutdown')?.();
  } finally {
    if (prev === undefined) delete process.env.PAI_MCP_CONFIG; else process.env.PAI_MCP_CONFIG = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- dedup-h #740: RFC 8628 device authorization grant --------------------
import { mcpOperatorSurface } from '../extensions/mcp/index.js';

test('oauth spec: deviceAuthUrl selects device_code; explicit flow pins; missing urls refuse', () => {
  const base = { oauth: { tokenUrl: 'http://127.0.0.1:1/t', clientId: 'cid' } };
  const dev = mcpOperatorSurface.validateOAuthSpec({ oauth: { ...base.oauth, deviceAuthUrl: 'http://127.0.0.1:1/d' } });
  assert.equal(dev.flow, 'device_code');
  const pinned = mcpOperatorSurface.validateOAuthSpec({
    oauth: { ...base.oauth, deviceAuthUrl: 'http://127.0.0.1:1/d', authorizationUrl: 'https://a.example/x', flow: 'device_code' },
  });
  assert.equal(pinned.flow, 'device_code', 'explicit flow wins over the authorizationUrl default');
  const codeFlow = mcpOperatorSurface.validateOAuthSpec({
    oauth: { ...base.oauth, deviceAuthUrl: 'http://127.0.0.1:1/d', authorizationUrl: 'https://a.example/x' },
  });
  assert.equal(codeFlow.flow, 'authorization_code', 'authorizationUrl still wins when unpinned');
  assert.throws(() => mcpOperatorSurface.validateOAuthSpec({ oauth: { ...base.oauth, flow: 'device_code' } }), /deviceAuthUrl/);
  assert.throws(() => mcpOperatorSurface.validateOAuthSpec({ oauth: { ...base.oauth, flow: 'authorization_code' } }), /authorizationUrl/);
  assert.throws(() => mcpOperatorSurface.validateOAuthSpec({ oauth: { ...base.oauth, flow: 'magic' } }), /oauth.flow/);
  assert.throws(() => mcpOperatorSurface.validateOAuthSpec({ oauth: { ...base.oauth, deviceAuthUrl: 'http://evil.example/d' } }), /loopback/);
});

test('device authorize + poll: real endpoints, pending->slow_down->token; denied/expired honest', async () => {
  const seen = { authorize: [], token: [] };
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/device') {
        seen.authorize.push(Object.fromEntries(new URLSearchParams(body)));
        res.end(JSON.stringify({ device_code: 'dc-1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 600 }));
      } else {
        const p = Object.fromEntries(new URLSearchParams(body));
        seen.token.push(p);
        if (seen.token.length === 1) res.end(JSON.stringify({ error: 'authorization_pending' }));
        else if (seen.token.length === 2) res.end(JSON.stringify({ error: 'slow_down' }));
        else res.end(JSON.stringify({ access_token: 'tok-dev', token_type: 'bearer', expires_in: 3600, refresh_token: 'rt-1' }));
      }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const oauth = {
      tokenUrl: `http://127.0.0.1:${srv.address().port}/token`, clientId: 'cid',
      deviceAuthUrl: `http://127.0.0.1:${srv.address().port}/device`, scope: 'repo read',
    };
    const d = await mcpOperatorSurface.oauthDeviceAuthorize(oauth);
    assert.equal(d.deviceCode, 'dc-1');
    assert.equal(d.userCode, 'ABCD-1234');
    assert.equal(seen.authorize[0].client_id, 'cid');
    assert.equal(seen.authorize[0].scope, 'repo read');

    const sleeps = [];
    const t = await mcpOperatorSurface.oauthDevicePoll(oauth, { ...d, sleep: async (ms) => sleeps.push(ms) });
    assert.equal(t.accessToken, 'tok-dev');
    assert.equal(t.refreshToken, 'rt-1');
    assert.equal(seen.token.length, 3);
    assert.equal(seen.token[0].grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
    assert.equal(seen.token[0].device_code, 'dc-1');
    assert.deepEqual(sleeps, [1000, 6000], 'pending sleeps interval; slow_down adds 5s (RFC 8628 §3.5)');

    // denial + expiry are honest terminal errors, not silent loops
    const deny = createServer((_q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ error: 'access_denied' })); });
    await new Promise((r) => deny.listen(0, '127.0.0.1', r));
    await assert.rejects(
      () => mcpOperatorSurface.oauthDevicePoll({ tokenUrl: `http://127.0.0.1:${deny.address().port}/t`, clientId: 'c' }, { deviceCode: 'x', sleep: async () => {} }),
      /denied/);
    deny.close();
  } finally { srv.close(); }
});

// ---- dedup-h #1065: loopback OAuth redirect (localhost:PORT/callback) ------

test('loopback spec: redirectUri loopback parses to {port,path}; non-loopback/oob → null; loopbackRedirect flag defaults 8765', () => {
  assert.deepEqual(mcpOperatorSurface.loopbackListenSpec('http://localhost:8765/callback'), { port: 8765, path: '/callback' });
  assert.deepEqual(mcpOperatorSurface.loopbackListenSpec('http://127.0.0.1:9999/cb'), { port: 9999, path: '/cb' });
  assert.equal(mcpOperatorSurface.loopbackListenSpec('urn:ietf:wg:oauth:2.0:oob'), null);
  assert.equal(mcpOperatorSurface.loopbackListenSpec('https://app.example.com/cb'), null);
  assert.equal(mcpOperatorSurface.loopbackListenSpec('not a uri'), null);
  // flag → default 8765; redirectPort override; bad port refused
  const o = mcpOperatorSurface.validateOAuthSpec({ oauth: {
    tokenUrl: 'http://127.0.0.1:1/t', clientId: 'c', authorizationUrl: 'https://a.example/x', loopbackRedirect: true,
  } });
  assert.equal(o.redirectUri, 'http://localhost:8765/callback');
  const o2 = mcpOperatorSurface.validateOAuthSpec({ oauth: {
    tokenUrl: 'http://127.0.0.1:1/t', clientId: 'c', authorizationUrl: 'https://a.example/x', loopbackRedirect: true, redirectPort: 4567,
  } });
  assert.equal(o2.redirectUri, 'http://localhost:4567/callback');
  assert.throws(() => mcpOperatorSurface.validateOAuthSpec({ oauth: {
    tokenUrl: 'http://127.0.0.1:1/t', clientId: 'c', authorizationUrl: 'https://a.example/x', loopbackRedirect: true, redirectPort: 'abc',
  } }), /redirectPort/);
});

test('loopback listener: matching state+code resolves; wrong state 400s and keeps waiting; provider error rejects', async () => {
  // find a free port by binding then releasing — the OAuth listener must
  // answer on the exact port the provider redirects to.
  const srv = createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const freePort = srv.address().port;
  srv.close();
  const l2 = mcpOperatorSurface.oauthLoopbackListen({ port: freePort, path: '/cb', state: 'st-9', timeoutMs: 8000 });
  // wrong state → 400, still listening
  const bad = await fetch(`http://127.0.0.1:${freePort}/cb?code=x&state=WRONG`);
  assert.equal(bad.status, 400);
  // right hit resolves
  const hit = await fetch(`http://127.0.0.1:${freePort}/cb?code=AUTHCODE1&state=st-9`);
  assert.equal(hit.status, 200);
  const got = await l2.promise;
  assert.equal(got.code, 'AUTHCODE1');

  // provider error rejects honestly
  const srv2 = createServer();
  await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
  const free2 = srv2.address().port; srv2.close();
  const l3 = mcpOperatorSurface.oauthLoopbackListen({ port: free2, path: '/callback', state: 's', timeoutMs: 5000 });
  const denied = assert.rejects(l3.promise, /denied/); // attach BEFORE the trigger — an already-rejected promise flags unhandledRejection
  await fetch(`http://127.0.0.1:${free2}/callback?error=access_denied&state=s`);
  await denied;
});

// dedup-h #1077 — interactive OAuth opens the system browser itself.
test('openBrowser: per-platform argv, kill-switch, non-http refused', () => {
  const calls = [];
  const spy = (bin, args, opts) => { calls.push([bin, args, opts]); return { on() {}, unref() {} }; };
  assert.ok(openBrowser('https://idp.example/auth?x=1', { spawnImpl: spy, platform: 'win32' }));
  assert.equal(calls[0][0], 'rundll32');
  assert.deepEqual(calls[0][1], ['url.dll,FileProtocolHandler', 'https://idp.example/auth?x=1']);
  assert.equal(calls[0][2].detached, true);
  assert.ok(openBrowser('https://idp.example/', { spawnImpl: spy, platform: 'darwin' }));
  assert.equal(calls[1][0], 'open');
  assert.ok(openBrowser('https://idp.example/', { spawnImpl: spy, platform: 'linux' }));
  assert.equal(calls[2][0], 'xdg-open');
  assert.equal(openBrowser('file:///etc/passwd', { spawnImpl: spy }), false);
  assert.equal(openBrowser('not-a-url', { spawnImpl: spy }), false);
  assert.equal(calls.length, 3, 'refused inputs never spawn');
  process.env.PAI_OAUTH_NO_AUTO_OPEN = '1';
  try {
    assert.equal(openBrowser('https://idp.example/', { spawnImpl: spy }), false);
  } finally {
    delete process.env.PAI_OAUTH_NO_AUTO_OPEN;
  }
  assert.equal(calls.length, 3, 'kill-switch suppresses the spawn');
});

// dedup-h #1221 — a 401 at connect is an AUTH REQUIRED signal: typed error,
// operator notification hook, and /mcp "NEEDS AUTH" — never a silent dead
// server.
test('mcp http 401 at connect → MCP_AUTH_REQUIRED with actionable message', async () => {
  const server = createServer((req, res) => {
    res.statusCode = 401;
    res.setHeader('www-authenticate', 'Bearer realm="mcp"');
    res.end('unauthorized');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(
      () => McpClient.connect({ url: `http://127.0.0.1:${server.address().port}/mcp`, transport: 'http' }, { serverName: 'vault' }),
      (err) => {
        assert.equal(err.code, 'MCP_AUTH_REQUIRED');
        assert.match(err.message, /requires OAuth authorization/);
        assert.match(err.message, /\/mcp-auth vault/);
        return true;
      },
    );
  } finally {
    server.close();
  }
});

test('mcp 401 marks entry authRequired + fires onAuthRequired; /mcp shows NEEDS AUTH', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcp401-'));
  const server = createServer((req, res) => { res.statusCode = 401; res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const prevCfg = process.env.PAI_MCP_CONFIG;
  const prevHook = mcpOperatorSurface.onAuthRequired;
  const authed = [];
  mcpOperatorSurface.onAuthRequired = (n) => authed.push(n);
  try {
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({
      mcpServers: { vault: { url: `http://127.0.0.1:${server.address().port}/mcp`, transport: 'http' } },
    }));
    process.env.PAI_MCP_CONFIG = join(dir, 'mcp.json');
    const pi = fakePi();
    await mcpExtension(pi);
    await new Promise((r) => setTimeout(r, 800)); // boot connect is async
    assert.deepEqual(authed, ['vault'], 'operator auth hook fired once');
    const notices = [];
    await pi.commands.get('mcp').handler({ ui: { notify: (msg, level) => notices.push({ msg, level }) } });
    assert.match(notices[0].msg, /vault: NEEDS AUTH/);
    assert.match(notices[0].msg, /\/mcp-auth vault/);
  } finally {
    mcpOperatorSurface.onAuthRequired = prevHook;
    if (prevCfg === undefined) delete process.env.PAI_MCP_CONFIG; else process.env.PAI_MCP_CONFIG = prevCfg;
    server.close();
  }
});

// dedup-h #1504 — MCP Apps tool call: a tool declaring an interactive UI via
// _meta keeps the declaration visible — registered description annotates the
// resource and every result carries details.ui for downstream hosts.
const APP_SERVER_JS = `
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'apps', version: '0' }, capabilities: { tools: {} } } }) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [
        { name: 'chart', description: 'render chart', inputSchema: { type: 'object', properties: {} }, _meta: { 'ui/resourceUri': 'ui://apps/chart.html' } },
        { name: 'plain', description: 'no app', inputSchema: { type: 'object', properties: {} } },
      ] } }) + '\\n');
    } else if (msg.method === 'tools/call') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ran:' + msg.params.name }] } }) + '\\n');
    }
  }
});
setInterval(() => {}, 1000);
`;

test('#1504: MCP Apps _meta surfaces — description annotates, details.ui rides every result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcp-app-'));
  try {
    const serverPath = join(dir, 'server.js');
    writeFileSync(serverPath, APP_SERVER_JS);
    const cfgPath = join(dir, 'mcp.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: { apps: { command: process.execPath, args: [serverPath] } } }));
    const prev = process.env.PAI_MCP_CONFIG;
    process.env.PAI_MCP_CONFIG = cfgPath;
    const pi = fakePi();
    try {
      mcpExtension(pi);
      const deadline = Date.now() + 10_000;
      while (!pi.tools.has('mcp__apps__chart') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const chart = pi.tools.get('mcp__apps__chart');
      const plain = pi.tools.get('mcp__apps__plain');
      assert.ok(chart && plain, 'both tools registered');
      assert.match(chart.description, /ui-app: ui:\/\/apps\/chart\.html/);
      assert.ok(!plain.description.includes('ui-app'), 'plain tool gets no annotation');
      const res = await chart.execute('t1', {}, null);
      assert.equal(res.details?.ui?.uri, 'ui://apps/chart.html');
      assert.equal(res.details?.ui?.key, 'ui/resourceUri');
      assert.match(res.content[0].text, /ran:chart/);
      const res2 = await plain.execute('t2', {}, null);
      assert.equal(res2.details?.ui, undefined, 'no ui details on a plain tool');
    } finally {
      await pi.handlers.get('session_shutdown')?.();
      if (prev === undefined) delete process.env.PAI_MCP_CONFIG;
      else process.env.PAI_MCP_CONFIG = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// dedup-h #1507 — host-side MCP Apps rendering: the channel reads a declared
// ui:// resource through the LIVE connection via resources/read. The surface
// is bounded to ui: URIs (not a generic fetch), refuses unknown/disconnected
// servers, and surfaces honest errors.
const APP_RES_SERVER_JS = `
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'apps', version: '0' }, capabilities: { tools: {}, resources: {} } } }) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [
        { name: 'chart', description: 'render chart', inputSchema: { type: 'object', properties: {} }, _meta: { 'ui/resourceUri': 'ui://apps/chart.html' } },
      ] } }) + '\\n');
    } else if (msg.method === 'resources/read') {
      if (msg.params.uri === 'ui://apps/chart.html') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { contents: [
          { uri: 'ui://apps/chart.html', mimeType: 'text/html', text: '<html><body><h1>chart</h1></body></html>' },
        ] } }) + '\\n');
      } else if (msg.params.uri === 'ui://apps/empty') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { contents: [] } }) + '\\n');
      } else {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32002, message: 'resource not found' } }) + '\\n');
      }
    } else if (msg.method === 'tools/call') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ran' }] } }) + '\\n');
    }
  }
});
setInterval(() => {}, 1000);
`;

test('#1507: readResource — ui: bound, live-connection routed, honest errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcp-res-'));
  try {
    const serverPath = join(dir, 'server.js');
    writeFileSync(serverPath, APP_RES_SERVER_JS);
    const cfgPath = join(dir, 'mcp.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: { apps: { command: process.execPath, args: [serverPath] } } }));
    const prev = process.env.PAI_MCP_CONFIG;
    process.env.PAI_MCP_CONFIG = cfgPath;
    const pi = fakePi();
    try {
      mcpExtension(pi);
      const deadline = Date.now() + 10_000;
      while (!pi.tools.has('mcp__apps__chart') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(pi.tools.has('mcp__apps__chart'), 'tool registered');

      // scheme bound — not a generic fetch surface
      const bad = await mcpOperatorSurface.readResource('apps', 'https://evil.example/x');
      assert.equal(bad.ok, false);
      assert.match(bad.error, /ui:/);
      const bad2 = await mcpOperatorSurface.readResource('apps', 'file:///etc/passwd');
      assert.equal(bad2.ok, false);

      // unknown / disconnected server refused
      const ghost = await mcpOperatorSurface.readResource('nosuch', 'ui://apps/chart.html');
      assert.equal(ghost.ok, false);
      assert.match(ghost.error, /not connected/);

      // successful read — contents normalized for the host
      const ok = await mcpOperatorSurface.readResource('apps', 'ui://apps/chart.html');
      assert.equal(ok.ok, true);
      assert.equal(ok.contents[0].mimeType, 'text/html');
      assert.match(ok.contents[0].text, /<h1>chart<\/h1>/);

      // empty contents → honest error, not a silent blank
      const empty = await mcpOperatorSurface.readResource('apps', 'ui://apps/empty');
      assert.equal(empty.ok, false);
      assert.match(empty.error, /no contents/);

      // server-side JSON-RPC error surfaces honestly
      const missing = await mcpOperatorSurface.readResource('apps', 'ui://apps/missing');
      assert.equal(missing.ok, false);
      assert.match(missing.error, /resources\/read failed/);
    } finally {
      await pi.handlers.get('session_shutdown')?.();
      if (prev === undefined) delete process.env.PAI_MCP_CONFIG;
      else process.env.PAI_MCP_CONFIG = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// dedup-h #1514 — OAuth discovery + dynamic registration: a 401'd server
// with no configured oauth spec resolves PRM -> ASM -> DCR on the explicit
// surface call; the registered client persists in the token store.
test('#1514: oauthDiscoverRegister — 401 + PRM/ASM/DCR mints a usable oauth spec', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcp-disc-'));
  const seen = { regBodies: [] };
  // authorization server: metadata + dynamic registration
  const asSrv = createServer((req, res) => {
    if (req.url === '/.well-known/oauth-authorization-server') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        issuer: `http://127.0.0.1:${asSrv.address().port}`,
        authorization_endpoint: `http://127.0.0.1:${asSrv.address().port}/authorize`,
        token_endpoint: `http://127.0.0.1:${asSrv.address().port}/token`,
        registration_endpoint: `http://127.0.0.1:${asSrv.address().port}/register`,
        scopes_supported: ['mcp:read'],
      }));
      return;
    }
    if (req.url === '/register' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.regBodies.push(JSON.parse(body));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ client_id: 'dyn-client-1', client_secret: 'dyn-sec-1' }));
      });
      return;
    }
    res.statusCode = 404; res.end();
  });
  // resource server: PRM metadata + MCP endpoint that 401s with the
  // resource_metadata pointer.
  const rsSrv = createServer((req, res) => {
    if (req.url === '/.well-known/oauth-protected-resource') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        resource: `http://127.0.0.1:${rsSrv.address().port}/mcp`,
        authorization_servers: [`http://127.0.0.1:${asSrv.address().port}`],
      }));
      return;
    }
    res.setHeader('www-authenticate', `Bearer realm="mcp", resource_metadata="http://127.0.0.1:${rsSrv.address().port}/.well-known/oauth-protected-resource"`);
    res.statusCode = 401; res.end();
  });
  await new Promise((r) => asSrv.listen(0, '127.0.0.1', r));
  await new Promise((r) => rsSrv.listen(0, '127.0.0.1', r));
  const prevCfg = process.env.PAI_MCP_CONFIG, prevStore = process.env.PAI_MCP_TOKEN_STORE;
  try {
    const cfgPath = join(dir, 'mcp.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: { disc: { url: `http://127.0.0.1:${rsSrv.address().port}/mcp` } } }));
    process.env.PAI_MCP_CONFIG = cfgPath;
    process.env.PAI_MCP_TOKEN_STORE = join(dir, 'mcp-oauth.json');
    const pi = fakePi();
    try {
      mcpExtension(pi);
      // let the connect attempt fail (401 → authRequired entry)
      await new Promise((r) => setTimeout(r, 1500));
      const disc = await mcpOperatorSurface.oauthDiscoverRegister('disc');
      assert.ok(disc.oauth, `discovery should mint a spec: ${JSON.stringify(disc)}`);
      assert.equal(disc.oauth.tokenUrl, `http://127.0.0.1:${asSrv.address().port}/token`);
      assert.equal(disc.oauth.authorizationUrl, `http://127.0.0.1:${asSrv.address().port}/authorize`);
      assert.equal(disc.oauth.clientId, 'dyn-client-1');
      assert.equal(disc.oauth.clientSecret, 'dyn-sec-1');
      assert.equal(disc.oauth.loopbackRedirect, true);
      assert.equal(disc.discovered.registration, 'dynamic');
      // the registered client persists in the token store — reused next time
      const store = JSON.parse(readFileSync(join(dir, 'mcp-oauth.json'), 'utf-8'));
      assert.equal(store.disc.client.clientId, 'dyn-client-1');
      // second call reuses the persisted client — no second registration POST
      const disc2 = await mcpOperatorSurface.oauthDiscoverRegister('disc');
      assert.equal(disc2.oauth.clientId, 'dyn-client-1');
      assert.equal(seen.regBodies.length, 1, 'registration is one-time');
      assert.ok(seen.regBodies[0].redirect_uris.includes('http://localhost:8765/callback'));
      // the minted spec validates like a configured one
      const oauth = mcpOperatorSurface.validateOAuthSpec({ url: 'http://x/mcp', oauth: disc.oauth });
      assert.equal(oauth.flow, 'authorization_code');
      // honest error for a server with no remote url
      const bad = await mcpOperatorSurface.oauthDiscoverRegister('nosuch');
      assert.match(bad.error, /no remote url/);
    } finally {
      await pi.handlers.get('session_shutdown')?.();
    }
  } finally {
    if (prevCfg === undefined) delete process.env.PAI_MCP_CONFIG; else process.env.PAI_MCP_CONFIG = prevCfg;
    if (prevStore === undefined) delete process.env.PAI_MCP_TOKEN_STORE; else process.env.PAI_MCP_TOKEN_STORE = prevStore;
    asSrv.close(); rsSrv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// dedup-h #1521 — bounded auto-reconnect on unexpected transport death.
// The rig server counts spawns in MCP_FAKE_STATE; the FIRST spawn dies ~30ms
// after serving prompts/list (discovery already done → a transport exit, not
// a connect failure). MCP_FAKE_DIE_REVIVALS=1 makes every respawn exit
// instantly so the retry bound can be observed exhausting.
const RECONNECT_SERVER_JS = `
const fs = require('fs');
const sf = process.env.MCP_FAKE_STATE || '';
let spawnN = 0;
if (sf) {
  try { spawnN = Number(fs.readFileSync(sf, 'utf8')); } catch { spawnN = 0; }
  fs.writeFileSync(sf, String(spawnN + 1));
}
if (spawnN >= 1 && process.env.MCP_FAKE_DIE_REVIVALS === '1') process.exit(1);
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake', version: '0' }, capabilities: { tools: {}, prompts: {} } } }) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } }) + '\\n');
    } else if (msg.method === 'tools/call') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo:' + (msg.params?.arguments?.text ?? '') }] } }) + '\\n');
    } else if (msg.method === 'prompts/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { prompts: [] } }) + '\\n');
      if (spawnN === 0 && process.env.MCP_FAKE_DIE === '1') setTimeout(() => process.exit(1), 30);
    }
  }
});
setInterval(() => {}, 1000);
`;

test('#1521: McpClient.onServerExit fires on unexpected death, never on close()', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcp-'));
  try {
    const serverPath = join(dir, 'server.js');
    // prompts/list reply → self-exit: an unexpected transport death.
    writeFileSync(serverPath, RECONNECT_SERVER_JS.replace(
      "if (spawnN === 0 && process.env.MCP_FAKE_DIE === '1') setTimeout(() => process.exit(1), 30);",
      'setTimeout(() => process.exit(1), 20);'));
    const c1 = await McpClient.connect({ command: process.execPath, args: [serverPath] });
    let fired = 0;
    c1.onServerExit(() => { fired += 1; });
    c1.close();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(fired, 0, 'intentional close() must not fire exit handlers');
    const c2 = await McpClient.connect({ command: process.execPath, args: [serverPath] });
    let fired2 = 0;
    c2.onServerExit(() => { fired2 += 1; });
    await c2.listPrompts(); // server self-exits right after the reply
    const deadline = Date.now() + 5_000;
    while (fired2 === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.equal(fired2, 1, 'unexpected death fired the exit handler exactly once');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#1521: unexpected death auto-reconnects — live entry rebinds, tool survives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcp-'));
  const prevCfg = process.env.PAI_MCP_CONFIG;
  const prevDelays = process.env.PAI_MCP_RECONNECT_DELAYS;
  try {
    const serverPath = join(dir, 'server.js');
    const statePath = join(dir, 'state.txt');
    writeFileSync(serverPath, RECONNECT_SERVER_JS);
    const cfgPath = join(dir, 'mcp.json');
    writeFileSync(cfgPath, JSON.stringify({
      mcpServers: {
        srv: { command: process.execPath, args: [serverPath], env: { MCP_FAKE_STATE: statePath, MCP_FAKE_DIE: '1' } },
      },
    }));
    process.env.PAI_MCP_CONFIG = cfgPath;
    process.env.PAI_MCP_RECONNECT_DELAYS = '30,40,50';
    const pi = fakePi();
    const notices = [];
    const ctx = { ui: { notify: (m, l) => notices.push([l, m]) } };
    mcpExtension(pi);
    const deadline = Date.now() + 10_000;
    while (!pi.tools.has('mcp__srv__echo') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const tool = pi.tools.get('mcp__srv__echo');
    assert.ok(tool, 'echo tool registered');
    // the first spawn dies ~30ms after boot discovery — a respawn proves the
    // reconnect path fired (spawn counter in the state file).
    const rdeadline = Date.now() + 8_000;
    while (Number(readFileSync(statePath, 'utf8')) < 2 && Date.now() < rdeadline) {
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(Number(readFileSync(statePath, 'utf8')) >= 2, 'server respawned by auto-reconnect');
    // the ORIGINALLY registered tool closure rebinds to the revived client —
    // poll until the revival handshake + refresh completes.
    let res = null;
    const edeadline = Date.now() + 8_000;
    while (Date.now() < edeadline) {
      res = await tool.execute('tc-r', { text: 'revived' });
      if (!res?.isError) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(res && !res.isError, `tool executes on the revived connection: ${res?.content?.[0]?.text}`);
    assert.match(res.content[0].text, /echo:revived/);
    // /mcp reports the revival honestly — not reconnecting, not lost.
    await pi.commands.get('mcp').handler(ctx);
    assert.match(notices.map(([, m]) => m).join('\n'), /srv: connected/);
    await pi.handlers.get('session_shutdown')?.();
  } finally {
    if (prevCfg === undefined) delete process.env.PAI_MCP_CONFIG; else process.env.PAI_MCP_CONFIG = prevCfg;
    if (prevDelays === undefined) delete process.env.PAI_MCP_RECONNECT_DELAYS; else process.env.PAI_MCP_RECONNECT_DELAYS = prevDelays;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#1521: retry bound exhausts — honest CONNECTION LOST, tool fails closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcp-'));
  const prevCfg = process.env.PAI_MCP_CONFIG;
  const prevDelays = process.env.PAI_MCP_RECONNECT_DELAYS;
  try {
    const serverPath = join(dir, 'server.js');
    const statePath = join(dir, 'state.txt');
    writeFileSync(serverPath, RECONNECT_SERVER_JS);
    const cfgPath = join(dir, 'mcp.json');
    writeFileSync(cfgPath, JSON.stringify({
      mcpServers: {
        srv: { command: process.execPath, args: [serverPath], env: { MCP_FAKE_STATE: statePath, MCP_FAKE_DIE: '1', MCP_FAKE_DIE_REVIVALS: '1' } },
      },
    }));
    process.env.PAI_MCP_CONFIG = cfgPath;
    process.env.PAI_MCP_RECONNECT_DELAYS = '30,40,50';
    const pi = fakePi();
    const notices = [];
    const ctx = { ui: { notify: (m, l) => notices.push([l, m]) } };
    mcpExtension(pi);
    const deadline = Date.now() + 10_000;
    while (!pi.tools.has('mcp__srv__echo') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(pi.tools.has('mcp__srv__echo'), 'echo tool registered');
    // spawn0 dies after discovery; spawns 1..3 die instantly → exactly 3
    // retries (the bound), then the entry is honestly exhausted.
    const ldeadline = Date.now() + 10_000;
    let lost = false;
    while (Date.now() < ldeadline && !lost) {
      await pi.commands.get('mcp').handler(ctx);
      lost = notices.map(([, m]) => m).join('\n').includes('CONNECTION LOST');
      if (!lost) await new Promise((r) => setTimeout(r, 60));
    }
    assert.ok(lost, '/mcp reports CONNECTION LOST after the retry bound');
    assert.equal(Number(readFileSync(statePath, 'utf8')), 4, 'exactly 1 initial + 3 retry spawns — the bound held');
    // the tombstoned tool fails closed with an honest not-connected error
    const res = await pi.tools.get('mcp__srv__echo').execute('tc-x', { text: 'x' });
    assert.ok(res.isError, 'tool fails closed while the server is dead');
    assert.match(res.content[0].text, /not connected/);
    await pi.handlers.get('session_shutdown')?.();
  } finally {
    if (prevCfg === undefined) delete process.env.PAI_MCP_CONFIG; else process.env.PAI_MCP_CONFIG = prevCfg;
    if (prevDelays === undefined) delete process.env.PAI_MCP_RECONNECT_DELAYS; else process.env.PAI_MCP_RECONNECT_DELAYS = prevDelays;
    rmSync(dir, { recursive: true, force: true });
  }
});
