/**
 * pai mcp-serve — expose THIS host as an MCP server to external clients
 * (dedup-h #242, Claude `mcp serve` analogue).
 *
 * Transport: newline-delimited JSON-RPC on stdin/stdout (MCP stdio).
 * The served surface is the GOVERNED channel — a `session_prompt` call
 * here runs the same decide/hooks/budget chain as an operator prompt.
 * Bounded tool set on purpose: this is a control surface, not a file
 * server — state reads plus the governed prompt/job verbs.
 */

const PROTOCOL_VERSION = '2025-06-18';

const TOOLS = [
  {
    name: 'session_prompt',
    description: 'Send a prompt to the Personal AI session (governed channel — policy/hooks/budget apply).',
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    map: (a) => ({ type: 'prompt', message: String(a.text ?? '') }),
  },
  {
    name: 'get_state',
    description: 'Current session/host state snapshot (model, mode, context usage, proxy posture).',
    inputSchema: { type: 'object', properties: {} },
    map: () => ({ type: 'get_state' }),
  },
  {
    name: 'session_list',
    description: 'List persisted sessions (id, name, message count, live marker).',
    inputSchema: { type: 'object', properties: {} },
    map: () => ({ type: 'session_list' }),
  },
  {
    name: 'job_status',
    description: 'Durable job status by id.',
    inputSchema: { type: 'object', required: ['job_id'], properties: { job_id: { type: 'string' } } },
    map: (a) => ({ type: 'job_status', job_id: String(a.job_id ?? '') }),
  },
  {
    name: 'audit_tail',
    description: 'Last N governance audit rows.',
    inputSchema: { type: 'object', properties: { n: { type: 'integer' } } },
    map: (a) => ({ type: 'audit_tail', n: Number.isFinite(a?.n) ? a.n : 20 }),
  },
];
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/** One JSON-RPC message → response object, or null for notifications. */
export async function handleMcpRpc(host, msg) {
  const id = msg?.id;
  if (id === undefined) return null; // notification — MCP requires silence
  const method = String(msg?.method ?? '');
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: { name: 'personal-ai', version: '0.0.1' },
        capabilities: { tools: { listChanged: false } },
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS.map(({ map, ...def }) => def) });
    case 'tools/call': {
      const tool = BY_NAME.get(String(msg?.params?.name ?? ''));
      if (!tool) return err(id, -32602, `unknown tool '${msg?.params?.name}'`);
      try {
        const r = await host.channel.handle(tool.map(msg?.params?.arguments ?? {}));
        const payload = JSON.stringify(r?.data ?? r, null, 1);
        if (r?.success === false) {
          return reply(id, { content: [{ type: 'text', text: payload }], isError: true });
        }
        return reply(id, { content: [{ type: 'text', text: payload }] });
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: String(e?.message ?? e) }], isError: true });
      }
    }
    default:
      return err(id, -32601, `method not found: ${method}`);
  }
}

/** Drive the newline-JSON-RPC loop until stdin ends. */
export async function serveMcp(host, { stdin = process.stdin, stdout = process.stdout } = {}) {
  let buf = '';
  stdin.setEncoding('utf-8');
  for await (const chunk of stdin) {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { stdout.write(JSON.stringify(err(null, -32700, 'parse error')) + '\n'); continue; }
      const out = await handleMcpRpc(host, msg);
      if (out) stdout.write(JSON.stringify(out) + '\n');
    }
  }
}
