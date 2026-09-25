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
 * notifications/tools|prompts/list_changed hot-refresh the surface; newly
 * listed tools register live, removed tools tombstone into honest errors
 * since pi has no unregisterTool.
 *
 * The client below is zero-dependency. stdio framing is newline-delimited
 * JSON-RPC 2.0; Streamable HTTP is one POST per request answered as JSON or
 * SSE, plus the spec's optional server→client GET SSE push stream (#1075).
 * Server
 * specs may carry secrets — nothing here logs env/argv.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { dpapiAvailable, dpapiEncrypt, dpapiDecrypt } from '../../../host/src/core/cryptostore.js';

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
  // dedup-h #740: deviceAuthUrl upgrades the spec to the RFC 8628 device
  // authorization grant (GitHub device flow) — headless environments where
  // no browser callback exists: the operator enters a user_code at a
  // verification URI on ANY device while we poll the token endpoint.
  let deviceAuthUrl = null;
  if (o.deviceAuthUrl != null) {
    try { deviceAuthUrl = new URL(o.deviceAuthUrl); } catch { throw new McpError('oauth.deviceAuthUrl is not a URL'); }
    if (!['https:', 'http:'].includes(deviceAuthUrl.protocol)) throw new McpError('oauth.deviceAuthUrl must be http(s)');
    if (deviceAuthUrl.protocol === 'http:' && !LOOPBACK_HOSTS.has(deviceAuthUrl.hostname.toLowerCase())) {
      throw new McpError('oauth.deviceAuthUrl over http is refused off-loopback');
    }
    deviceAuthUrl = deviceAuthUrl.href;
  }
  // explicit flow selector for servers exposing BOTH dances (GitHub does):
  // o.flow pins the grant; absent → authorizationUrl wins, then device.
  let flow = null;
  if (o.flow != null) {
    if (!['authorization_code', 'device_code', 'client_credentials'].includes(o.flow)) {
      throw new McpError(`oauth.flow '${o.flow}' must be authorization_code|device_code|client_credentials`);
    }
    flow = o.flow;
  }
  if ((flow ?? (deviceAuthUrl ? 'device_code' : null)) === 'device_code' && !deviceAuthUrl) {
    throw new McpError("oauth.flow 'device_code' requires oauth.deviceAuthUrl");
  }
  if (flow === 'authorization_code' && !authorizationUrl) {
    throw new McpError("oauth.flow 'authorization_code' requires oauth.authorizationUrl");
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
  } else if (o.loopbackRedirect === true) {
    // dedup-h #1065 — loopback redirect (Claude Code localhost:8765/callback
    // analogue): the host receives the code itself, no manual paste.
    const port = o.redirectPort != null ? Number(o.redirectPort) : 8765;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new McpError('oauth.redirectPort must be a TCP port');
    redirectUri = `http://localhost:${port}/callback`;
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
    scope: o.scope ?? null, resource, authorizationUrl, deviceAuthUrl, redirectUri, exchange,
    flow: flow ?? (authorizationUrl ? 'authorization_code' : deviceAuthUrl ? 'device_code' : 'client_credentials'),
  };
}

// dedup-h #1514 — OAuth discovery: a bare remote server that answers 401
// can still be authorized end-to-end — RFC 9728 protected-resource metadata
// (or the WWW-Authenticate resource_metadata pointer) names the
// authorization server; RFC 8414 metadata names its endpoints; RFC 7591
// dynamic registration mints the client identity. All of it happens on the
// operator's explicit /mcp-auth intent — never silently at connect.

function parseWwwAuthenticate(header) {
  if (typeof header !== 'string' || !header) return {};
  const out = {};
  const m = header.match(/resource_metadata="([^"]+)"/i);
  if (m) out.resourceMetadata = m[1];
  const s = header.match(/(?:^|[\s,])scope="([^"]+)"/i);
  if (s) out.scope = s[1];
  return out;
}

async function fetchOAuthJson(url, { timeoutMs = 10_000 } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new McpError(`oauth metadata url '${String(url).slice(0, 80)}' is not a URL`); }
  if (!['https:', 'http:'].includes(u.protocol)) throw new McpError('oauth metadata must be http(s)');
  // metadata steers where credentials flow — plaintext http is loopback-only,
  // same posture as tokenUrl itself.
  if (u.protocol === 'http:' && !LOOPBACK_HOSTS.has(u.hostname.toLowerCase())) {
    throw new McpError('oauth metadata over http is refused off-loopback');
  }
  const res = await fetch(u, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw new McpError(`oauth metadata GET ${u.host}${u.pathname} → HTTP ${res.status}`);
  if (text.length > 64 * 1024) throw new McpError('oauth metadata over 64KB refused');
  try { return JSON.parse(text); } catch { throw new McpError('oauth metadata is not JSON'); }
}

// RFC 8414 §3.1 / RFC 9728 §3: the well-known segment inserts BEFORE the
// issuer's path component.
function wellKnown(base, name) {
  const u = new URL(base);
  return `${u.origin}/.well-known/${name}${u.pathname === '/' ? '' : u.pathname}`;
}

async function discoverOAuthMetadata(serverUrl, wwwAuth) {
  const parsed = parseWwwAuthenticate(wwwAuth);
  const srv = new URL(serverUrl);
  const prmCandidates = [];
  if (parsed.resourceMetadata) prmCandidates.push(parsed.resourceMetadata);
  prmCandidates.push(wellKnown(srv, 'oauth-protected-resource'), `${srv.origin}/.well-known/oauth-protected-resource`);
  let prm = null, lastErr = null;
  for (const u of prmCandidates) {
    try { prm = await fetchOAuthJson(u); break; } catch (e) { lastErr = e; }
  }
  if (!prm) throw lastErr ?? new McpError('no protected-resource metadata reachable');
  const asList = Array.isArray(prm.authorization_servers) ? prm.authorization_servers.filter((x) => typeof x === 'string' && x) : [];
  if (!asList.length) throw new McpError('protected-resource metadata names no authorization_servers');
  const asm = await fetchOAuthJson(wellKnown(asList[0], 'oauth-authorization-server'));
  if (typeof asm?.token_endpoint !== 'string' || !asm.token_endpoint) {
    throw new McpError('authorization-server metadata has no token_endpoint');
  }
  return {
    authorizationUrl: typeof asm.authorization_endpoint === 'string' ? asm.authorization_endpoint : null,
    tokenUrl: asm.token_endpoint,
    deviceAuthUrl: typeof asm.device_authorization_endpoint === 'string' ? asm.device_authorization_endpoint : null,
    registrationUrl: typeof asm.registration_endpoint === 'string' ? asm.registration_endpoint : null,
    scope: parsed.scope ?? (Array.isArray(prm.scopes_supported) ? prm.scopes_supported.join(' ') : null),
    issuer: typeof asm.issuer === 'string' ? asm.issuer : null,
  };
}

// RFC 7591 dynamic client registration — one JSON POST; the resulting
// client identity persists in the operator token store (next to tokens,
// same 0600 posture) so re-auth reuses it.
async function registerOAuthClient(registrationUrl, { redirectUris } = {}) {
  const res = await fetch(registrationUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'personal-ai-mcp',
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new McpError(`client registration → HTTP ${res.status}`);
  if (text.length > 64 * 1024) throw new McpError('client registration response over 64KB refused');
  let doc;
  try { doc = JSON.parse(text); } catch { throw new McpError('client registration returned non-JSON'); }
  if (typeof doc?.client_id !== 'string' || !doc.client_id) throw new McpError('client registration returned no client_id');
  return { clientId: doc.client_id, clientSecret: typeof doc.client_secret === 'string' ? doc.client_secret : null };
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
  try {
    const doc = JSON.parse(readFileSync(tokenStorePath(), 'utf-8')) ?? {};
    // dedup-h #2177 — v2 files are DPAPI ciphertext; decrypt failure means
    // re-auth, never a plaintext guess (wrong-OS-user blobs stay sealed).
    if (doc?.enc === 'dpapi') {
      const plain = dpapiDecrypt(doc.data);
      if (plain == null) return {};
      try { return JSON.parse(plain) ?? {}; } catch { return {}; }
    }
    return doc;
  } catch { return {}; }
}
function writeTokenStore(doc) {
  const p = tokenStorePath();
  mkdirSync(dirname(p), { recursive: true });
  // dedup-h #2177 — encrypted local credential storage (upstream CLI+MCP
  // OAuth credential store): on DPAPI platforms the file holds only a
  // CurrentUser-scope ciphertext blob — copying it off this user/machine
  // yields nothing. Encrypt failure is fail-closed (no silent plaintext
  // downgrade); platforms without DPAPI keep the plaintext store honestly
  // (user-private dir + 0600), same posture as before.
  let payload = doc;
  if (dpapiAvailable()) {
    const blob = dpapiEncrypt(JSON.stringify(doc));
    if (blob == null) {
      throw new Error('mcp token store: DPAPI encrypt failed — refusing to write plaintext credentials');
    }
    payload = { v: 2, enc: 'dpapi', data: blob };
  }
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
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

// --- dedup-h #1065: loopback OAuth redirect receiver ------------------------
// Claude Code localhost:8765/callback analogue: an authorization_code flow
// whose redirect_uri is a loopback http URL can complete WITHOUT manual
// paste — a 127.0.0.1-bound listener captures ?code&state, validates state
// (CSRF), and hands the code to the caller for exchange. Never binds a
// non-loopback interface: the receiver exists to catch the local browser's
// redirect, not to accept network calls.

/** redirectUri → {port,path} when it is a loopback http URL, else null. */
export function loopbackListenSpec(redirectUri) {
  try {
    const u = new URL(redirectUri);
    if (u.protocol !== 'http:' || !LOOPBACK_HOSTS.has(u.hostname.toLowerCase())) return null;
    return { port: Number(u.port || 80), path: u.pathname || '/callback' };
  } catch { return null; }
}

/**
 * Listen for exactly one OAuth callback. Returns {promise, port, close} —
 * promise resolves {code} on a state-matching hit, rejects on provider
 * ?error=, timeout, or bind failure. A state MISMATCH answers 400 and keeps
 * waiting (a stray hit must not kill a valid in-flight approval).
 */
export function oauthLoopbackListen({ port = 8765, path = '/callback', state, timeoutMs = 5 * 60 * 1000 } = {}) {
  let done = false;
  let srv;
  const promise = new Promise((resolve, reject) => {
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); try { srv.close(); } catch { /* already closed */ } fn(v); } };
    srv = createServer((req, res) => {
      let u;
      try { u = new URL(req.url ?? '/', 'http://127.0.0.1'); } catch { u = null; }
      if (!u || u.pathname !== path) {
        res.writeHead(404).end('not found');
        return;
      }
      const err = u.searchParams.get('error');
      if (err) {
        res.writeHead(200, { 'content-type': 'text/plain' }).end(`authorization denied: ${err} — you can close this tab`);
        finish(reject, new McpError(`oauth provider denied: ${err}${u.searchParams.get('error_description') ? ` — ${u.searchParams.get('error_description')}` : ''}`, { code: 'MCP_OAUTH_DENIED' }));
        return;
      }
      if (u.searchParams.get('state') !== state) {
        // wrong state = not our callback (or CSRF) — refuse but keep waiting
        res.writeHead(400, { 'content-type': 'text/plain' }).end('state mismatch — this callback is not for the in-flight authorization');
        return;
      }
      const code = u.searchParams.get('code');
      if (!code) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('no code in callback');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' }).end('OAuth complete — you can close this tab');
      finish(resolve, { code });
    });
    const timer = setTimeout(() => finish(reject, new McpError('oauth callback timed out', { code: 'MCP_TIMEOUT' })), timeoutMs);
    srv.on('error', (e) => finish(reject, new McpError(`loopback listen failed: ${e?.message ?? e}`, { code: 'MCP_LISTEN' })));
    srv.listen(port, '127.0.0.1');
  });
  return { promise, port, close: () => { try { srv?.close(); } catch { /* best effort */ } } };
}

// dedup-h #1077 — interactive OAuth auto-opens the system browser instead of
// making the operator copy the URL by hand. Best-effort: failure never breaks
// the flow (the URL is still shown for manual open). PAI_OAUTH_NO_AUTO_OPEN=1
// is the operator kill-switch for headless/locked-down environments.
export function openBrowser(url, { spawnImpl = spawn, platform = process.platform } = {}) {
  try {
    if (process.env.PAI_OAUTH_NO_AUTO_OPEN) return false;
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    const [bin, args] = platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', u.href]]
      : platform === 'darwin'
        ? ['open', [u.href]]
        : ['xdg-open', [u.href]];
    const child = spawnImpl(bin, args, { detached: true, stdio: 'ignore' });
    child.on?.('error', () => {});
    child.unref?.();
    return true;
  } catch { return false; }
}

// --- dedup-h #740: RFC 8628 device authorization grant ---------------------
// Headless login: POST deviceAuthUrl → {device_code,user_code,verification_uri,
// interval,expires_in}; the operator authorizes on ANY device; we poll the
// token endpoint honoring authorization_pending / slow_down / expiry.

export async function oauthDeviceAuthorize(oauth, { fetchImpl = fetch } = {}) {
  if (!oauth?.deviceAuthUrl) throw new McpError('oauth.deviceAuthUrl not configured');
  const body = new URLSearchParams({ client_id: oauth.clientId });
  if (oauth.scope) body.set('scope', oauth.scope);
  let res;
  try {
    res = await fetchImpl(oauth.deviceAuthUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new McpError(`device authorization request failed: ${e?.message ?? e}`);
  }
  let doc;
  try { doc = await res.json(); } catch { doc = null; }
  if (!res.ok || !doc || typeof doc.device_code !== 'string' || !doc.device_code) {
    throw new McpError(`device authorization refused: HTTP ${res.status}${doc?.error_description ? ` — ${doc.error_description}` : doc?.error ? ` — ${doc.error}` : ''}`);
  }
  return {
    deviceCode: doc.device_code,
    userCode: String(doc.user_code ?? ''),
    verificationUri: String(doc.verification_uri ?? ''),
    verificationUriComplete: doc.verification_uri_complete ? String(doc.verification_uri_complete) : null,
    intervalSec: Number.isFinite(Number(doc.interval)) ? Math.max(1, Number(doc.interval)) : 5,
    expiresInSec: Number.isFinite(Number(doc.expires_in)) ? Number(doc.expires_in) : 900,
  };
}

export async function oauthDevicePoll(oauth, {
  deviceCode, intervalSec = 5, expiresInSec = 900,
  fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!deviceCode) throw new McpError('deviceCode required');
  const deadline = Date.now() + expiresInSec * 1000;
  let interval = intervalSec;
  for (;;) {
    const res = await fetchImpl(oauth.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode, client_id: oauth.clientId,
        ...(oauth.clientSecret ? { client_secret: oauth.clientSecret } : {}),
      }),
    });
    const doc = await res.json().catch(() => null);
    if (res.ok && doc?.access_token) {
      // body already consumed — build the token record inline (same shape
      // as parseTokenResponse; a second res.json() would throw)
      const ttl = Number.isFinite(doc.expires_in) ? Math.max(0, doc.expires_in) : 3600;
      return {
        accessToken: doc.access_token,
        refreshToken: typeof doc.refresh_token === 'string' ? doc.refresh_token : null,
        expiresAt: Date.now() + Math.max(0, ttl - 60) * 1000,
      };
    }
    const errCode = doc?.error ?? `http_${res.status}`;
    if (errCode === 'authorization_pending' || errCode === 'slow_down') {
      if (errCode === 'slow_down') interval += 5; // RFC 8628 §3.5
      if (Date.now() + interval * 1000 > deadline) throw new McpError('device authorization expired before approval');
      await sleep(interval * 1000);
      continue;
    }
    if (errCode === 'access_denied') throw new McpError('device authorization denied by the operator');
    if (errCode === 'expired_token') throw new McpError('device code expired — begin the flow again');
    throw new McpError(`device token poll failed: ${errCode}${doc?.error_description ? ` — ${doc.error_description}` : ''}`);
  }
}

// Facade-side surface: config/token-store access + spec validation. The
// token store is user-private — the facade reports booleans, never tokens.
export const mcpOperatorSurface = {
  loadConfig, validateOAuthSpec, readTokenStore, writeTokenStore, tokenStorePath,
  oauthDeviceAuthorize, oauthDevicePoll, loopbackListenSpec, oauthLoopbackListen,
  openBrowser,
  // dedup-h #1059 — set by the bootstrap: (toolName) => deferred onto the
  // lazy surface. Null before ToolSurface exists; the bootstrap's post-build
  // prefix pass catches registrations that landed earlier.
  onDeferTools: null,
  // dedup-h #1112 — fired for EVERY post-build tool registration so the
  // bootstrap can re-run visibility filters (allowlist/mode) on late tools.
  onToolRegistered: null,
  // dedup-h #1221 — fired once per server whose connect/handshake died on
  // a 401: the host turns it into an operator notification pointing at
  // /mcp-auth instead of a silent dead entry.
  onAuthRequired: null,
  // dedup-h #1507 — assigned inside mcpExtension(): (serverName, uri) =>
  // {ok, contents|error}; reads a ui:// resource through the live connection.
  readResource: null,
  // dedup-h #1514 — assigned inside mcpExtension(): (serverName) =>
  // {oauth, discovered|error}; RFC 9728/8414 discovery + RFC 7591 client
  // registration for a server that 401s without a configured oauth spec.
  oauthDiscoverRegister: null,
};

// dedup-h #404 — cross-process login (pai-host CLI, shell tooling): the
// pending verifier/state must survive between two separate invocations,
// so the CLI persists it next to the token store (0600, TTL-bounded).
// In-process surfaces (session commands, channel facade) keep their
// in-memory maps — this file is only for stateless invocations.
export function oauthPendingPath() {
  return join(dirname(tokenStorePath()), 'mcp-oauth-pending.json');
}
export function oauthPendingLoad() {
  try { return JSON.parse(readFileSync(oauthPendingPath(), 'utf-8')) ?? {}; } catch { return {}; }
}
export function oauthPendingSave(doc) {
  const p = oauthPendingPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc));
  try { chmodSync(tmp, 0o600); } catch { /* windows ACLs — best effort */ }
  renameSync(tmp, p);
}
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
    ? (oauthSpec.flow !== 'client_credentials' ? oauthStoredTokens(oauthSpec, serverName ?? spec.url) : oauthTokenManager(oauthSpec, spec.url))
    : null;
  if (tokens && oauthSpec.exchange) tokens = oauthExchangedTokens(tokens, oauthSpec);
  const postTimeoutMs = spec.postTimeoutMs ?? POST_TIMEOUT_MS;
  let sessionId = null;
  // dedup-h #1075 — Streamable HTTP server→client channel: the spec lets the
  // server answer GET on the endpoint with a long-lived SSE stream carrying
  // server-initiated messages (notifications like tools/list_changed, and
  // requests). Without it remote servers can never push — stdio/sse already
  // deliver such frames through onMessage, http was silently deaf.
  let messageHandler = null;
  let listenCtl = null;
  let postCompleted = false; // a bare GET before initialize must not burn the "no push" verdict
  const listen = async () => {
    const ctl = new AbortController();
    listenCtl = ctl;
    let retried401 = false;
    while (!ctl.signal.aborted) {
      let res;
      try {
        res = await fetch(spec.url, {
          method: 'GET',
          headers: {
            accept: 'text/event-stream',
            ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
            ...(spec.headers ?? {}),
            ...(tokens ? { authorization: `Bearer ${await tokens.token()}` } : {}),
          },
          signal: ctl.signal,
        });
      } catch { return; } // aborted/unreachable — POST callers surface their own errors
      if (res.status === 401 && tokens && !retried401) { retried401 = true; tokens.invalidate(); continue; }
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        res.body?.cancel().catch(() => {}); // server offers no push stream (405/404/json) — do not retry
        return;
      }
      retried401 = false;
      try {
        let buf = '';
        const dec = new TextDecoder();
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let sep;
          while ((sep = buf.search(/\r?\n\r?\n/)) >= 0) {
            const block = buf.slice(0, sep);
            buf = buf.slice(sep + buf.slice(sep).match(/^\r?\n\r?\n/)[0].length);
            const data = parseSseBlock(block);
            if (!data) continue;
            try { messageHandler?.(JSON.parse(data)); } catch { /* malformed frame skipped */ }
          }
        }
      } catch { /* stream reset or aborted */ }
      if (ctl.signal.aborted) return;
      // stream ended cleanly — the spec allows re-listening; bounded backoff
      await new Promise((r) => {
        const t = setTimeout(r, 1000);
        ctl.signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
      });
    }
  };
  const maybeListen = () => {
    if (!messageHandler || !postCompleted || listenCtl) return;
    void listen();
  };
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
    // dedup-h #1221 — a 401 that survives the token retry (or arrives with
    // no oauth configured at all) is an AUTH REQUIRED signal, not a generic
    // HTTP failure: surface it typed so the caller can prompt the operator
    // to authorize instead of silently failing. WWW-Authenticate rides
    // along for diagnostics/discovery.
    if (res.status === 401) {
      throw new McpError(
        `mcp server '${serverName ?? spec.url}' requires OAuth authorization (HTTP 401) — run /mcp-auth ${serverName ?? '<server>'}`,
        { code: 'MCP_AUTH_REQUIRED', wwwAuthenticate: res.headers.get('www-authenticate') ?? null },
      );
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
    onMessage: (fn) => { messageHandler = fn; maybeListen(); },
    onExit: () => {},
    callHttp: async (msg, signal) => {
      const out = readResponse(await post(msg, signal));
      postCompleted = true;
      maybeListen(); // start the push stream once initialize has run
      return out;
    },
    notify: async (msg) => { await post(msg, AbortSignal.timeout(postTimeoutMs)).catch(() => {}); },
    close: () => { listenCtl?.abort(); },
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
    ? (oauthSpec.flow !== 'client_credentials' ? oauthStoredTokens(oauthSpec, serverName ?? spec.url) : oauthTokenManager(oauthSpec, spec.url))
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
    if (!res.ok || !res.body) {
      if (res.status === 401) {
        throw new McpError(
          `mcp server '${serverName ?? spec.url}' requires OAuth authorization (HTTP 401) — run /mcp-auth ${serverName ?? '<server>'}`,
          { code: 'MCP_AUTH_REQUIRED', wwwAuthenticate: res.headers.get('www-authenticate') ?? null },
        );
      }
      throw new McpError(`sse connect failed: HTTP ${res.status}`, { code: 'MCP_CONNECT' });
    }
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
  // dedup-h #1221 — a 401 that survives the token retry (or has no oauth)
  // is AUTH REQUIRED, phrased so the operator sees the remedy, not just
  // a bare status.
  const authErr = () => `mcp server '${serverName ?? spec.url}' requires OAuth authorization (HTTP 401) — run /mcp-auth ${serverName ?? '<server>'}`;

  return {
    kind: 'sse',
    // send() never awaits the response — legacy SSE answers on the stream.
    // A failed POST is fed back as a synthetic JSON-RPC error so the
    // pending request rejects instead of hanging to timeout.
    send: (msg) => {
      if (closed) return;
      handshake.then(() => doPost(msg)).then((res) => {
        if (res.status >= 400 && msg.id != null) {
          pending.onMessage?.({ jsonrpc: '2.0', id: msg.id, error: { code: res.status === 401 ? -32401 : -32000, message: res.status === 401 ? authErr() : `sse POST HTTP ${res.status}` } });
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
  #exitHandlers = [];
  #requestHandlers = new Map(); // dedup-h #2202 — server→client requests (elicitation)

  constructor(transport) {
    this.#transport = transport;
    transport.onMessage?.((msg) => this.#dispatch(msg));
    transport.onExit?.(() => {
      // dedup-h #1521 — an UNINTENTIONAL death (server process exit, closed
      // HTTP stream) notifies exit handlers so the extension can schedule a
      // bounded reconnect; close() sets #closed first, so an intentional
      // shutdown never fires them.
      const intentional = this.#closed;
      this.#failAll(new McpError('mcp server process exited', { code: 'MCP_EXIT' }));
      if (!intentional) {
        for (const fn of this.#exitHandlers) { try { fn(); } catch { /* best effort */ } }
      }
    });
  }

  /**
   * M130: subscribe to server→client notifications (tools/list_changed,
   * prompts/list_changed). stdio carries them as id-less JSON-RPC frames;
   * the HTTP transport has no push channel in v1 so no notifications ever
   * arrive there — handlers just never fire.
   */
  onNotification(fn) { this.#notifyHandlers.push(fn); }

  /** dedup-h #2202 — handle a server→client request (e.g. elicitation/create). */
  onRequest(method, fn) { this.#requestHandlers.set(method, fn); }

  // dedup-h #1521 — fires ONLY on unexpected transport death (never on
  // close()); the extension uses it to schedule bounded reconnects.
  onServerExit(fn) { this.#exitHandlers.push(fn); }

  static async connect(spec, { timeoutMs = DEFAULT_TIMEOUT_MS, serverName = null, serverRequests = null } = {}) {
    // dedup-h #583 — remote HTTP transport type + alias compatibility:
    // 'remote' (v2.50.2 remote transport) and streamable-http spelling
    // variants normalize to the canonical kind BEFORE validation.
    const ALIASES = { remote: 'streamable-http', streamablehttp: 'streamable-http', streamable_http: 'streamable-http' };
    const kind = ALIASES[String(spec.transport ?? '').toLowerCase()] ?? (spec.transport ?? 'auto');
    if (!['auto', 'http', 'streamable-http', 'sse'].includes(kind)) {
      throw new McpError(`mcp spec transport '${spec.transport}' unsupported — expected http|streamable-http|sse`, { code: 'MCP_SPEC' });
    }
    const transport = !spec.url ? stdioTransport(spec)
      : kind === 'sse' ? sseTransport(spec, { serverName })
      : httpTransport(spec, { serverName });
    const client = new McpClient(transport);
    // dedup-h #2202 — server→client request handlers must be bound BEFORE
    // initialize: the advertised elicitation capability and the dispatch
    // table are decided from the same map.
    if (serverRequests && typeof serverRequests === 'object') {
      for (const [m, fn] of Object.entries(serverRequests)) {
        if (typeof fn === 'function') client.#requestHandlers.set(m, fn);
      }
    }
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
    // Server→client notification: has method, no id. Server REQUEST: has
    // method AND id — routed to #requestHandlers (dedup-h #2202); unknown
    // methods get a real -32601 answer instead of a silent drop, so the
    // server is never left hanging on a request we cannot serve.
    if (msg.id == null) {
      if (typeof msg.method === 'string') {
        for (const fn of this.#notifyHandlers) {
          try { fn(msg); } catch { /* a bad handler must not kill the pump */ }
        }
      }
      return;
    }
    if (typeof msg.method === 'string') {
      const h = this.#requestHandlers.get(msg.method);
      // reply primitive differs by transport: stdio/sse write the frame,
      // streamable-http POSTs it fire-and-forget via notify().
      const reply = (frame) => {
        try {
          if (typeof this.#transport.send === 'function') this.#transport.send(frame);
          else this.#transport.notify?.(frame)?.catch?.(() => {});
        } catch { /* transport gone */ }
      };
      void Promise.resolve()
        .then(() => h(msg.params ?? {}))
        .then((result) => reply({ jsonrpc: '2.0', id: msg.id, result }))
        .catch((err) => reply({
          jsonrpc: '2.0', id: msg.id,
          error: { code: h ? -32603 : -32601, message: String(err?.message ?? err ?? 'method not found').slice(0, 300) },
        }));
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
      // dedup-h #2202 — elicitation capability is advertised exactly when an
      // 'elicitation/create' handler is bound: servers only send requests a
      // capable client answered for.
      params: {
        protocolVersion: PROTOCOL_VERSION, clientInfo: CLIENT_INFO,
        capabilities: this.#requestHandlers.has('elicitation/create') ? { elicitation: {} } : {},
      },
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

  // dedup-h #1507 — MCP Apps resource fetch: the declared ui:// surface is
  // read through resources/read like any other MCP resource.
  readResource(uri, { signal, timeoutMs } = {}) {
    return this.request('resources/read', { uri: String(uri ?? '') }, { signal, timeoutMs });
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
// dedup-h #1509 — 'oauth' joins the expansion set: a pre-registered
// confidential client can keep its secret out of the config file via
// ${VAR} (clientId/tokenUrl expand too); an unset var lands in missingEnv
// and the literal fails honestly at the token endpoint.
const EXPAND_FIELDS = ['command', 'args', 'env', 'url', 'headers', 'oauth'];

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

/* dedup-h #1504 — MCP Apps tool calls: a tool may declare an interactive UI
 * surface via _meta ('ui/resourceUri' — MCP-UI/Apps spec — or the OpenAI
 * Apps SDK key 'openai/outputTemplate'). This harness cannot render HTML —
 * honest surface = the declaration must REACH the model and any downstream
 * host: it rides the tool description at registration and details.ui on
 * every result, so callers can resolve the resource themselves. */
const APP_META_KEYS = ['ui/resourceUri', 'openai/outputTemplate', 'mcp-app.dev/resourceUri'];
function appMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  for (const key of APP_META_KEYS) {
    const v = meta[key];
    if (typeof v === 'string' && v.trim()) return { key, uri: v.trim() };
  }
  return null;
}

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
  // dedup-h #1390 — per-server agent-context scoping: spec.context limits
  // which agent id may connect ('operator' = the primary interactive body;
  // delegate children run under their profile name via PAI_AGENT_ID, a
  // dedicated bridge flag a profile/env can never inject). Narrowing only —
  // a non-matching context never connects, not even to probe. Absent
  // context = every agent sees the server (back-compat); '*' = wildcard.
  const AGENT_ID = (process.env.PAI_AGENT_ID ?? '').trim() || 'operator';
  const contextList = (spec) => {
    if (spec == null || typeof spec !== 'object' || spec.context == null) return null;
    const c = spec.context;
    return (Array.isArray(c) ? c : [c]).map((s) => String(s).trim()).filter(Boolean);
  };
  const contextAllowed = (spec) => {
    const list = contextList(spec);
    if (list == null) return true;                    // no context field → global
    return list.includes('*') || list.includes(AGENT_ID);
  };
  const contextExcluded = new Set();                // context declared, current agent not in it
  // dedup-h #524 — per-server enable/disable: spec.enabled===false (or the
  // legacy spec.disabled===true) keeps the entry configured but never
  // connects it. The toggle is mutable: /mcp-disable closes the live
  // client NOW; /mcp-enable re-reads the config and connects NOW — a
  // config-only no-op until restart would be dishonest.
  const disabled = new Set();
  const servers = Object.fromEntries(Object.entries(allServers).filter(([name, spec]) => {
    if (denied.has(name)) return false;
    if (!contextAllowed(spec)) { contextExcluded.add(name); return false; }
    if (spec && typeof spec === 'object' && (spec.enabled === false || spec.disabled === true)) {
      disabled.add(name);
      return false;
    }
    return true;
  }));
  /** @type {Map<string, {client:McpClient|null, tools:string[], spec:object, failed?:boolean, prompts?:object[], dead?:Set<string>, lastRefresh?:object}>} */
  const connected = new Map();

  // dedup-h #1507 — host-side MCP Apps rendering needs resources/read: the
  // channel fetches a declared ui:// resource through the LIVE connection
  // (the ui:// scheme is not a network address — only the server that
  // declared it can resolve it). Bounded to ui: URIs — other schemes are not
  // what this surface is for.
  mcpOperatorSurface.readResource = async (name, uri) => {
    const u = String(uri ?? '').trim();
    if (!/^ui:/i.test(u)) return { ok: false, error: `mcp resource read is bounded to ui:// declarations — got '${u.slice(0, 80)}'` };
    const entry = connected.get(String(name ?? ''));
    if (!entry?.client) return { ok: false, error: `mcp server '${name}' is not connected` };
    try {
      const res = await entry.client.readResource(u, { timeoutMs: 15_000 });
      const contents = (res?.contents ?? []).slice(0, 8).map((c) => ({
        uri: c?.uri ?? u,
        mimeType: c?.mimeType ?? null,
        text: typeof c?.text === 'string' ? c.text.slice(0, 1024 * 1024) : null,
        blob: typeof c?.blob === 'string' ? c.blob.slice(0, 2 * 1024 * 1024) : null,
      }));
      if (!contents.length) return { ok: false, error: `server '${name}' returned no contents for ${u.slice(0, 80)}` };
      return { ok: true, contents };
    } catch (e) {
      return { ok: false, error: `resources/read failed: ${e?.message ?? e}` };
    }
  };

  // dedup-h #1514 — OAuth discovery for a server that 401s without a
  // configured oauth spec: PRM → ASM metadata, then RFC 7591 dynamic
  // client registration (reused across restarts via the token store's
  // `client` field — registration is one-time, not per-auth).
  mcpOperatorSurface.oauthDiscoverRegister = async (name) => {
    const entry = connected.get(String(name ?? ''));
    const { servers: cfgServers } = loadConfig();
    const spec = entry?.spec ?? cfgServers?.[name];
    if (!spec?.url) return { error: `server '${name}' has no remote url to discover from` };
    let meta;
    try {
      meta = await discoverOAuthMetadata(spec.url, entry?.wwwAuth ?? null);
    } catch (e) {
      return { error: `oauth discovery failed: ${e?.message ?? e}` };
    }
    if (!meta.authorizationUrl && !meta.deviceAuthUrl) {
      return { error: 'authorization server metadata offers no interactive flow (no authorization/device endpoint)' };
    }
    const store = readTokenStore();
    let client = store[name]?.client;
    if (!client?.clientId) {
      if (!meta.registrationUrl) {
        return {
          error: 'server requires OAuth but offers no dynamic registration endpoint — configure oauth.clientId manually (see /mcp-add --oauth-*)',
          discovered: { tokenUrl: meta.tokenUrl, authorizationUrl: meta.authorizationUrl },
        };
      }
      try {
        const c = await registerOAuthClient(meta.registrationUrl, {
          redirectUris: ['http://localhost:8765/callback', 'urn:ietf:wg:oauth:2.0:oob'],
        });
        client = { clientId: c.clientId, clientSecret: c.clientSecret };
      } catch (e) {
        return { error: `client registration failed: ${e?.message ?? e}` };
      }
      store[name] = { ...(store[name] ?? {}), client };
      writeTokenStore(store);
    }
    return {
      oauth: {
        tokenUrl: meta.tokenUrl,
        ...(meta.authorizationUrl ? { authorizationUrl: meta.authorizationUrl } : {}),
        ...(meta.deviceAuthUrl ? { deviceAuthUrl: meta.deviceAuthUrl } : {}),
        clientId: client.clientId,
        ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
        ...(meta.scope ? { scope: meta.scope } : {}),
        loopbackRedirect: true,
      },
      discovered: { issuer: meta.issuer, registration: 'dynamic', scope: meta.scope },
    };
  };

  // M130 tools/list_changed: a server that hot-swaps its catalog re-lists.
  // New tools register live; REMOVED tools cannot be unregistered through the
  // pi API — they tombstone into an honest fail-closed error instead of
  // silently calling a tool the server no longer advertises.
  // dedup-h #1521 — the tool binds the live ENTRY, not a client snapshot:
  // a reconnected server swaps entry.client and every registered tool keeps
  // working without re-registration.
  const registerMcpTool = (serverName, entry, t) => {
    const toolName = `mcp__${serverName}__${t.name}`;
    const app = appMeta(t._meta); // #1504 — MCP Apps UI declaration
    pi.registerTool({
      name: toolName,
      label: `MCP ${serverName}: ${t.name}`,
      description: `[mcp:${serverName}] ${t.description ?? t.name}` + (app ? ` — ui-app: ${app.uri}` : ''),
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
          if (!entry.client) {
            return {
              content: [{ type: 'text', text: `mcp server '${serverName}' is not connected — it may be reconnecting or dead; check /mcp` }],
              isError: true,
            };
          }
          const res = await entry.client.callTool(t.name, params, { signal, timeoutMs: TOOL_TIMEOUT_MS });
          const wrapped = wrapUntrusted(serverName, t.name, res, resultCharCap(entry.spec, t.name));
          // #1504 — surface the declared app resource on every call result.
          // #1507 — the host routes resources/read via details.mcpServer
          // (wrapUntrusted already stamps it on every MCP result).
          if (app) wrapped.details = { ...wrapped.details, ui: { key: app.key, uri: app.uri } };
          return wrapped;
        } catch (err) {
          return {
            content: [{ type: 'text', text: `mcp call failed (${serverName}/${t.name}): ${err?.message ?? err}` }],
            isError: true,
          };
        }
      },
    });
    // dedup-h #1059 — spec.defer_loading: the tool registers but joins the
    // lazy surface instead of the eager schema list. The callback is set by
    // the bootstrap once ToolSurface exists; before that, the bootstrap's
    // post-build prefix pass defers boot-time registrations.
    if (entry.spec?.defer_loading === true) mcpOperatorSurface.onDeferTools?.(toolName);
    // dedup-h #1112 — any post-build registration must re-run the surface
    // filters (allowlist, mode hides): a late tool is not exempt.
    mcpOperatorSurface.onToolRegistered?.(toolName);
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
        if (!before.has(tn)) added.push(registerMcpTool(name, entry, t));
      }
      const removed = [...before].filter((tn) => !freshNames.has(tn));
      entry.dead = new Set(removed);
      entry.tools = [...freshNames];
      entry.lastRefresh = { at: new Date().toISOString(), added: added.length, removed: removed.length };
    } catch { /* refresh failure keeps the last-known catalog */ }
  };

  // dedup-h #1521 — prompts get the same diff-refresh path as tools (list_
  // changed, pendingPrompt flush, and reconnect all share it): register only
  // names the catalog gained; nothing can unregister, so removed prompts keep
  // their honest no-text path.
  const refreshPrompts = async (name, entry) => {
    if (!entry?.client) return;
    try {
      const prompts = await entry.client.listPrompts();
      const known = new Set((entry.prompts ?? []).map((p) => p.name));
      for (const p of prompts) {
        if (known.has(p.name)) continue;
        entry.prompts.push({ name: p.name, description: p.description ?? null, args: p.arguments ?? [] });
        registerPromptCommand(name, p, entry);
      }
    } catch { /* refresh failure keeps the last-known catalog */ }
  };

  // M82: an MCP prompt is an operator-invoked slash command that expands to
  // the server-supplied messages as a user turn. The operator asked for it
  // explicitly (like Claude Code's /mcp__server__prompt), but the transcript
  // keeps a provenance prefix — server text is still external content.
  // dedup-h #1521 — takes the live ENTRY, not a client snapshot: a reconnected
  // server swaps entry.client and every registered prompt keeps working.
  const registerPromptCommand = (serverName, prompt, entry) => {
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
          if (!entry.client) {
            ctx.ui?.notify?.(`mcp prompt '${prompt.name}' unavailable — server '${serverName}' is not connected`, 'error');
            return;
          }
          const res = await entry.client.getPrompt(prompt.name, values);
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

  // dedup-h #1521 — bounded auto-reconnect: an unexpectedly dead transport
  // (stdio exit, closed HTTP stream) respawns through the SAME connectOne
  // path — the reused entry keeps tools/prompts bound via entry.client, and
  // the catalog re-diffs like a list_changed. 3 attempts at 2s/5s/10s;
  // exhausted → the entry stays honestly failed and /mcp says so.
  // session_shutdown, /mcp-disable, and context-scoped entries never schedule.
  let shuttingDown = false;
  // Operator-tunable backoff (tests use it too): comma list in ms; a bad
  // value falls back to the default rather than silently disabling retries.
  const RECONNECT_DELAYS_MS = (process.env.PAI_MCP_RECONNECT_DELAYS ?? '')
    .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  if (RECONNECT_DELAYS_MS.length === 0) RECONNECT_DELAYS_MS.push(2_000, 5_000, 10_000);
  const scheduleReconnect = (name, spec) => {
    if (shuttingDown || disabled.has(name)) return;
    const entry = connected.get(name);
    if (!entry || entry.reconnectTimer) return;
    entry.reconnectAttempt = (entry.reconnectAttempt ?? 0) + 1;
    if (entry.reconnectAttempt > RECONNECT_DELAYS_MS.length) {
      entry.client = null;
      entry.failed = true;
      entry.reconnecting = false;
      entry.reconnectExhausted = true;
      return;
    }
    const delay = RECONNECT_DELAYS_MS[entry.reconnectAttempt - 1];
    entry.reconnecting = true;
    entry.reconnectTimer = setTimeout(async () => {
      entry.reconnectTimer = null;
      if (shuttingDown || disabled.has(name)) return;
      try {
        const fresh = await connectOne(name, spec);
        if (fresh?.client) return; // revived — connectOne reset the counter
      } catch { /* connectOne failure already lands on the entry */ }
      // still dead — chain the next attempt through the same gate (counter,
      // shutdown, disabled) until the bound is exhausted.
      scheduleReconnect(name, spec);
    }, delay);
    entry.reconnectTimer.unref?.();
  };

  // dedup-h #167: extracted per-server connect so /mcp-add hot-connects a
  // newly persisted entry through the EXACT same path as boot servers —
  // notification subscription, independent family discovery, pending
  // refresh flush, honest failed marker.
  const connectOne = async (name, spec) => {
      // #1390 backstop: /mcp-add and /mcp-enable re-read the config and reach
      // here directly, bypassing the boot filter — a context-scoped server
      // must not connect for the wrong agent id on those paths either.
      if (!contextAllowed(spec)) {
        contextExcluded.add(name);
        return { failed: true, contextScoped: true, tools: [], spec };
      }
      try {
        const client = await McpClient.connect(spec, {
          timeoutMs: CONNECT_TIMEOUT_MS, serverName: name,
          // dedup-h #2202 — elicitation: server may ask the operator for
          // structured input mid-tool-call. Bound before initialize so the
          // capability is advertised only when the handler exists.
          serverRequests: { 'elicitation/create': (params) => handleElicitation(name, params) },
        });
        // dedup-h #1521 — the entry is REUSED across reconnects: registered
        // tools/prompts bind entry.client (never a dead snapshot), so a
        // revived server restores the whole surface without re-registration.
        const prev = connected.get(name);
        const entry = prev ?? { client: null, tools: [], spec, prompts: [], dead: new Set(), booted: false };
        const isReconnect = prev?.client != null;
        entry.client = client;
        entry.spec = spec;
        entry.failed = false;
        entry.authRequired = false;
        entry.wwwAuth = null;
        entry.reconnectExhausted = false;
        entry.reconnectAttempt = 0;
        entry.reconnecting = false;
        connected.set(name, entry);
        // an unexpected transport death schedules a bounded reconnect; an
        // intentional close() (shutdown, /mcp-disable) never does.
        client.onServerExit?.(() => scheduleReconnect(name, spec));
        // M130: subscribe BEFORE family discovery — a list_changed pushed
        // while tools/list or prompts/list is still in flight (or hung on a
        // server that silently drops unknown methods) must not be lost.
        client.onNotification((msg) => {
          const refresh = async () => {
            if (!entry.booted) { entry.pendingRefresh = true; return; }
            await refreshTools(name, entry);
          };
          const refreshP = async () => {
            if (!entry.booted) { entry.pendingPromptRefresh = true; return; }
            await refreshPrompts(name, entry);
          };
          if (msg?.method === 'notifications/tools/list_changed') void refresh();
          if (msg?.method === 'notifications/prompts/list_changed') void refreshP();
        });
        if (isReconnect) {
          // #1521 — reconnection diffs the catalog like a list_changed:
          // tools/prompts the revived server dropped tombstone honestly;
          // new ones register live. Registered closures already bind
          // entry.client, so unchanged tools just work.
          entry.booted = true;
          await refreshTools(name, entry);
          await refreshPrompts(name, entry);
        } else {
          // M82: capability families discover independently — a prompt-only
          // server answers Method-not-found on tools/list and that must NOT
          // kill prompts/list (and vice versa). A connect/handshake failure is
          // still fatal; a per-family failure is not.
          const names = [];
          try {
            const tools = await client.listTools();
            for (const t of tools) names.push(registerMcpTool(name, entry, t));
            entry.tools = names;
          } catch { /* no tools capability */ }
          try {
            const prompts = await client.listPrompts();
            for (const p of prompts) {
              entry.prompts.push({ name: p.name, description: p.description ?? null, args: p.arguments ?? [] });
              registerPromptCommand(name, p, entry);
            }
          } catch { /* no prompts capability */ }
          // discovery done — flush any list_changed that arrived mid-boot
          entry.booted = true;
          if (entry.pendingRefresh) { entry.pendingRefresh = false; void refreshTools(name, entry); }
          if (entry.pendingPromptRefresh) {
            entry.pendingPromptRefresh = false;
            void refreshPrompts(name, entry);
          }
        }
      } catch (err) {
        // connect/handshake failure → this server contributes no tools;
        // /mcp reports it as failed so the operator can see why.
        // dedup-h #1221: a 401 is not a generic failure — mark the entry
        // authRequired and raise the operator hook so the UI can offer the
        // /mcp-auth path instead of a silent dead server.
        const authRequired = err?.code === 'MCP_AUTH_REQUIRED';
        // #1514 — the 401's WWW-Authenticate header is kept for the
        // discovery path (resource_metadata pointer). #1521 — the entry is
        // reused so catalog state and the retry counter survive failures.
        const entry = connected.get(name) ?? { client: null, tools: [], spec, prompts: [], dead: new Set(), booted: false };
        entry.client = null;
        entry.spec = spec;
        entry.failed = true;
        entry.authRequired = authRequired;
        entry.wwwAuth = err?.wwwAuthenticate ?? null;
        connected.set(name, entry);
        if (authRequired) mcpOperatorSurface.onAuthRequired?.(name);
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

  // dedup-h #2202 — MCP elicitation: a server request mid-tool-call asks the
  // operator for structured input (message + JSON-schema fields). With a
  // real UI each field prompts interactively (boolean→confirm, others→input,
  // enum values hinted); undefined input or an empty required field answers
  // 'cancel'. Without a UI we answer 'decline' — spec-compliant and the
  // server is never left hanging either way. Bounded at 10 fields.
  let uiCtx = null;
  const handleElicitation = async (serverName, params) => {
    if (!uiCtx) return { action: 'decline' };
    const message = String(params?.message ?? 'input requested').slice(0, 160);
    const schema = params?.requestedSchema ?? {};
    const props = schema?.properties ?? {};
    const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
    const content = {};
    try {
      for (const n of Object.keys(props).slice(0, 10)) {
        const f = props[n] ?? {};
        const title = `mcp:${serverName} — ${message} — ${n}`.slice(0, 180);
        if (f.type === 'boolean') {
          content[n] = await uiCtx.confirm(title, String(f.description ?? n).slice(0, 200));
          continue;
        }
        const enumHint = Array.isArray(f.enum) ? ` [${f.enum.slice(0, 8).join(' | ')}]` : '';
        const raw = await uiCtx.input(title, `${String(f.description ?? '').slice(0, 100)}${enumHint}`.trim() || n);
        if (raw == null) return { action: 'cancel' };
        if (required.has(n) && raw === '') return { action: 'cancel' };
        content[n] = (f.type === 'number' || f.type === 'integer') ? Number(raw) : raw;
      }
      return { action: 'accept', content };
    } catch {
      return { action: 'cancel' };
    }
  };
  pi.on('session_start', (_ev, ctx) => { uiCtx = ctx?.hasUI ? ctx.ui : null; });
  pi.on('session_shutdown', () => {
    uiCtx = null;
    // #1521 — fail-closed: no reconnect may outlive the session. Pending
    // retry timers are cancelled; live clients close (an intentional close
    // never schedules a retry).
    shuttingDown = true;
    for (const [, entry] of connected) {
      if (entry.reconnectTimer) { clearTimeout(entry.reconnectTimer); entry.reconnectTimer = null; }
      entry.client?.close();
    }
    connected.clear();
    for (const [, pend] of pendingAuth) pend.listen?.close?.();
    pendingAuth.clear();
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
        // #1521 — a reconnecting or exhausted entry gets an honest status
        // instead of the generic FAILED line.
        const statusLine = entry.reconnecting
          ? `  ${name}: RECONNECTING (attempt ${entry.reconnectAttempt}/${RECONNECT_DELAYS_MS.length}) — tools will fail until the server revives`
          : entry.reconnectExhausted
            ? `  ${name}: CONNECTION LOST — reconnect retries exhausted; /mcp-enable ${name} retries`
            : entry.failed
              ? (entry.authRequired
                ? `  ${name}: NEEDS AUTH (HTTP 401) — run /mcp-auth ${name} to authorize, then restart the session`
                : `  ${name}: FAILED to connect/list — no tools exposed`)
              : `  ${name}: connected — ${entry.tools.length} tools, ${entry.prompts?.length ?? 0} prompts`;
        lines.push(statusLine);
        if (entry.client?.strippedEnv?.length) lines.push(`    env stripped (injection-vector keys): ${entry.client.strippedEnv.join(', ')}`);
        if (entry.client?.oauth) lines.push(`    auth: ${entry.client.oauth}`);
        const hdrCount = Object.keys(entry.spec?.headers ?? {}).length;
        if (hdrCount) lines.push(`    headers: ${hdrCount} configured (values redacted)`);
        if (entry.spec?.defer_loading === true) lines.push('    defer_loading: tools lazy — discover via tool_search, claim via tool_activate');
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
      if (contextExcluded.size) {
        lines.push(`  scoped to other agent context (spec.context): ${[...contextExcluded].join(', ')} — hidden for agent '${AGENT_ID}'`);
      }
      if (disabled.size) {
        lines.push(`  disabled (enabled:false in config — /mcp-enable <name> to restore): ${[...disabled].join(', ')}`);
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
      if (o?.flow !== 'authorization_code' && o?.flow !== 'device_code') {
        return { error: `server '${name}' has no interactive oauth flow configured (authorizationUrl or deviceAuthUrl)` };
      }
      return { oauth: o };
    } catch (err) { return { error: `server '${name}': ${err?.message ?? err}` }; }
  };

  pi.registerCommand('mcp-auth', {
    description: 'Begin OAuth for a remote MCP server — authorization_code+PKCE prints an approval URL; device_code shows a code to enter on any device',
    handler: async (args, ctx) => {
      await boot;
      const name = String(args ?? '').trim().split(/\s+/)[0] ?? '';
      if (!name) { ctx.ui?.notify?.('usage: /mcp-auth <server>', 'error'); return; }
      const { oauth, error } = oauthSpecFor(name);
      if (error) { ctx.ui?.notify?.(error, 'error'); return; }
      if (oauth.flow === 'device_code') {
        // RFC 8628: one POST yields the user-facing code; we poll the token
        // endpoint detached until the operator approves or the code expires.
        if (pendingAuth.has(name)) { ctx.ui?.notify?.(`device flow already running for '${name}'`, 'info'); return; }
        try {
          const d = await oauthDeviceAuthorize(oauth);
          pendingAuth.set(name, { device: true, deadline: Date.now() + d.expiresInSec * 1000 });
          // dedup-h #1077 — verification_uri_complete already embeds the user
          // code; auto-opening it turns device login into one approval click.
          const opened = mcpOperatorSurface.openBrowser(d.verificationUriComplete ?? d.verificationUri);
          ctx.ui?.notify?.(
            `Device login for '${name}' — ${opened ? 'opened in your browser' : `open ${d.verificationUri} on any device`} and enter code:\n\n` +
            `  ${d.userCode}\n\nexpires in ${Math.round(d.expiresInSec / 60)}min; polling automatically completes the login`,
            'info',
          );
          oauthDevicePoll(oauth, d).then((t) => {
            pendingAuth.delete(name);
            const store = readTokenStore();
            store[name] = {
              access_token: t.accessToken, refresh_token: t.refreshToken,
              expires_at: t.expiresAt, obtained: new Date().toISOString(), flow: 'device_code',
            };
            writeTokenStore(store);
            ctx.ui?.notify?.(`OAuth complete for '${name}' (device flow) — token stored; restart the session if this server failed earlier`, 'info');
          }).catch((e) => {
            pendingAuth.delete(name);
            ctx.ui?.notify?.(`device flow for '${name}' failed: ${e?.message ?? e}`, 'error');
          });
        } catch (e) {
          ctx.ui?.notify?.(`device authorization failed for '${name}': ${e?.message ?? e}`, 'error');
        }
        return;
      }
      const { url, verifier, state } = oauthBuildAuthorizeUrl(oauth, servers[name]?.url);
      // dedup-h #1065 — a loopback redirectUri completes WITHOUT paste: the
      // receiver captures ?code, validates state, exchanges + stores, then
      // reports through the same notification path as the device flow.
      const lspec = loopbackListenSpec(oauth.redirectUri);
      const entry = { verifier, state, deadline: Date.now() + OAUTH_PENDING_TTL_MS };
      if (lspec) {
        try {
          entry.listen = oauthLoopbackListen({ ...lspec, state, timeoutMs: OAUTH_PENDING_TTL_MS });
          entry.listen.promise.then(({ code }) => {
            const pend = pendingAuth.get(name);
            if (!pend) return;
            pendingAuth.delete(name);
            oauthExchangeCode(oauth, { code, verifier: pend.verifier }).then((t) => {
              const store = readTokenStore();
              store[name] = {
                access_token: t.accessToken, refresh_token: t.refreshToken,
                expires_at: t.expiresAt, obtained: new Date().toISOString(), flow: 'authorization_code',
              };
              writeTokenStore(store);
              ctx.ui?.notify?.(`OAuth complete for '${name}' (loopback redirect) — token stored`, 'info');
            }).catch((e) => ctx.ui?.notify?.(`token exchange for '${name}' failed: ${e?.message ?? e}`, 'error'));
          }).catch((e) => {
            pendingAuth.delete(name);
            ctx.ui?.notify?.(`OAuth loopback receiver for '${name}': ${e?.message ?? e}`, 'error');
          });
        } catch (e) {
          ctx.ui?.notify?.(`loopback listener for '${name}' failed to start: ${e?.message ?? e} — falling back to paste flow`, 'warning');
        }
      }
      pendingAuth.set(name, entry);
      const opened = mcpOperatorSurface.openBrowser(url);
      ctx.ui?.notify?.(
        `OAuth for '${name}' — ${opened ? 'opened in your browser' : 'open this URL'}, approve` +
        `${entry.listen ? ' — the callback completes it automatically' : ', then paste the code'}:\n\n${url}\n\n` +
        (entry.listen
          ? `Listening on ${oauth.redirectUri} (paste still works as fallback).`
          : `Then run: /mcp-auth-done ${name} <code>   (valid for 10 minutes)`),
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
      if (pend?.device) { ctx.ui?.notify?.(`'${name}' uses the device flow — approval completes automatically, no code to paste`, 'info'); return; }
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
        // dedup-h #1509 — the secret half of a pre-registered client: literal
        // persists verbatim (operator config is a plaintext store, like
        // headers); -env persists the ${VAR} reference instead so the secret
        // never sits in mcp.json at all.
        } else if (words[i] === '--oauth-client-secret' && words[i + 1]) {
          oauth.clientSecret = words[++i];
        } else if (words[i] === '--oauth-client-secret-env' && words[i + 1]) {
          oauth.clientSecret = `\${${words[++i]}}`;
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
      // dedup-h #1509 — the persisted config keeps the ${VAR} reference; the
      // immediate connect resolves it the same way loadConfig does on boot.
      const connectSpec = spec.oauth
        ? { ...spec, oauth: expandEnvPlaceholders(spec.oauth, new Set()) }
        : spec;
      const entry = await connectOne(name, connectSpec);
      const kind = spec.url ? `${spec.transport === 'sse' ? 'sse' : 'http'} ${redactUrl(spec.url)}` : `stdio '${[spec.command, ...(spec.args ?? [])].join(' ')}'`;
      if (entry?.contextScoped) {
        delete servers[name];
        ctx.ui?.notify?.(`added '${name}' (${kind}) to ${target} — scoped to agent context ${JSON.stringify(contextList(spec))}; not connected under agent '${AGENT_ID}'`, 'info');
        return;
      }
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

  // ---------------------------------------------------------------------
  // dedup-h #524 — mcp enable/disable: toggle persists into the SAME config
  // file the entry was loaded from (the scope is where it was declared),
  // and applies to the live session NOW — disable closes the client,
  // enable connects through the same connectOne path as boot.
  const persistEnabled = (name, enabled) => {
    const { path: cfgPath } = loadConfig();
    if (!cfgPath) return { error: 'no MCP config file loaded — nothing to edit' };
    let doc;
    try { doc = JSON.parse(readFileSync(cfgPath, 'utf-8')); }
    catch (e) { return { error: `config '${cfgPath}' unreadable: ${e.message}` }; }
    const key = doc.mcpServers != null ? 'mcpServers' : (doc.servers != null ? 'servers' : null);
    if (!key || !doc[key]?.[name] || typeof doc[key][name] !== 'object') {
      return { error: `server '${name}' not found in ${cfgPath}` };
    }
    doc[key][name].enabled = enabled;
    delete doc[key][name].disabled; // legacy alias normalized to the canonical field
    try {
      const tmp = `${cfgPath}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
      renameSync(tmp, cfgPath);
    } catch (e) { return { error: `persist failed: ${e.message}` }; }
    return { ok: true, path: cfgPath };
  };

  pi.registerCommand('mcp-disable', {
    description: 'Disable an MCP server — persists enabled:false and closes its connection now',
    handler: async (arg, ctx) => {
      const name = String(arg ?? '').trim();
      if (!name) { ctx.ui?.notify?.('usage: /mcp-disable <server>', 'error'); return; }
      if (!(name in allServers)) { ctx.ui?.notify?.(`unknown server '${name}'`, 'error'); return; }
      const w = persistEnabled(name, false);
      if (w.error) { ctx.ui?.notify?.(w.error, 'error'); return; }
      disabled.add(name);
      delete servers[name];
      const entry = connected.get(name);
      // #1521 — an in-flight reconnect attempt dies with the disable too.
      if (entry?.reconnectTimer) { clearTimeout(entry.reconnectTimer); entry.reconnectTimer = null; }
      if (entry?.client) { try { entry.client.close(); } catch { /* best effort */ } }
      connected.delete(name);
      ctx.ui?.notify?.(`'${name}' disabled — connection closed, ${w.path} updated; /mcp-enable ${name} restores it`, 'info');
    },
  });

  pi.registerCommand('mcp-enable', {
    description: 'Enable an MCP server — persists enabled:true and connects it now',
    handler: async (arg, ctx) => {
      const name = String(arg ?? '').trim();
      if (!name) { ctx.ui?.notify?.('usage: /mcp-enable <server>', 'error'); return; }
      if (!(name in allServers)) { ctx.ui?.notify?.(`unknown server '${name}'`, 'error'); return; }
      const w = persistEnabled(name, true);
      if (w.error) { ctx.ui?.notify?.(w.error, 'error'); return; }
      disabled.delete(name);
      // re-read fresh: the operator may have edited the spec while it sat disabled
      const fresh = loadConfig().servers[name] ?? allServers[name];
      if (!fresh || typeof fresh !== 'object' || (!fresh.command && !fresh.url)) {
        ctx.ui?.notify?.(`'${name}' enabled in config but has no command/url — nothing to connect`, 'error');
        return;
      }
      servers[name] = fresh;
      const entry = await connectOne(name, fresh);
      if (entry?.contextScoped) {
        delete servers[name];
        ctx.ui?.notify?.(`'${name}' enabled in config but scoped to agent context ${JSON.stringify(contextList(fresh))} — not connected under agent '${AGENT_ID}'`, 'error');
        return;
      }
      if (entry?.failed || !entry?.client) {
        ctx.ui?.notify?.(`'${name}' enabled — connect FAILED; /mcp shows the error`, 'error');
        return;
      }
      ctx.ui?.notify?.(`'${name}' enabled — connected: ${entry.tools.length} tools, ${(entry.prompts ?? []).length} prompts`, 'info');
    },
  });
}
