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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import mcpExtension, { McpClient, sanitizeSpecEnv } from '../extensions/mcp/index.js';
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
