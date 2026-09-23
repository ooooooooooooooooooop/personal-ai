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
import mcpExtension, { McpClient, McpError, sanitizeSpecEnv } from '../extensions/mcp/index.js';
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
  ]) {
    await assert.rejects(() => McpClient.connect(spec), McpError);
  }
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
    const notices = [];
    const ctx = { ui: { notify: (msg, level) => notices.push({ msg, level }) } };
    await pi.commands.get('mcp-auth').handler('remote', ctx);
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
