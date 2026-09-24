/**
 * LSP managed extension — read-only language intelligence over stdio LSP
 * servers, behind the governed tool surface.
 *
 * Config discovery (first hit wins):
 *   1. $PAI_LSP_CONFIG — absolute path to a JSON config file
 *   2. <cwd>/.pai/lsp.json
 *
 * Config shape:
 *   { "servers": { "<name>": {
 *       "command": "typescript-language-server", "args": ["--stdio"],
 *       "languages": ["typescript", "javascript"],
 *       "extensions": [".ts", ".tsx", ".js", ".jsx"],
 *       "rootPatterns": ["package.json", "tsconfig.json"]
 *   } } }
 *
 * v1 is READ-ONLY by construction: the only tools exposed are
 * lsp_definition / lsp_references / lsp_hover / lsp_symbols /
 * lsp_diagnostics — no rename, no workspace/applyEdit, no codeAction
 * execute. Governed semantic edits are a later milestone.
 *
 * LSP framing is Content-Length-delimited JSON-RPC (not NDJSON). Servers
 * may send requests (workspace/configuration etc.) — answered with null;
 * publishDiagnostics notifications are collected for lsp_diagnostics.
 * Documents are textDocument/didOpen'd lazily on first query and kept open;
 * session_shutdown closes servers.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, extname, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerContextProvider } from '../../src/adapter/context-providers.js';

const CONNECT_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESULT_CHARS = 16_000;

const LANGUAGE_IDS = {
  '.ts': 'typescript', '.tsx': 'typescriptreact', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascriptreact', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp',
  '.cs': 'csharp', '.rb': 'ruby', '.php': 'php', '.lua': 'lua',
  '.json': 'json', '.md': 'markdown', '.yaml': 'yaml', '.yml': 'yaml',
  '.html': 'html', '.css': 'css', '.sh': 'shellscript', '.vue': 'vue', '.svelte': 'svelte',
};

// ---------------------------------------------------------------------------
// LSP stdio client
// ---------------------------------------------------------------------------

export class LspClient {
  #child;
  #nextId = 1;
  #pending = new Map();
  #buf = Buffer.alloc(0);
  #diagnostics = new Map(); // uri -> diagnostics[]
  #openDocs = new Map();    // uri -> version
  #closed = false;
  #rootUri;

  constructor(child, rootUri) {
    this.#child = child;
    this.#rootUri = rootUri;
    child.stdout.on('data', (chunk) => {
      this.#buf = Buffer.concat([this.#buf, chunk]);
      this.#drain();
    });
    child.on('exit', () => this.#failAll(new Error('lsp server exited')));
    child.on('error', () => this.#failAll(new Error('lsp server spawn failed')));
    child.stdin.on('error', () => {}); // EPIPE after kill is expected
  }

  #drain() {
    for (;;) {
      const headerEnd = this.#buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.#buf.slice(0, headerEnd).toString('utf8');
      const m = /content-length:\s*(\d+)/i.exec(header);
      if (!m) { this.#buf = this.#buf.slice(headerEnd + 4); continue; }
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (this.#buf.length < start + len) return;
      const body = this.#buf.slice(start, start + len).toString('utf8');
      this.#buf = this.#buf.slice(start + len);
      try { this.#onMessage(JSON.parse(body)); } catch { /* malformed frame */ }
    }
  }

  #send(msg) {
    if (this.#child.killed || this.#child.stdin.destroyed) return;
    const body = JSON.stringify(msg);
    try {
      this.#child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    } catch { /* pipe gone */ }
  }

  #onMessage(msg) {
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this.#pending.get(msg.id);
      if (entry) {
        this.#pending.delete(msg.id);
        msg.error ? entry.reject(new Error(msg.error.message ?? 'lsp error')) : entry.resolve(msg.result);
      }
      return;
    }
    if (msg.id != null && msg.method) {
      // server→client request: v1 answers null to everything
      this.#send({ jsonrpc: '2.0', id: msg.id, result: null });
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics') {
      this.#diagnostics.set(msg.params?.uri, msg.params?.diagnostics ?? []);
    }
  }

  #failAll(err) {
    this.#closed = true;
    for (const [, e] of this.#pending) e.reject(err);
    this.#pending.clear();
  }

  request(method, params, { timeoutMs = REQUEST_TIMEOUT_MS, signal } = {}) {
    if (this.#closed) return Promise.reject(new Error('lsp client closed'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`lsp '${method}' timed out`));
      }, timeoutMs);
      const onAbort = () => {
        if (!this.#pending.has(id)) return;
        this.#pending.delete(id);
        clearTimeout(timer);
        this.#send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } });
        reject(new Error(`lsp '${method}' aborted`));
      };
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.#pending.set(id, {
        resolve: (v) => { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); resolve(v); },
        reject: (e) => { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); reject(e); },
      });
      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.#send({ jsonrpc: '2.0', method, params });
  }

  /** Open the document if not already open — servers require didOpen first. */
  async ensureOpen(filePath, languageId) {
    const uri = pathToFileURL(resolve(filePath)).href;
    if (this.#openDocs.has(uri)) return uri;
    const text = readFileSync(filePath, 'utf8');
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text },
    });
    this.#openDocs.set(uri, 1);
    // give the server a beat to index the fresh doc before position queries
    await new Promise((r) => setTimeout(r, 150));
    return uri;
  }

  diagnosticsFor(filePath) {
    return this.#diagnostics.get(pathToFileURL(resolve(filePath)).href) ?? [];
  }

  allDiagnostics() {
    const out = {};
    for (const [uri, diags] of this.#diagnostics) {
      if (diags.length) out[uri] = diags;
    }
    return out;
  }

  close() {
    this.#closed = true;
    try {
      this.#send({ jsonrpc: '2.0', id: this.#nextId++, method: 'shutdown' });
      this.#send({ jsonrpc: '2.0', method: 'exit' });
    } catch { /* best effort */ }
    setTimeout(() => { try { this.#child.kill('SIGKILL'); } catch { /* gone */ } }, 500).unref?.();
    this.#failAll(new Error('lsp client closed'));
  }

  static async start(spec, { rootUri, timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
    const child = spawn(spec.command, spec.args ?? [], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const client = new LspClient(child, rootUri);
    await client.request('initialize', {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          synchronization: { didSave: false, willSave: false },
          definition: { linkSupport: true },
          references: {},
          hover: { contentFormat: ['plaintext', 'markdown'] },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: { relatedInformation: true },
        },
        workspace: { workspaceFolders: false, configuration: false },
      },
      workspaceFolders: null,
      clientInfo: { name: 'personal-ai', version: '1' },
    }, { timeoutMs });
    client.notify('initialized', {});
    return client;
  }
}

// ---------------------------------------------------------------------------
// extension factory
// ---------------------------------------------------------------------------

function loadLspConfig() {
  const candidates = [];
  if (process.env.PAI_LSP_CONFIG) candidates.push(process.env.PAI_LSP_CONFIG);
  candidates.push(join(process.cwd(), '.pai', 'lsp.json'));
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      return { path, servers: JSON.parse(readFileSync(path, 'utf-8'))?.servers ?? {} };
    } catch {
      return { path, servers: {}, error: 'unparseable config' };
    }
  }
  return { path: null, servers: {} };
}

function findRoot(startDir, patterns) {
  let dir = resolve(startDir);
  for (;;) {
    for (const p of patterns ?? []) {
      if (existsSync(join(dir, p))) return dir;
    }
    const up = dirname(dir);
    if (up === dir) return resolve(startDir);
    dir = up;
  }
}

const clip = (s) => (s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}\n[truncated]` : s);

function fmtLocation(loc) {
  const l = loc?.targetUri ? { uri: loc.targetUri, range: loc.targetSelectionRange ?? loc.targetRange } : loc;
  const file = decodeURIComponent(l?.uri ?? '').replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
  const line = (l?.range?.start?.line ?? 0) + 1;
  const col = (l?.range?.start?.character ?? 0) + 1;
  return `${file}:${line}:${col}`;
}

function fmtLocations(result) {
  const list = Array.isArray(result) ? result : result ? [result] : [];
  if (!list.length) return 'no locations';
  return clip(list.map(fmtLocation).join('\n'));
}

function fmtHover(result) {
  const c = result?.contents;
  if (!c) return 'no hover info';
  if (typeof c === 'string') return clip(c);
  if (Array.isArray(c)) return clip(c.map((x) => x?.value ?? String(x)).join('\n'));
  return clip(c.value ?? String(c));
}

function fmtSymbols(result, depth = 0) {
  const list = Array.isArray(result) ? result : [];
  const lines = [];
  for (const s of list.slice(0, 200)) {
    const line = (s?.selectionRange?.start?.line ?? s?.range?.start?.line ?? 0) + 1;
    lines.push(`${'  '.repeat(depth)}${s?.name ?? '?'} (${s?.kind ?? '?'}) :${line}`);
    if (s?.children?.length) lines.push(fmtSymbols(s.children, depth + 1));
    if (s?.location) lines.push(`${'  '.repeat(depth)}${s.name} :${(s.location.range?.start?.line ?? 0) + 1}`);
  }
  return clip(lines.filter(Boolean).join('\n') || 'no symbols');
}

const SEVERITY = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };
function fmtDiagnostics(diags) {
  if (!diags.length) return 'no diagnostics';
  return clip(diags.slice(0, 100).map((d) =>
    `${SEVERITY[d.severity] ?? 'note'}:${(d.range?.start?.line ?? 0) + 1}:${(d.range?.start?.character ?? 0) + 1} ${d.source ?? ''} ${d.message}`
  ).join('\n'));
}

export default function lspExtension(pi) {
  const { path: configPath, servers } = loadLspConfig();
  /** @type {Map<string, {client:LspClient, spec:object, root:string}>} */
  const live = new Map();
  /** @type {Map<string, Promise>} extension -> in-flight connect */
  const connecting = new Map();
  /** file extension -> server name */
  const extMap = new Map();
  for (const [name, spec] of Object.entries(servers)) {
    for (const ext of spec?.extensions ?? []) extMap.set(ext.toLowerCase(), name);
  }

  async function clientFor(filePath) {
    const name = extMap.get(extname(filePath).toLowerCase());
    if (!name) throw new Error(`no LSP server configured for '${extname(filePath)}' files`);
    const spec = servers[name];
    const existing = live.get(name);
    if (existing && existsSync(existing.root)) return existing.client;
    if (connecting.has(name)) return (await connecting.get(name)).client;
    const root = findRoot(dirname(resolve(filePath)), spec.rootPatterns ?? []);
    const p = (async () => {
      const client = await LspClient.start(spec, { rootUri: pathToFileURL(root).href });
      return { client, spec, root };
    })();
    connecting.set(name, p);
    try {
      const entry = await p;
      live.set(name, entry);
      return entry.client;
    } finally {
      connecting.delete(name);
    }
  }

  async function query(file, method, buildParams, fmt) {
    const abs = resolve(file);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      return { content: [{ type: 'text', text: `lsp: file not found: ${file}` }], isError: true };
    }
    try {
      const client = await clientFor(abs);
      const uri = await client.ensureOpen(abs, LANGUAGE_IDS[extname(abs).toLowerCase()] ?? 'plaintext');
      const result = await client.request(method, buildParams(uri));
      return { content: [{ type: 'text', text: fmt(result) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `lsp ${method} failed: ${err?.message ?? err}` }], isError: true };
    }
  }

  const posParams = (file, params) => {
    const { line, character } = params;
    return { file, line: line ?? 1, character: character ?? 1 };
  };

  pi.registerTool({
    name: 'lsp_definition',
    label: 'LSP Definition',
    description: 'Jump to the definition of the symbol at file:line:character via a language server. Read-only.',
    promptSnippet: 'lsp_definition(file, line, character) — go-to-definition via language server',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'path to the source file' },
        line: { type: 'number', description: '1-based line' },
        character: { type: 'number', description: '1-based column' },
      },
      required: ['file', 'line', 'character'],
    },
    async execute(id, params, signal) {
      const p = posParams(params.file, params);
      return query(p.file, 'textDocument/definition', (uri) => ({
        textDocument: { uri },
        position: { line: p.line - 1, character: p.character - 1 },
      }), fmtLocations);
    },
  });

  pi.registerTool({
    name: 'lsp_references',
    label: 'LSP References',
    description: 'List all references to the symbol at file:line:character via a language server. Read-only.',
    promptSnippet: 'lsp_references(file, line, character) — find all references via language server',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string' }, line: { type: 'number' }, character: { type: 'number' },
        includeDeclaration: { type: 'boolean' },
      },
      required: ['file', 'line', 'character'],
    },
    async execute(id, params) {
      const p = posParams(params.file, params);
      return query(p.file, 'textDocument/references', (uri) => ({
        textDocument: { uri },
        position: { line: p.line - 1, character: p.character - 1 },
        context: { includeDeclaration: params.includeDeclaration !== false },
      }), fmtLocations);
    },
  });

  pi.registerTool({
    name: 'lsp_hover',
    label: 'LSP Hover',
    description: 'Type/signature info for the symbol at file:line:character via a language server. Read-only.',
    promptSnippet: 'lsp_hover(file, line, character) — hover info via language server',
    parameters: {
      type: 'object',
      properties: { file: { type: 'string' }, line: { type: 'number' }, character: { type: 'number' } },
      required: ['file', 'line', 'character'],
    },
    async execute(id, params) {
      const p = posParams(params.file, params);
      return query(p.file, 'textDocument/hover', (uri) => ({
        textDocument: { uri },
        position: { line: p.line - 1, character: p.character - 1 },
      }), fmtHover);
    },
  });

  pi.registerTool({
    name: 'lsp_symbols',
    label: 'LSP Document Symbols',
    description: 'Outline of symbols in a file (functions, classes, methods) via a language server. Read-only.',
    promptSnippet: 'lsp_symbols(file) — document outline via language server',
    parameters: {
      type: 'object',
      properties: { file: { type: 'string' } },
      required: ['file'],
    },
    async execute(id, params) {
      return query(params.file, 'textDocument/documentSymbol', (uri) => ({
        textDocument: { uri },
      }), fmtSymbols);
    },
  });

  pi.registerTool({
    name: 'lsp_diagnostics',
    label: 'LSP Diagnostics',
    description: 'Latest publishDiagnostics for a file (or all open files when file is omitted) via language servers. Read-only.',
    promptSnippet: 'lsp_diagnostics(file?) — compiler/linter diagnostics via language server',
    parameters: {
      type: 'object',
      properties: { file: { type: 'string' } },
    },
    async execute(id, params) {
      if (params.file) {
        const abs = resolve(params.file);
        try {
          const client = await clientFor(abs);
          await client.ensureOpen(abs, LANGUAGE_IDS[extname(abs).toLowerCase()] ?? 'plaintext');
          // diagnostics arrive asynchronously — brief settle window
          await new Promise((r) => setTimeout(r, 400));
          return { content: [{ type: 'text', text: fmtDiagnostics(client.diagnosticsFor(abs)) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `lsp diagnostics failed: ${err?.message ?? err}` }], isError: true };
        }
      }
      const sections = [];
      for (const [name, entry] of live) {
        const all = entry.client.allDiagnostics();
        for (const [uri, diags] of Object.entries(all)) {
          const file = decodeURIComponent(uri).replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
          sections.push(`## ${file} [${name}]\n${fmtDiagnostics(diags)}`);
        }
      }
      return { content: [{ type: 'text', text: clip(sections.join('\n\n') || 'no diagnostics (no servers running)') }] };
    },
  });

  // dedup-h #1937 — `@diagnostics` context form: the prompt-path expander
  // pulls this provider when the operator mentions @diagnostics. Same
  // aggregation as lsp_diagnostics(file omitted): every live server's
  // collected publishDiagnostics, clipped. No servers → null (the expander
  // then reports honestly instead of injecting an empty block).
  const unregisterProvider = registerContextProvider('diagnostics', () => {
    const sections = [];
    for (const [name, entry] of live) {
      const all = entry.client.allDiagnostics();
      for (const [uri, diags] of Object.entries(all)) {
        const file = decodeURIComponent(uri).replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
        sections.push(`## ${file} [${name}]\n${fmtDiagnostics(diags)}`);
      }
    }
    return sections.join('\n\n') || null;
  });

  pi.on('session_shutdown', () => {
    unregisterProvider();
    for (const [, entry] of live) entry.client.close();
    live.clear();
  });

  pi.registerCommand('lsp', {
    description: 'List configured LSP servers and which file extensions they serve',
    handler: async (ctx) => {
      const lines = [`config: ${configPath ?? 'none found (.pai/lsp.json or $PAI_LSP_CONFIG)'}`];
      for (const [name, spec] of Object.entries(servers)) {
        const st = live.has(name) ? 'running' : connecting.has(name) ? 'connecting' : 'idle';
        lines.push(`  ${name}: ${st} — ${spec.command} (${(spec.extensions ?? []).join(', ') || 'no extensions'})`);
      }
      if (!Object.keys(servers).length) lines.push('  (no servers configured)');
      ctx.ui?.notify?.(lines.join('\n'), 'info');
    },
  });
}
