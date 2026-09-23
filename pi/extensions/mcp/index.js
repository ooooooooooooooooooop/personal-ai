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
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'personal-ai', version: '1' };
const DEFAULT_TIMEOUT_MS = 30_000;
// dedup-h #394 — remote connect budget: an unreachable SSE/streamable
// server must never stall boot. 10s per the audited upstream fix; applies
// to initialize handshakes AND the legacy-SSE endpoint discovery.
const CONNECT_TIMEOUT_MS = 10_000;
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
    // Killing only the direct child orphans its grandchildren — same tree
    // kill the hook/job runners use: taskkill /T on Windows.
    close: () => {
      if (process.platform === 'win32') {
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).unref(); }
        catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
      } else {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    },
    strippedEnv: stripped,
  };
}

// dedup-h #396 — credential redaction: a spec.url may carry userinfo
// (https://key@host) and headers may hold bearer material. Anything the
// operator sees (/mcp-add notices, status lines) strips userinfo and
// reports header COUNT only — never a name or value.
function redactUrl(u) {
  try {
    const x = new URL(u);
    if (x.username || x.password) { x.username = ''; x.password = ''; }
    return x.href;
  } catch { return String(u ?? ''); }
}

function parseSseBlock(text) {
  const data = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return data.length ? data.join('\n') : null;
}

// M38/dedup-h-#38: remote-MCP OAuth (client_credentials grant — the only
// grant completable without a browser/callback). spec.oauth = {
//   tokenUrl, clientId, clientSecret?, scope?, resource? }
// `resource` is the RFC 8707 resource-indicator OVERRIDE: when set it is
// sent verbatim as the `resource=` parameter; when absent the indicator
// defaults to the MCP server URL (the canonical URI of the resource).
// Authorization-code/PKCE needs a browser dance — out of scope; static
// bearer stays expressible via spec.headers.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function validateOAuthSpec(spec) {
  const o = spec?.oauth;
  if (o == null) return null;
  if (typeof o !== 'object') throw new McpError('oauth must be an object');
  if (typeof o.tokenUrl !== 'string' || !o.tokenUrl) throw new McpError('oauth.tokenUrl required');
  let tokenUrl;
  try { tokenUrl = new URL(o.tokenUrl); } catch { throw new McpError('oauth.tokenUrl is not a URL'); }
  if (!['https:', 'http:'].includes(tokenUrl.protocol)) throw new McpError('oauth.tokenUrl must be http(s)');
  // token endpoints carry client secrets — plaintext http is loopback-only
  if (tokenUrl.protocol === 'http:' && !LOOPBACK_HOSTS.has(tokenUrl.hostname.toLowerCase())) {
    throw new McpError('oauth.tokenUrl over http is refused off-loopback');
  }
  if (typeof o.clientId !== 'string' || !o.clientId) throw new McpError('oauth.clientId required');
  if (o.clientSecret != null && typeof o.clientSecret !== 'string') throw new McpError('oauth.clientSecret must be a string');
  if (o.scope != null && typeof o.scope !== 'string') throw new McpError('oauth.scope must be a string');
  // dedup-h #131: authorizationUrl upgrades the spec to the interactive
  // authorization-code + PKCE flow (operator approves in a browser, pastes
  // the code back). Absent → client_credentials (non-interactive).
  let authorizationUrl = null;
  if (o.authorizationUrl != null) {
    try { authorizationUrl = new URL(o.authorizationUrl); } catch { throw new McpError('oauth.authorizationUrl is not a URL'); }
    if (!['https:', 'http:'].includes(authorizationUrl.protocol)) throw new McpError('oauth.authorizationUrl must be http(s)');
    if (authorizationUrl.protocol === 'http:' && !LOOPBACK_HOSTS.has(authorizationUrl.hostname.toLowerCase())) {
      throw new McpError('oauth.authorizationUrl over http is refused off-loopback');
    }
    authorizationUrl = authorizationUrl.href;
  }
  // redirect_uri for the paste-back flow — the OOB URN is the default;
  // a real http(s) uri only makes sense for loopback receivers, which the
  // paste flow does not run. Allow operator override but refuse fragments.
  let redirectUri = 'urn:ietf:wg:oauth:2.0:oob';
  if (o.redirectUri != null) {
    let r;
    try { r = new URL(o.redirectUri); } catch { throw new McpError('oauth.redirectUri is not a URI'); }
    if (r.hash) throw new McpError('oauth.redirectUri must not carry a fragment');
    redirectUri = r.href;
  }
  // RFC 8707 §2: resource is an absolute URI and MUST NOT include a fragment.
  let resource = null;
  if (o.resource != null) {
    try { resource = new URL(o.resource); } catch { throw new McpError('oauth.resource is not an absolute URI'); }
    if (resource.hash) throw new McpError('oauth.resource must not carry a fragment (RFC 8707)');
    resource = resource.href;
  }
  // dedup-h #165: gateway token exchange (RFC 8693) — the acquired token is
  // a SUBJECT token; the gateway exchanges it for the upstream bearer.
  // Works under either flow (client_credentials subject or the stored
  // authorization_code user token).
  let exchange = null;
  if (o.exchange != null) {
    const ex = o.exchange;
    if (typeof ex !== 'object' || typeof ex.url !== 'string' || !ex.url) throw new McpError('oauth.exchange.url required');
    let url;
    try { url = new URL(ex.url); } catch { throw new McpError('oauth.exchange.url is not a URL'); }
    if (!['https:', 'http:'].includes(url.protocol)) throw new McpError('oauth.exchange.url must be http(s)');
    if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
      throw new McpError('oauth.exchange.url over http is refused off-loopback');
    }
    if (ex.audience != null && typeof ex.audience !== 'string') throw new McpError('oauth.exchange.audience must be a string');
    let exResource = null;
    if (ex.resource != null) {
      try { exResource = new URL(ex.resource); } catch { throw new McpError('oauth.exchange.resource is not an absolute URI'); }
      if (exResource.hash) throw new McpError('oauth.exchange.resource must not carry a fragment (RFC 8707)');
      exResource = exResource.href;
    }
    exchange = { url: url.href, audience: ex.audience ?? null, resource: exResource };
  }
  // a static Authorization header AND oauth is ambiguous auth — refuse
  for (const h of Object.keys(spec.headers ?? {})) {
    if (h.toLowerCase() === 'authorization') {
      throw new McpError('spec sets both headers.authorization and oauth — ambiguous credentials');
    }
  }
  return {
    tokenUrl: tokenUrl.href, clientId: o.clientId, clientSecret: o.clientSecret ?? null,
    scope: o.scope ?? null, resource, authorizationUrl, redirectUri, exchange,
    flow: authorizationUrl ? 'authorization_code' : 'client_credentials',
  };
}

// --- dedup-h #131: operator OAuth token store --------------------------------
// Tokens live in a USER-private file (Claude Code's ~/.claude.json mcpOAuth
// analogue), never in the workdir — the agent must not read bearer material.
// PAI_MCP_TOKEN_STORE overrides (tests, exotic installs).
function tokenStorePath() {
  return process.env.PAI_MCP_TOKEN_STORE
    ?? join(process.env.HOME ?? process.env.USERPROFILE ?? process.cwd(), '.personal-ai', 'mcp-oauth.json');
}
function readTokenStore() {
  try { return JSON.parse(readFileSync(tokenStorePath(), 'utf-8')) ?? {}; } catch { return {}; }
}
function writeTokenStore(doc) {
  const p = tokenStorePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2));
  try { chmodSync(tmp, 0o600); } catch { /* windows ACLs — best effort */ }
  renameSync(tmp, p);
}

function tokenRequest(oauth, fields) {
  const body = new URLSearchParams({ client_id: oauth.clientId, ...fields });
  if (oauth.clientSecret) body.set('client_secret', oauth.clientSecret);
  if (oauth.resource) body.set('resource', oauth.resource);
  return fetch(oauth.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });
}

// dedup-h #391 — the OAuth authorization-code dance is OPERATOR business,
// not session business: the host channel facade surfaces it as an
// actionable "授权" affordance while the in-session /mcp-auth commands keep
// working. One implementation, two front doors — the facade imports these
// (manifest-pinned) exports; each entry point keeps its OWN pending map so
// a verifier/state pair never crosses surfaces.
export function oauthBuildAuthorizeUrl(oauth, serverUrl) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');
  const u = new URL(oauth.authorizationUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', oauth.clientId);
  u.searchParams.set('redirect_uri', oauth.redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (oauth.scope) u.searchParams.set('scope', oauth.scope);
  u.searchParams.set('resource', oauth.resource ?? serverUrl ?? ''); // RFC8707
  return { url: u.href, verifier, state };
}

export async function oauthExchangeCode(oauth, { code, verifier }) {
  return parseTokenResponse(await tokenRequest(oauth, {
    grant_type: 'authorization_code', code, redirect_uri: oauth.redirectUri,
    code_verifier: verifier,
  }));
}

// Facade-side surface: config/token-store access + spec validation. The
// token store is user-private — the facade reports booleans, never tokens.
export const mcpOperatorSurface = {
  loadConfig, validateOAuthSpec, readTokenStore, writeTokenStore, tokenStorePath,
};
async function parseTokenResponse(res) {
  if (!res.ok) throw new McpError(`oauth token request failed: HTTP ${res.status}`);
  const doc = await res.json().catch(() => null);
  if (typeof doc?.access_token !== 'string' || !doc.access_token) throw new McpError('oauth token response lacks access_token');
  if (String(doc.token_type ?? '').toLowerCase() !== 'bearer') throw new McpError(`oauth token_type '${doc.token_type}' is not bearer`);
  const ttl = Number.isFinite(doc.expires_in) ? Math.max(0, doc.expires_in) : 3600;
  return { accessToken: doc.access_token, refreshToken: typeof doc.refresh_token === 'string' ? doc.refresh_token : null, expiresAt: Date.now() + Math.max(0, ttl - 60) * 1000 };
}

/** authorization_code mode: tokens come from the user-private store;
 * refresh_token grant renews in place. Unauthorized → honest error naming
 * the recovery command. */
function oauthStoredTokens(oauth, serverName) {
  let cached = null;
  const load = () => {
    const rec = readTokenStore()[serverName];
    if (!rec?.access_token) return null;
    return { accessToken: rec.access_token, refreshToken: rec.refresh_token ?? null, expiresAt: rec.expires_at ?? 0 };
  };
  const refresh = async (rec) => {
    if (!rec?.refreshToken) return null;
    try {
      const t = await parseTokenResponse(await tokenRequest(oauth, { grant_type: 'refresh_token', refresh_token: rec.refreshToken }));
      const store = readTokenStore();
      store[serverName] = {
        access_token: t.accessToken, refresh_token: t.refreshToken ?? rec.refreshToken,
        expires_at: t.expiresAt, obtained: new Date().toISOString(), flow: 'authorization_code',
      };
      writeTokenStore(store);
      cached = t;
      return t;
    } catch { return null; }
  };
  return {
    token: async () => {
      if (cached && Date.now() < cached.expiresAt) return cached.accessToken;
      const rec = cached ?? load();
      if (rec && Date.now() < rec.expiresAt) { cached = rec; return rec.accessToken; }
      const t = await refresh(rec);
      if (t) return t.accessToken;
      throw new McpError(`mcp server '${serverName}' is unauthorized — run /mcp-auth ${serverName} to complete OAuth`, { code: 'MCP_UNAUTHORIZED' });
    },
    invalidate: () => { cached = null; },
    describe: () => `oauth authorization_code (pkce${oauth.resource ? ', resource: ' + oauth.resource : ''})`,
    authorized: () => load() != null || (cached && Date.now() < cached.expiresAt),
  };
}

function oauthTokenManager(oauth, serverUrl) {
  let cached = null; // { accessToken, expiresAt }
  const acquire = async () => {
    const fields = { grant_type: 'client_credentials' };
    if (oauth.scope) fields.scope = oauth.scope;
    // RFC8707: the override wins; absent → the server's own canonical URI
    const body = new URLSearchParams({ client_id: oauth.clientId, ...fields, resource: oauth.resource ?? serverUrl });
    if (oauth.clientSecret) body.set('client_secret', oauth.clientSecret);
    const res = await fetch(oauth.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    });
    const t = await parseTokenResponse(res);
    cached = t;
    return t.accessToken;
  };
  return {
    token: async () => (cached && Date.now() < cached.expiresAt ? cached.accessToken : acquire()),
    invalidate: () => { cached = null; },
    // status surface sees the resolved indicator, never the token
    describe: () => `oauth client_credentials (resource: ${oauth.resource ?? 'server-url'})`,
  };
}

/**
 * dedup-h #165: gateway token exchange (RFC 8693). Wraps either token
 * source: the source token is the SUBJECT token; the gateway exchanges it
 * for the upstream bearer. Cached to the exchanged token's own expiry;
 * a 401 retry re-exchanges (the subject token may still be valid).
 */
function oauthExchangedTokens(base, oauth) {
  const ex = oauth.exchange;
  let cached = null;
  const acquire = async () => {
    const subject = await base.token();
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: subject,
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      client_id: oauth.clientId,
    });
    if (oauth.clientSecret) body.set('client_secret', oauth.clientSecret);
    if (ex.audience) body.set('audience', ex.audience);
    if (ex.resource) body.set('resource', ex.resource);
    const res = await fetch(ex.url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    });
    const t = await parseTokenResponse(res);
    cached = t;
    return t.accessToken;
  };
  return {
    token: async () => (cached && Date.now() < cached.expiresAt ? cached.accessToken : acquire()),
    // upstream 401 ⇒ the EXCHANGED token was rejected — drop it; the subject
    // token stays valid so the retry only re-exchanges, not re-authorizes.
    invalidate: () => { cached = null; },
    describe: () => `${base.describe?.() ?? 'oauth'} + gateway token-exchange`,
    ...(base.authorized ? { authorized: () => base.authorized() } : {}),
  };
}

// dedup-h #348 — no request may ride on IMPLICIT transport timeouts
// (undici's ~5min headers default was the upstream bug class). Every POST
// carries an explicit bound: requests get their caller's timeoutMs;
// notifications/fire-and-forget posts get POST_TIMEOUT_MS.
const POST_TIMEOUT_MS = 30_000;

function httpTransport(spec, { serverName = null } = {}) {
  const oauthSpec = validateOAuthSpec(spec); // throws on malformed — fail closed at connect
  let tokens = oauthSpec
    ? (oauthSpec.flow === 'authorization_code' ? oauthStoredTokens(oauthSpec, serverName ?? spec.url) : oauthTokenManager(oauthSpec, spec.url))
    : null;
  if (tokens && oauthSpec.exchange) tokens = oauthExchangedTokens(tokens, oauthSpec);
  const postTimeoutMs = spec.postTimeoutMs ?? POST_TIMEOUT_MS;
  let sessionId = null;
  const post = async (msg, signal) => {
    const doPost = async () => fetch(spec.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        ...(spec.headers ?? {}),
        ...(tokens ? { authorization: `Bearer ${await tokens.token()}` } : {}),
      },
      body: JSON.stringify(msg),
      signal,
    });
    let res = await doPost();
    // 401 → the cached token was rejected: invalidate and retry ONCE
    if (res.status === 401 && tokens) {
      tokens.invalidate();
      res = await doPost();
    }
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
    notify: async (msg) => { await post(msg, AbortSignal.timeout(postTimeoutMs)).catch(() => {}); },
    close: () => {},
    oauth: tokens?.describe() ?? null,
  };
}

// dedup-h #347 — legacy `transport:"sse"` (pre-2025 MCP): GET opens a
// persistent SSE stream; the server announces `event: endpoint` with the
// POST URL; client POSTs requests there (202) and answers/notifications
// arrive back over the stream as `event: message` frames.
function sseTransport(spec, { serverName = null } = {}) {
  const oauthSpec = validateOAuthSpec(spec);
  let tokens = oauthSpec
    ? (oauthSpec.flow === 'authorization_code' ? oauthStoredTokens(oauthSpec, serverName ?? spec.url) : oauthTokenManager(oauthSpec, spec.url))
    : null;
  if (tokens && oauthSpec.exchange) tokens = oauthExchangedTokens(tokens, oauthSpec);
  const ac = new AbortController();
  const pending = { onMessage: null, onExit: null };
  let postUrl = null;
  let closed = false;
  const authHeaders = async () => ({
    ...(spec.headers ?? {}),
    ...(tokens ? { authorization: `Bearer ${await tokens.token()}` } : {}),
  });

  const pump = (async () => {
    const res = await fetch(spec.url, {
      headers: { accept: 'text/event-stream', ...(await authHeaders()) },
      signal: ac.signal,
    });
    if (!res.ok || !res.body) throw new McpError(`sse connect failed: HTTP ${res.status}`, { code: 'MCP_CONNECT' });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (;;) {
        const sep = buf.search(/\r?\n\r?\n/);
        if (sep < 0) break;
        const block = buf.slice(0, sep);
        buf = buf.slice(sep).replace(/^\r?\n\r?\n/, '');
        let event = 'message';
        const data = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (!data.length) continue;
        const payload = data.join('\n');
        if (event === 'endpoint' && postUrl == null) {
          // endpoint data is a URI reference — resolve against the SSE URL
          try { postUrl = new URL(payload, spec.url).toString(); } catch { postUrl = payload; }
          continue;
        }
        if (event === 'message') {
          try { pending.onMessage?.(JSON.parse(payload)); } catch { /* malformed frame skipped */ }
        }
      }
    }
    if (!closed) pending.onExit?.(0); // server closed the stream — fail pending honestly
  })();

  // the pump only resolves at stream END; the handshake is postUrl arrival.
  // Wrap it: wait until postUrl is set, the pump fails, or the timer fires.
  const handshake = new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (postUrl) { clearInterval(timer); resolve(); }
    }, 5);
    pump.catch((e) => { clearInterval(timer); reject(e); });
    setTimeout(() => { clearInterval(timer); reject(new McpError('sse endpoint handshake timed out', { code: 'MCP_TIMEOUT' })); }, CONNECT_TIMEOUT_MS);
  });

  const postTimeoutMs = spec.postTimeoutMs ?? POST_TIMEOUT_MS;
  const doPost = async (msg) => {
    const sendOnce = async () => fetch(postUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(msg),
      // transport-lifetime abort OR an explicit per-post bound — never
      // the undici implicit default (#348)
      signal: AbortSignal.any([ac.signal, AbortSignal.timeout(postTimeoutMs)]),
    });
    let res = await sendOnce();
    if (res.status === 401 && tokens) { tokens.invalidate(); res = await sendOnce(); }
    return res;
  };

  return {
    kind: 'sse',
    // send() never awaits the response — legacy SSE answers on the stream.
    // A failed POST is fed back as a synthetic JSON-RPC error so the
    // pending request rejects instead of hanging to timeout.
    send: (msg) => {
      if (closed) return;
      handshake.then(() => doPost(msg)).then((res) => {
        if (res.status >= 400 && msg.id != null) {
          pending.onMessage?.({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `sse POST HTTP ${res.status}` } });
        }
      }).catch((e) => {
        if (msg.id != null) {
          pending.onMessage?.({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `sse POST failed: ${e.message}` } });
        }
      });
    },
    onMessage: (fn) => { pending.onMessage = fn; },
    onExit: (fn) => { pending.onExit = fn; },
    close: () => {
      closed = true;
      try { ac.abort(); } catch { /* already aborted */ }
    },
    oauth: tokens?.describe() ?? null,
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

  static async connect(spec, { timeoutMs = DEFAULT_TIMEOUT_MS, serverName = null } = {}) {
    const kind = spec.transport ?? 'auto';
    if (!['auto', 'http', 'streamable-http', 'sse'].includes(kind)) {
      throw new McpError(`mcp spec transport '${spec.transport}' unsupported — expected http|streamable-http|sse`, { code: 'MCP_SPEC' });
    }
    const transport = !spec.url ? stdioTransport(spec)
      : kind === 'sse' ? sseTransport(spec, { serverName })
      : httpTransport(spec, { serverName });
    const client = new McpClient(transport);
    client.strippedEnv = transport.strippedEnv ?? [];
    client.oauth = transport.oauth ?? null;
    try {
      await client.initialize({ timeoutMs });
    } catch (err) {
      // a stdio child was already spawned — a failed handshake must not
      // orphan the server process just because initialize never resolved
      try { transport.close(); } catch { /* best effort */ }
      throw err;
    }
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

// dedup-h #242-env: ${VAR_NAME} placeholders in MCP server configs expand
// to environment variables (CodeBuddy analogue) — command/args/env for
// stdio, url/headers for HTTP transports. Missing variables stay literal
// AND land in missingEnv for an honest diagnostic.
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
function expandEnvPlaceholders(value, missing) {
  if (typeof value === 'string') {
    return value.replace(ENV_REF, (m, name) => {
      if (process.env[name] != null) return process.env[name];
      missing.add(name);
      return m;
    });
  }
  if (Array.isArray(value)) return value.map((v) => expandEnvPlaceholders(v, missing));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandEnvPlaceholders(v, missing);
    return out;
  }
  return value;
}
const EXPAND_FIELDS = ['command', 'args', 'env', 'url', 'headers'];

function loadConfig() {
  const candidates = [];
  if (process.env.PAI_MCP_CONFIG) candidates.push(process.env.PAI_MCP_CONFIG);
  const cwd = process.cwd();
  candidates.push(join(cwd, '.pai', 'mcp.json'), join(cwd, '.mcp.json'));
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const doc = JSON.parse(readFileSync(path, 'utf-8'));
      const missing = new Set();
      const servers = {};
      for (const [name, spec] of Object.entries(doc?.mcpServers ?? doc?.servers ?? {})) {
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) { servers[name] = spec; continue; }
        const s = { ...spec };
        for (const f of EXPAND_FIELDS) {
          if (s[f] != null) s[f] = expandEnvPlaceholders(s[f], missing);
        }
        servers[name] = s;
      }
      return { path, servers, missingEnv: [...missing] };
    } catch {
      return { path, servers: {}, missingEnv: [], error: 'unparseable config' };
    }
  }
  return { path: null, servers: {}, missingEnv: [] };
}

// C2 per-tool output budget: spec.output_token_limit caps every tool on the
// server; spec.tool_output_limits {toolName: tokens} overrides per tool.
// Tokens ≈ chars/4 (no tokenizer at this layer — the cap is a context-
// protection bound, not billing math). Can only tighten, never widen the
// built-in MAX_RESULT_CHARS ceiling.
function resultCharCap(spec, toolName) {
  const tokens = spec?.tool_output_limits?.[toolName] ?? spec?.output_token_limit;
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return MAX_RESULT_CHARS;
  return Math.min(MAX_RESULT_CHARS, Math.floor(tokens * 4));
}

// Content-block types a well-formed MCP result may carry. Anything outside
// this set (missing type, unknown type, non-object) is normalized into a
// text stub — a hostile or buggy server must not smuggle arbitrary block
// shapes into the context serializer.
const KNOWN_NONTEXT = new Set(['image', 'audio', 'resource', 'resource_link']);

function wrapUntrusted(server, tool, result, maxChars = MAX_RESULT_CHARS) {
  let dropped = 0;
  const content = (result?.content ?? []).map((c) => {
    if (c?.type === 'text' && typeof c.text === 'string') {
      const text = c.text.length > maxChars
        ? `${c.text.slice(0, maxChars)}\n[truncated at ${maxChars} chars]`
        : c.text;
      return {
        type: 'text',
        text: `<untrusted mcp_server="${server}" mcp_tool="${tool}">\n${text}\n</untrusted>`,
      };
    }
    if (c && typeof c === 'object' && KNOWN_NONTEXT.has(c.type)) return c;
    dropped += 1;
    return {
      type: 'text',
      text: `<untrusted mcp_server="${server}" mcp_tool="${tool}">[unsupported content block '${String(c?.type ?? typeof c)}' dropped]</untrusted>`,
    };
  });
  return {
    content,
    isError: result?.isError === true,
    details: {
      mcpServer: server, mcpTool: tool,
      structured: result?.structuredContent ?? null,
      ...(dropped ? { droppedBlocks: dropped } : {}),
    },
  };
}

export default function mcpExtension(pi) {
  const { path: configPath, servers: allServers, missingEnv, error: configError } = loadConfig();
  // C3 per-agent MCP subset: a delegate child stamped PAI_MCP_DENY (profile
  // mcp_deny via the dedicated bridge flag) never connects to denied servers
  // — filtering happens here, before any spawn/handshake, so a denied server
  // cannot even be probed by the child's process.
  const denied = new Set(
    String(process.env.PAI_MCP_DENY ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  );
  const servers = Object.fromEntries(Object.entries(allServers).filter(([name]) => !denied.has(name)));
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
          return wrapUntrusted(serverName, t.name, res, resultCharCap(entry.spec, t.name));
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

  // dedup-h #167: extracted per-server connect so /mcp-add hot-connects a
  // newly persisted entry through the EXACT same path as boot servers —
  // notification subscription, independent family discovery, pending
  // refresh flush, honest failed marker.
  const connectOne = async (name, spec) => {
      try {
        const client = await McpClient.connect(spec, { timeoutMs: CONNECT_TIMEOUT_MS, serverName: name });
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
      return connected.get(name);
    };

  const boot = (async () => {
    // dedup-h #394: connects run CONCURRENTLY — a dead server costs its own
    // 10s budget in parallel instead of serially multiplying the stall.
    // connectOne already fail-isolates each server (failed:true).
    await Promise.all(Object.entries(servers).map(([name, spec]) => {
      if (!spec || typeof spec !== 'object' || (!spec.command && !spec.url)) return null;
      return connectOne(name, spec);
    }));
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
        if (entry.client?.oauth) lines.push(`    auth: ${entry.client.oauth}`);
        const hdrCount = Object.keys(entry.spec?.headers ?? {}).length;
        if (hdrCount) lines.push(`    headers: ${hdrCount} configured (values redacted)`);
        if (entry.dead?.size) lines.push(`    removed by server (list_changed): ${[...entry.dead].join(', ')}`);
        if (entry.lastRefresh) lines.push(`    last refresh ${entry.lastRefresh.at} (+${entry.lastRefresh.added}/-${entry.lastRefresh.removed})`);
        for (const t of entry.tools) lines.push(`    ${t}`);
        for (const p of entry.prompts ?? []) {
          const req = (p.args ?? []).filter((a) => a.required).map((a) => a.name);
          lines.push(`    /mcp-${name}-${p.name}`.replace(/[^a-zA-Z0-9_\-/]/g, '_') + (req.length ? ` (args: ${req.join(' ')})` : ''));
        }
      }
      if (denied.size) {
        const hit = [...denied].filter((n) => n in allServers);
        if (hit.length) lines.push(`  denied by profile (PAI_MCP_DENY): ${hit.join(', ')}`);
      }
      if (missingEnv?.length) {
        lines.push(`  unresolved env placeholders (left literal): ${missingEnv.map((n) => '${' + n + '}').join(', ')}`);
      }
      if (Object.keys(servers).length === 0 && configPath) lines.push('  (config has no servers)');
      ctx.ui?.notify?.(lines.join('\n'), 'info');
    },
  });

  // ---------------------------------------------------------------------
  // dedup-h #131: interactive OAuth — authorization_code + PKCE.
  // /mcp-auth <server>      → builds the authorize URL (state + S256
  //                           challenge + RFC8707 resource), shows it to
  //                           the operator; they approve in the browser
  //                           and paste the code back.
  // /mcp-auth-done <s> <c>  → exchanges the code at tokenUrl, stores the
  //                           token in the user-private store; subsequent
  //                           calls ride Bearer automatically.
  // The pending dance lives in memory with a 10-minute TTL.
  const pendingAuth = new Map(); // serverName → {verifier, state, deadline}
  const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;

  const oauthSpecFor = (name) => {
    const spec = allServers[name];
    if (!spec) return { error: `unknown server '${name}'` };
    try {
      const o = validateOAuthSpec(spec);
      if (!o?.authorizationUrl) return { error: `server '${name}' has no oauth.authorizationUrl — interactive flow not configured` };
      return { oauth: o };
    } catch (err) { return { error: `server '${name}': ${err?.message ?? err}` }; }
  };

  pi.registerCommand('mcp-auth', {
    description: 'Begin OAuth (authorization_code + PKCE) for a remote MCP server — prints the approval URL',
    handler: async (args, ctx) => {
      await boot;
      const name = String(args ?? '').trim().split(/\s+/)[0] ?? '';
      if (!name) { ctx.ui?.notify?.('usage: /mcp-auth <server>', 'error'); return; }
      const { oauth, error } = oauthSpecFor(name);
      if (error) { ctx.ui?.notify?.(error, 'error'); return; }
      const { url, verifier, state } = oauthBuildAuthorizeUrl(oauth, servers[name]?.url);
      pendingAuth.set(name, { verifier, state, deadline: Date.now() + OAUTH_PENDING_TTL_MS });
      ctx.ui?.notify?.(
        `OAuth for '${name}' — open this URL, approve, then paste the code:\n\n${url}\n\n` +
        `Then run: /mcp-auth-done ${name} <code>   (valid for 10 minutes)`,
        'info',
      );
    },
  });

  pi.registerCommand('mcp-auth-done', {
    description: 'Complete OAuth for a remote MCP server — /mcp-auth-done <server> <code>',
    handler: async (args, ctx) => {
      await boot;
      const [name, code] = String(args ?? '').trim().split(/\s+/);
      if (!name || !code) { ctx.ui?.notify?.('usage: /mcp-auth-done <server> <code>', 'error'); return; }
      const pend = pendingAuth.get(name);
      pendingAuth.delete(name);
      if (!pend || Date.now() > pend.deadline) { ctx.ui?.notify?.(`no pending OAuth for '${name}' (or it expired) — run /mcp-auth ${name} again`, 'error'); return; }
      const { oauth, error } = oauthSpecFor(name);
      if (error) { ctx.ui?.notify?.(error, 'error'); return; }
      try {
        const t = await oauthExchangeCode(oauth, { code, verifier: pend.verifier });
        const store = readTokenStore();
        store[name] = {
          access_token: t.accessToken, refresh_token: t.refreshToken,
          expires_at: t.expiresAt, obtained: new Date().toISOString(), flow: 'authorization_code',
        };
        writeTokenStore(store);
        ctx.ui?.notify?.(`OAuth complete for '${name}' — token stored (refresh: ${t.refreshToken ? 'yes' : 'no'}). Server calls carry it automatically; restart the session if this server failed earlier.`, 'info');
      } catch (err) {
        ctx.ui?.notify?.(`OAuth exchange failed for '${name}': ${err?.message ?? err} — run /mcp-auth ${name} to retry`, 'error');
      }
    },
  });

  // dedup-h #167: claude-code compatible positional add —
  //   /mcp-add <name> <http(s)-url> [--header "K: V"]*
  //   /mcp-add <name> <command> [args...] [--env K=V]*   (stdio)
  // The spec persists to the resolved config file (or .pai/mcp.json when
  // none exists yet), then hot-connects through connectOne — the same path
  // a boot server takes. A failed connect still persists the entry (the
  // config is the operator's; /mcp shows the failure honestly).
  pi.registerCommand('mcp-add', {
    description: 'Add an MCP server — /mcp-add <name> <url|command> [args…] [--header "K: V"]* [--env K=V]* [--transport sse] [--oauth-client-id ID --oauth-token-url U [--oauth-authorize-url U] [--oauth-scope S]]',
    handler: async (args, ctx) => {
      await boot;
      // quote-aware tokenize — --header "K: V" must arrive as ONE word
      const words = [];
      {
        let cur = '', q = null;
        for (const ch of String(args ?? '')) {
          if (q) { if (ch === q) q = null; else cur += ch; }
          else if (ch === '"' || ch === "'") q = ch;
          else if (/\s/.test(ch)) { if (cur) { words.push(cur); cur = ''; } }
          else cur += ch;
        }
        if (cur) words.push(cur);
      }
      const name = words[0] ?? '';
      if (!name || !/^[a-z0-9][a-z0-9_-]{0,60}$/i.test(name)) {
        ctx.ui?.notify?.('usage: /mcp-add <name> <url|command> [args…] — name is kebab-case', 'error'); return;
      }
      const rest = [];
      const headers = {}, env = {};
      let transport = null;
      const oauth = {};
      for (let i = 1; i < words.length; i++) {
        if (words[i] === '--header' && words[i + 1]) {
          const h = words[++i]; const ci = h.indexOf(':');
          if (ci > 0) headers[h.slice(0, ci).trim()] = h.slice(ci + 1).trim();
        } else if (words[i] === '--env' && words[i + 1]) {
          const e = words[++i]; const ei = e.indexOf('=');
          if (ei > 0) env[e.slice(0, ei)] = e.slice(ei + 1);
        } else if (words[i] === '--transport' && words[i + 1]) {
          transport = words[++i];
        // dedup-h #350 — pre-registered OAuth client flags
        } else if (words[i] === '--oauth-client-id' && words[i + 1]) {
          oauth.clientId = words[++i];
        } else if (words[i] === '--oauth-token-url' && words[i + 1]) {
          oauth.tokenUrl = words[++i];
        } else if (words[i] === '--oauth-authorize-url' && words[i + 1]) {
          oauth.authorizationUrl = words[++i];
        } else if (words[i] === '--oauth-scope' && words[i + 1]) {
          oauth.scope = words[++i];
        } else rest.push(words[i]);
      }
      if (!rest.length) { ctx.ui?.notify?.('usage: /mcp-add <name> <url|command> [args…]', 'error'); return; }
      let spec;
      if (/^https?:\/\//i.test(rest[0])) {
        spec = { url: rest[0] };
        if (transport === 'sse') spec.transport = 'sse';
        else if (transport && transport !== 'http') {
          ctx.ui?.notify?.(`--transport '${transport}' unsupported — expected http|sse`, 'error'); return;
        }
        if (Object.keys(headers).length) spec.headers = headers;
        // pre-registered client needs its token endpoint too — a bare id
        // would be a half-spec that only fails later at connect (#350)
        if (Object.keys(oauth).length) {
          try {
            validateOAuthSpec({ ...spec, oauth });
          } catch (e) {
            ctx.ui?.notify?.(`oauth spec incomplete: ${e.message} — needs --oauth-client-id + --oauth-token-url (+ --oauth-authorize-url for the interactive flow)`, 'error');
            return;
          }
          spec.oauth = oauth;
        }
      } else {
        spec = { command: rest[0] };
        if (rest.length > 1) spec.args = rest.slice(1);
        if (Object.keys(env).length) spec.env = env;
        if (Object.keys(oauth).length) {
          ctx.ui?.notify?.('oauth flags apply to URL servers only — stdio servers have no token endpoint', 'error');
          return;
        }
      }
      if (denied.has(name)) { ctx.ui?.notify?.(`server '${name}' is denied for this agent (PAI_MCP_DENY)`, 'error'); return; }
      const target = configPath ?? join(process.cwd(), '.pai', 'mcp.json');
      let doc = {};
      if (existsSync(target)) {
        try { doc = JSON.parse(readFileSync(target, 'utf-8')); }
        catch { ctx.ui?.notify?.(`config '${target}' is unparseable — refusing to write`, 'error'); return; }
      }
      const key = doc.mcpServers != null ? 'mcpServers' : (doc.servers != null ? 'servers' : 'mcpServers');
      const table = doc[key] ?? {};
      if (table[name] || servers[name]) { ctx.ui?.notify?.(`server '${name}' already exists`, 'error'); return; }
      table[name] = spec;
      doc[key] = table;
      try {
        mkdirSync(dirname(target), { recursive: true });
        const tmp = `${target}.tmp-${process.pid}`;
        writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
        renameSync(tmp, target);
      } catch (err) {
        ctx.ui?.notify?.(`persist failed: ${err?.message ?? err} — server NOT added`, 'error'); return;
      }
      servers[name] = spec;
      const entry = await connectOne(name, spec);
      const kind = spec.url ? `${spec.transport === 'sse' ? 'sse' : 'http'} ${redactUrl(spec.url)}` : `stdio '${[spec.command, ...(spec.args ?? [])].join(' ')}'`;
      if (entry?.failed || !entry?.client) {
        ctx.ui?.notify?.(`added '${name}' (${kind}) to ${target} — connect FAILED; /mcp shows the error, fix the spec and restart`, 'error');
        return;
      }
      ctx.ui?.notify?.(
        `added '${name}' (${kind}) to ${target} — connected: ${entry.tools.length} tools, ${(entry.prompts ?? []).length} prompts`,
        'info',
      );
    },
  });
}
