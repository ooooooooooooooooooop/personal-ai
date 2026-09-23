/** dedup-h #242 — expose-self-as-MCP-server: newline JSON-RPC surface
 * dispatching into the REAL governed channel. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, PassThrough } from 'node:stream';
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpRpc, serveMcp } from '../src/serve/mcpserve.js';
import { startHost } from '../src/bootstrap/host.js';

const stubModel = { provider: 'stub', id: 'stub-1', name: 'stub' };

const boot = async () => {
  const inst = mkdtempSync(join(tmpdir(), 'pai-mcps-'));
  mkdirSync(join(inst, 'canonical'), { recursive: true });
  writeFileSync(join(inst, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  return startHost({ instanceRoot: inst, workdir: inst, sessionOptions: { model: stubModel } });
};

test('mcp-serve: initialize/tools-list/tools-call dispatch to the governed channel', async () => {
  const host = await boot();
  try {
    const init = await handleMcpRpc(host, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    assert.equal(init.result.serverInfo.name, 'personal-ai');
    assert.ok(init.result.capabilities.tools);

    const list = await handleMcpRpc(host, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes('session_prompt') && names.includes('get_state')
      && names.includes('audit_tail') && names.includes('job_status'));

    const st = await handleMcpRpc(host, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_state', arguments: {} } });
    const state = JSON.parse(st.result.content[0].text);
    assert.ok(state.model || state.session !== undefined, 'state rides the real channel');

    const bad = await handleMcpRpc(host, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } });
    assert.match(bad.error.message, /unknown tool/);

    const tail = await handleMcpRpc(host, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'audit_tail', arguments: { n: 5 } } });
    const rows = JSON.parse(tail.result.content[0].text);
    assert.ok(rows.events.length > 0, 'audit rows flow through');
  } finally { host.dispose(); }
});

test('mcp-serve: stdio loop answers initialize and stays silent on notifications', async () => {
  const host = await boot();
  try {
    const out = new PassThrough();
    const lines = [];
    out.on('data', (c) => lines.push(...c.toString().split('\n').filter(Boolean)));
    const input = Readable.from([
      '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n',
      '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
      'not-json\n',
      '{"jsonrpc":"2.0","id":2,"method":"ping"}\n',
    ]);
    await serveMcp(host, { stdin: input, stdout: out });
    const msgs = lines.map(JSON.parse);
    assert.equal(msgs[0].result.serverInfo.name, 'personal-ai');
    assert.equal(msgs[1].error.code, -32700, 'parse error reported');
    assert.deepEqual(msgs[2].result, {}, 'ping answered');
    assert.equal(msgs.length, 3, 'notification produced no response');
  } finally { host.dispose(); }
});
