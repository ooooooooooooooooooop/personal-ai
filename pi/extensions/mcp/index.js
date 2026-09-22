/**
 * MCP managed extension — bridges MCP servers into the governed tool surface.
 *
 * Config discovery (first hit wins):
 *   1. $PAI_MCP_CONFIG — absolute path to a JSON config file
 *   2. <cwd>/.pai/mcp.json
 *   3. <cwd>/.mcp.json        (Claude Code / Cursor convention)
 *
 * Config shape: { "mcpServers": { "<name>": <spec> } } where spec is either
 *   { "command": "…", "args": […], "env": {…} }          → stdio transport
 *   { "url": "http://…", "headers": {…} }                → Streamable HTTP
 *
 * Every discovered tool registers as `mcp__<server>__<tool>`. That name
 * prefix is load-bearing for governance:
 *   - policy 'mcp__*' prefix rules gate every call through the operator ask
 *   - the decide chain treats mcp__ tools as opaque external effects
 *     (mutating-capable: they hold the workspace write lease, and plan mode
 *     escalates them)
 * Results are wrapped in <untrusted mcp_server="…" mcp_tool="…"> so the
 * standing untrusted-content rule applies — MCP output is data, never
 * instructions.
 *
 * A server that fails to connect or handshake registers nothing — broken
 * capability is never advertised (deny→hide consistent). Per-capability
 * failures are NOT fatal: tools/list and prompts/list discover independently
 * so prompt-only and tools-only servers both expose what they have.
 * notifications/tools|prompts/list_changed hot-refresh the surface (stdio
 * only — HTTP transport carries no push channel); newly listed tools register
 * live, removed tools tombstone into honest errors since pi has no
 * unregisterTool.
 *
 * The client below is zero-dependency. stdio framing is newline-delimited
 * JSON-RPC 2.0; Streamable HTTP is one POST per request answered as JSON or
 * SSE (server→client GET SSE is intentionally unsupported in v1). Server
 * specs may carry secrets — nothing here logs env/argv.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'personal-ai', version: '1' };
const DEFAULT_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;
const TOOL_TIMEOUT_MS = 120_000;
const MAX_RESULT_CHARS = 24_000;

export class McpError extends Error {
  constructor(message, { code = 'MCP_ERROR' } = {}) {
    super(message);
    this.code = code;
  }
}

// A2 env sanitization: spec.env merges over process.env for stdio servers,
// and workdir configs (.pai/mcp.json, .mcp.json) are agent-reachable after a
// single approved write. Keys that bootstrap code into the runtime or hijack
// resolution/traffic turn a benign "command": "node server.js" into silent
// code exec outside the decide chain — NODE_OPTIONS=--require ./payload.js,
// PATH redirection, LD_PRELOAD, proxy rerouting. They are stripped at the
// spawn boundary and reported in /mcp; an operator who genuinely needs one
// sets it in their own environment instead.
const ENV_INJECT_RE = /^(?:NODE_OPTIONS|NODE_EXTRA_CA_CERTS|NODE_PATH|PATH|PATHEXT|COMSPEC|LD_[A-Z0-9_]+|DYLD_[A-Z0-9_]+|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PYTHONINSPECT|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|BASH_ENV|ENV|CDPATH|GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|SSH_ASKPASS|GIT_EXTERNAL_DIFF|GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS|GIT_EDITOR|EDITOR|VISUAL|PAGER|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|NPM_CONFIG_[A-Z0-9_]*)$/i;

export function sanitizeSpecEnv(env) {
  if (!env || typeof env !== 'object') return { env: undefined, stripped: [] };
  const out = {};
  const stripped = [];
  for (const [k, v] of Object.entries(env)) {
    if (ENV_INJECT_RE.test(k)) { stripped.push(k); continue; }
    out[k] = v;
  }
  return { env: out, stripped };
}

function stdioTransport(spec) {
  const { env: specEnv, stripped } = sanitizeSpecEnv(spec.env);
  const child = spawn(spec.command, spec.args ?? [], {
    // the operator's own environment is the trust boundary for stdio servers
    env: { ...process.env, ...(specEnv ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pending = { onMessage: null, onExit: null };
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        pending.onMessage?.(JSON.parse(line));
      } catch {
        // non-JSON noise on stdout violates the protocol but must not kill the pump
      }
    }
  });
  child.on('exit', (code) => pending.onExit?.(code));
  child.on('error', () => pending.onExit?.(-1));
  // EPIPE arrives via the stream's error event, not a synchronous throw —
  // swallow it: a dead child's write failure is already covered by onExit.
  child.stdin.on('error', () => {});
  return {
    kind: 'stdio',
    send: (msg) => {
      if (child.killed || child.stdin.destroyed) return;
      try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch { /* pipe already gone */ }
    },
    onMessage: (fn) => { pending.onMessage = fn; },
    onExit: (fn) => { pending.onExit = fn; },
    close: () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } },
    strippedEnv: stripped,
  };
}

function parseSseBlock(text) {
  const data = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return data.length ? data.join('\n') : null;
}

function httpTransport(spec) {
  let sessionId = null;
  const post = async (msg, signal) => {
    const res = await fetch(spec.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        ...(spec.headers ?? {}),
      },
      body: JSON.stringify(msg),
      signal,
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    return res;
  };
  const readResponse = async (res) => {
    if (res.status === 202 || res.status === 204) return null; // notification ack
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('text/event-stream')) {
      const text = await res.text();
      // last JSON-RPC message in the stream wins (progress frames precede it)
      let last = null;
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = parseSseBlock(block);
        if (!data) continue;
        try { last = JSON.parse(data); } catch { /* skip malformed frame */ }
      }
      return last;
    }
    return res.json();
  };
  return {
    kind: 'http',
    onMessage: () => {}, // no push channel in v1
    onExit: () => {},
    callHttp: async (msg, signal) => readResponse(await post(msg, signal)),
    notify: async (msg) => { await post(msg).catch(() => {}); },
    close: () => {},
  };
}

export class McpClient {
  #transport;
  #nextId = 1;
  #pending = new Map();
  #closed = false;
  #notifyHandlers = [];

  constructor(transport) {
    this.#transport = transport;
    transport.onMessage?.((msg) => this.#dispatch(msg));
    transport.onExit?.(() => this.#failAll(new McpError('mcp server process exited', { code: 'MCP_EXIT' })));
  }

  /**
   * M130: subscribe to server→client notifications (tools/list_changed,
   * prompts/list_changed). stdio carries them as id-less JSON-RPC frames;
   * the HTTP transport has no push channel in v1 so no notifications ever
   * arrive there — handlers just never fire.
   */
  onNotification(fn) { this.#notifyHandlers.push(fn); }

  static async connect(spec, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const transport = spec.url ? httpTransport(spec) : stdioTransport(spec);
    const client = new McpClient(transport);
    client.strippedEnv = transport.strippedEnv ?? [];
    await client.initialize({ timeoutMs });
    return client;
  }

  #dispatch(msg) {
    if (msg == null || typeof msg !== 'object') return;
    // Server→client notification: has method, no id. Server requests
    // (method + id) are unsupported — we carry no server->client request
    // handlers, so dropping them is the honest no-op.
    if (msg.id == null) {
      if (typeof msg.method === 'string') {
        for (const fn of this.#notifyHandlers) {
          try { fn(msg); } catch { /* a bad handler must not kill the pump */ }
        }
      }
      return;
    }
    const entry = this.#pending.get(msg.id);
    if (!entry) return;
    this.#pending.delete(msg.id);
    if (msg.error) {
      entry.reject(new McpError(msg.error.message ?? 'mcp error', { code: `MCP_${msg.error.code ?? 'ERR'}` }));
    } else {
      entry.resolve(msg.result);
    }
  }

  #failAll(err) {
    this.#closed = true;
    for (const [, entry] of this.#pending) entry.reject(err);
    this.#pending.clear();
  }

  async initialize({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const msg = {
      jsonrpc: '2.0', id: this.#nextId++, method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
    };
    const result = this.#transport.kind === 'http'
      ? await this.#requestHttp(msg, { timeoutMs })
      : await this.#requestStdio(msg, { timeoutMs });
    const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
    if (this.#transport.kind === 'http') {
      await this.#transport.notify(initialized);
    } else {
      this.#transport.send(initialized);
    }
    this.serverInfo = result;
    return result;
  }

  #requestStdio(msg, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
    if (this.#closed) return Promise.reject(new McpError('mcp client closed', { code: 'MCP_CLOSED' }));
    const id = msg.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new McpError(`mcp '${msg.method}' timed out`, { code: 'MCP_TIMEOUT' }));
      }, timeoutMs);
      const onAbort = () => {
        if (!this.#pending.has(id)) return;
        this.#pending.delete(id);
        clearTimeout(timer);
        try {
          this.#transport.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'aborted' } });
        } catch { /* best effort */ }
        reject(new McpError(`mcp '${msg.method}' aborted`, { code: 'MCP_ABORTED' }));
      };
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.#pending.set(id, {
        resolve: (v) => { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); resolve(v); },
        reject: (e) => { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); reject(e); },
      });
      try {
        this.#transport.send(msg);
      } catch (err) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async #requestHttp(msg, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
    if (this.#closed) throw new McpError('mcp client closed', { code: 'MCP_CLOSED' });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const onAbort = async () => {
      ac.abort();
      try {
        await this.#transport.notify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: msg.id, reason: 'aborted' } });
      } catch { /* best effort */ }
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        throw new McpError(`mcp '${msg.method}' aborted`, { code: 'MCP_ABORTED' });
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const res = await this.#transport.callHttp(msg, ac.signal);
      if (res?.error) throw new McpError(res.error.message ?? 'mcp error', { code: `MCP_${res.error.code ?? 'ERR'}` });
      return res?.result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  request(method, params, opts = {}) {
    const msg = { jsonrpc: '2.0', id: this.#nextId++, method, params };
    return this.#transport.kind === 'http'
      ? this.#requestHttp(msg, opts)
      : this.#requestStdio(msg, opts);
  }

  async listTools() {
    const out = [];
    let cursor;
    do {
      const res = await this.request('tools/list', cursor ? { cursor } : {});
      out.push(...(res?.tools ?? []));
      cursor = res?.nextCursor;
    } while (cursor);
    return out;
  }

  callTool(name, args, { signal, timeoutMs } = {}) {
    return this.request('tools/call', { name, arguments: args ?? {} }, { signal, timeoutMs });
  }

  async listPrompts() {
    const out = [];
    let cursor;
    do {
      const res = await this.request('prompts/list', cursor ? { cursor } : {});
      out.push(...(res?.prompts ?? []));
      cursor = res?.nextCursor;
    } while (cursor);
    return out;
  }

  getPrompt(name, args = {}, { timeoutMs } = {}) {
    return this.request('prompts/get', { name, arguments: args }, { timeoutMs });
  }

  close() {
    this.#closed = true;
    try { this.#transport.close(); } catch { /* best effort */ }
    this.#failAll(new McpError('mcp client closed', { code: 'MCP_CLOSED' }));
  }
}

// ---------------------------------------------------------------------------
// extension factory
// ---------------------------------------------------------------------------

function loadConfig() {
  const candidates = [];
  if (process.env.PAI_MCP_CONFIG) candidates.push(process.env.PAI_MCP_CONFIG);
  const cwd = process.cwd();
  candidates.push(join(cwd, '.pai', 'mcp.json'), join(cwd, '.mcp.json'));
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const doc = JSON.parse(readFileSync(path, 'utf-8'));
      return { path, servers: doc?.mcpServers ?? doc?.servers ?? {} };
    } catch {
      return { path, servers: {}, error: 'unparseable config' };
    }
  }
  return { path: null, servers: {} };
}

function wrapUntrusted(server, tool, result) {
  const content = (result?.content ?? []).map((c) => {
    if (c?.type === 'text' && typeof c.text === 'string') {
      const text = c.text.length > MAX_RESULT_CHARS
        ? `${c.text.slice(0, MAX_RESULT_CHARS)}\n[truncated at ${MAX_RESULT_CHARS} chars]`
        : c.text;
      return {
        type: 'text',
        text: `<untrusted mcp_server="${server}" mcp_tool="${tool}">\n${text}\n</untrusted>`,
      };
    }
    return c; // image/resource payloads pass through untouched
  });
  return {
    content,
    isError: result?.isError === true,
    details: { mcpServer: server, mcpTool: tool, structured: result?.structuredContent ?? null },
  };
}

export default function mcpExtension(pi) {
  const { path: configPath, servers, error: configError } = loadConfig();
  /** @type {Map<string, {client:McpClient|null, tools:string[], spec:object, failed?:boolean, prompts?:object[], dead?:Set<string>, lastRefresh?:object}>} */
  const connected = new Map();

  // M130 tools/list_changed: a server that hot-swaps its catalog re-lists.
  // New tools register live; REMOVED tools cannot be unregistered through the
  // pi API — they tombstone into an honest fail-closed error instead of
  // silently calling a tool the server no longer advertises.
  const registerMcpTool = (serverName, client, entry, t) => {
    const toolName = `mcp__${serverName}__${t.name}`;
    pi.registerTool({
      name: toolName,
      label: `MCP ${serverName}: ${t.name}`,
      description: `[mcp:${serverName}] ${t.description ?? t.name}`,
      // MCP inputSchema is JSON Schema — the same shape pi-ai validates
      // for our other custom tools.
      parameters: t.inputSchema && typeof t.inputSchema === 'object'
        ? t.inputSchema
        : { type: 'object', properties: {} },
      async execute(toolCallId, params, signal) {
        if (entry.dead?.has(toolName)) {
          return {
            content: [{ type: 'text', text: `mcp tool removed by server '${serverName}' (list_changed) — restart the session or re-check /mcp` }],
            isError: true,
          };
        }
        try {
          const res = await client.callTool(t.name, params, { signal, timeoutMs: TOOL_TIMEOUT_MS });
          return wrapUntrusted(serverName, t.name, res);
        } catch (err) {
          return {
            content: [{ type: 'text', text: `mcp call failed (${serverName}/${t.name}): ${err?.message ?? err}` }],
            isError: true,
          };
        }
      },
    });
    return toolName;
  };

  const refreshTools = async (name, entry) => {
    if (!entry?.client) return;
    try {
      const fresh = await entry.client.listTools();
      const freshNames = new Set(fresh.map((t) => `mcp__${name}__${t.name}`));
      const before = new Set(entry.tools);
      const added = [];
      for (const t of fresh) {
        const tn = `mcp__${name}__${t.name}`;
        if (!before.has(tn)) added.push(registerMcpTool(name, entry.client, entry, t));
      }
      const removed = [...before].filter((tn) => !freshNames.has(tn));
      entry.dead = new Set(removed);
      entry.tools = [...freshNames];
      entry.lastRefresh = { at: new Date().toISOString(), added: added.length, removed: removed.length };
    } catch { /* refresh failure keeps the last-known catalog */ }
  };

  // M82: an MCP prompt is an operator-invoked slash command that expands to
  // the server-supplied messages as a user turn. The operator asked for it
  // explicitly (like Claude Code's /mcp__server__prompt), but the transcript
  // keeps a provenance prefix — server text is still external content.
  const registerPromptCommand = (serverName, prompt, client) => {
    const cmdName = `mcp-${serverName}-${prompt.name}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    pi.registerCommand(cmdName, {
      description: `[mcp:${serverName}] ${prompt.description ?? prompt.name}`,
      handler: async (args, ctx) => {
        const declared = (prompt.arguments ?? []).map((a) => a.name);
        const values = {};
        const positional = [];
        for (const tok of String(args ?? '').split(/\s+/).filter(Boolean)) {
          const eq = tok.indexOf('=');
          if (eq > 0) values[tok.slice(0, eq)] = tok.slice(eq + 1);
          else positional.push(tok);
        }
        declared.forEach((n, i) => { if (values[n] == null && positional[i] != null) values[n] = positional[i]; });
        const missing = (prompt.arguments ?? []).filter((a) => a.required && values[a.name] == null);
        if (missing.length) {
          ctx.ui?.notify?.(`mcp prompt '${prompt.name}' missing required args: ${missing.map((a) => a.name).join(', ')}`, 'error');
          return;
        }
        try {
          const res = await client.getPrompt(prompt.name, values);
          const text = (res?.messages ?? []).map((m) => {
            const c = m?.content;
            return typeof c === 'string' ? c : (c?.type === 'text' ? c.text : '');
          }).filter(Boolean).join('\n');
          if (!text.trim()) {
            ctx.ui?.notify?.(`mcp prompt '${prompt.name}' returned no text`, 'warning');
            return;
          }
          ctx.sendUserMessage(`[mcp prompt ${serverName}/${prompt.name}]\n${text}`);
        } catch (err) {
          ctx.ui?.notify?.(`mcp prompt failed (${serverName}/${prompt.name}): ${err?.message ?? err}`, 'error');
        }
      },
    });
  };

  const boot = (async () => {
    for (const [name, spec] of Object.entries(servers)) {
      if (!spec || typeof spec !== 'object' || (!spec.command && !spec.url)) continue;
      try {
        const client = await McpClient.connect(spec, { timeoutMs: CONNECT_TIMEOUT_MS });
        const entry = { client, tools: [], spec, prompts: [], booted: false };
        connected.set(name, entry);
        // M130: subscribe BEFORE family discovery — a list_changed pushed
        // while tools/list or prompts/list is still in flight (or hung on a
        // server that silently drops unknown methods) must not be lost.
        client.onNotification((msg) => {
          const refresh = async () => {
            if (!entry.booted) { entry.pendingRefresh = true; return; }
            await refreshTools(name, entry);
          };
          const refreshPrompts = async () => {
            if (!entry.booted) { entry.pendingPromptRefresh = true; return; }
            try {
              const prompts = await client.listPrompts();
              const known = new Set((entry.prompts ?? []).map((p) => p.name));
              for (const p of prompts) {
                if (known.has(p.name)) continue;
                entry.prompts.push({ name: p.name, description: p.description ?? null, args: p.arguments ?? [] });
                registerPromptCommand(name, p, client);
              }
            } catch { /* refresh failure keeps the last-known catalog */ }
          };
          if (msg?.method === 'notifications/tools/list_changed') void refresh();
          if (msg?.method === 'notifications/prompts/list_changed') void refreshPrompts();
        });
        // M82: capability families discover independently — a prompt-only
        // server answers Method-not-found on tools/list and that must NOT
        // kill prompts/list (and vice versa). A connect/handshake failure is
        // still fatal; a per-family failure is not.
        const names = [];
        try {
          const tools = await client.listTools();
          for (const t of tools) names.push(registerMcpTool(name, client, entry, t));
          entry.tools = names;
        } catch { /* no tools capability */ }
        try {
          const prompts = await client.listPrompts();
          for (const p of prompts) {
            entry.prompts.push({ name: p.name, description: p.description ?? null, args: p.arguments ?? [] });
            registerPromptCommand(name, p, client);
          }
        } catch { /* no prompts capability */ }
        // discovery done — flush any list_changed that arrived mid-boot
        entry.booted = true;
        if (entry.pendingRefresh) { entry.pendingRefresh = false; void refreshTools(name, entry); }
        if (entry.pendingPromptRefresh) {
          entry.pendingPromptRefresh = false;
          void (async () => {
            try {
              const prompts = await client.listPrompts();
              const known = new Set((entry.prompts ?? []).map((p) => p.name));
              for (const p of prompts) {
                if (known.has(p.name)) continue;
                entry.prompts.push({ name: p.name, description: p.description ?? null, args: p.arguments ?? [] });
                registerPromptCommand(name, p, client);
              }
            } catch { /* refresh failure keeps the last-known catalog */ }
          })();
        }
      } catch {
        // connect/handshake failure → this server contributes no tools;
        // /mcp reports it as failed so the operator can see why
        connected.set(name, { client: null, tools: [], spec, failed: true });
      }
    }
  })();

  pi.on('session_shutdown', () => {
    for (const [, entry] of connected) entry.client?.close();
    connected.clear();
  });

  pi.registerCommand('mcp', {
    description: 'List configured MCP servers, connection state, and tools',
    handler: async (ctx) => {
      await boot;
      const lines = [];
      if (!configPath && !configError) {
        lines.push('no MCP config found (.pai/mcp.json, .mcp.json, or $PAI_MCP_CONFIG)');
      } else {
        lines.push(`config: ${configPath ?? 'unparseable'}`);
      }
      for (const [name, entry] of connected) {
        lines.push(entry.failed
          ? `  ${name}: FAILED to connect/list — no tools exposed`
          : `  ${name}: connected — ${entry.tools.length} tools, ${entry.prompts?.length ?? 0} prompts`);
        if (entry.client?.strippedEnv?.length) lines.push(`    env stripped (injection-vector keys): ${entry.client.strippedEnv.join(', ')}`);
        if (entry.dead?.size) lines.push(`    removed by server (list_changed): ${[...entry.dead].join(', ')}`);
        if (entry.lastRefresh) lines.push(`    last refresh ${entry.lastRefresh.at} (+${entry.lastRefresh.added}/-${entry.lastRefresh.removed})`);
        for (const t of entry.tools) lines.push(`    ${t}`);
        for (const p of entry.prompts ?? []) {
          const req = (p.args ?? []).filter((a) => a.required).map((a) => a.name);
          lines.push(`    /mcp-${name}-${p.name}`.replace(/[^a-zA-Z0-9_\-/]/g, '_') + (req.length ? ` (args: ${req.join(' ')})` : ''));
        }
      }
      if (Object.keys(servers).length === 0 && configPath) lines.push('  (config has no servers)');
      ctx.ui?.notify?.(lines.join('\n'), 'info');
    },
  });
}
