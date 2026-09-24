/**
 * Provider-request budget gate — the authoritative admission layer.
 *
 * Channel-level precheck (prompt/steer) is fast-fail UX only. The real gate
 * must sit beneath EVERY expensive provider call: auto-retry, compaction
 * summarizer, branch summary, provider-internal retries — all of them end in
 * an HTTP request through fetch. pi-ai's provider adapters resolve fetch at
 * request time (e.g. the OpenAI client takes `options.fetch ??
 * Shims.getDefaultFetch()` and a fresh client is built per request), so
 * wrapping `globalThis.fetch` once here covers all fetch-based transports
 * without reaching into pi internals.
 *
 * INVARIANT (reviewer-mandated wording): an admitted provider transport must
 * prove its model requests transit this budget-controlled fetch; a transport
 * that bypasses fetch (e.g. a future WebSocket SDK) is NOT covered by this
 * gate and must not be admitted until it carries its own admission layer.
 *
 * Semantics (documented honestly): this is a HARD ADMISSION THRESHOLD plus
 * at-most-one-request overshoot — a request admitted under the cap can spend
 * past it before usage is billed. Absolute hard caps would require
 * reservation/headroom accounting; not implemented, deliberately.
 *
 * Denial shape: a synthetic `402`/`403` JSON response. A 4xx client error is
 * non-retryable for provider adapters (unlike a thrown network error or 429,
 * which trigger retry policies), so a denied request fails once with a
 * readable reason instead of burning N denied retries.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ReadableStream } from 'node:stream/web';
import { isPrivateResolved } from './web.js';

/**
 * dedup-h #1590 — Host-preserving transport. Provider/model `headers` may
 * declare a custom `host` header for virtual-host-routed OpenAI-compatible
 * gateways, but undici fetch silently strips `host` (Fetch forbidden-header
 * list). When a request declares one, dispatch through node:http/https which
 * sends the declared value verbatim; the CONNECT target still comes from the
 * request URL, so the egress/budget gates above continue to judge the real
 * destination. Redirects are not followed (returned to the caller honestly).
 */
function collectRequestHeaders(input, init) {
  const headers = {};
  const merge = (h) => {
    if (!h) return;
    if (typeof h.forEach === 'function') h.forEach((v, k) => { headers[k] = v; });
    else if (Array.isArray(h)) for (const [k, v] of h) headers[k] = v;
    else for (const [k, v] of Object.entries(h)) headers[k] = v;
  };
  if (input && typeof input === 'object') merge(input.headers);
  merge(init?.headers);
  return headers;
}

function declaredHostHeader(input, init) {
  const headers = collectRequestHeaders(input, init);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'host');
  return key ? headers[key] : null;
}

async function hostPreservingFetch(input, init) {
  const url = new URL(typeof input === 'string' ? input : input?.url);
  const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const headers = collectRequestHeaders(input, init);
  const method = init?.method ?? (input && typeof input === 'object' ? input.method : null) ?? 'GET';
  let body = init?.body;
  if (body === undefined && input && typeof input.arrayBuffer === 'function' && method !== 'GET' && method !== 'HEAD') {
    body = Buffer.from(await input.arrayBuffer());
  }
  const sized = typeof body === 'string' ? Buffer.byteLength(body)
    : Buffer.isBuffer(body) ? body.length
    : body instanceof ArrayBuffer ? body.byteLength
    : ArrayBuffer.isView(body) ? body.byteLength : null;
  if (sized != null && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) {
    headers['content-length'] = String(sized);
  }
  return await new Promise((resolve, reject) => {
    const req = doRequest({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method,
      headers,
    }, (res) => {
      const h = new Headers();
      const raw = res.rawHeaders ?? [];
      for (let i = 0; i + 1 < raw.length; i += 2) h.append(raw[i], raw[i + 1]);
      resolve(new Response(Readable.toWeb(res), {
        status: res.statusCode,
        statusText: res.statusMessage ?? '',
        headers: h,
      }));
    });
    const signal = init?.signal ?? (input && typeof input === 'object' ? input.signal : null);
    const onAbort = () => req.destroy(signal?.reason instanceof Error
      ? signal.reason
      : new DOMException('This operation was aborted', 'AbortError'));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    req.on('error', (err) => { signal?.removeEventListener?.('abort', onAbort); reject(err); });
    if (body == null) req.end();
    else if (typeof body === 'string' || Buffer.isBuffer(body)) req.end(body);
    else if (body instanceof ArrayBuffer) req.end(Buffer.from(body));
    else if (ArrayBuffer.isView(body)) req.end(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
    else if (body instanceof ReadableStream) Readable.fromWeb(body).pipe(req);
    else req.end(String(body));
  });
}

/**
 * dedup-h #1636 — same-provider API-key pool with automatic rotation.
 * <agentDir>/key-pool.json declares `providers.<id>: [keys]`; a declared pool
 * is authoritative for that provider's bearer (primary key goes at index 0).
 * On an auth/quota-class response (401/403/429 — after the SDK's own same-key
 * retries have already run) the request is replayed with the next key; the
 * cursor is process-sticky so a dead key is not retried on every call. The
 * bound is the pool length; an unreplayable body (stream) gets one attempt.
 * Non-bearer Authorization values and requests without any Authorization are
 * handled honestly: the former is never rewritten, the latter gets the pool
 * key injected. Key bytes are never logged.
 */
function withBearerAuthorization(input, init, key) {
  const headers = collectRequestHeaders(input, init);
  const authKey = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization');
  if (authKey && !String(headers[authKey]).toLowerCase().startsWith('bearer ')) return null;
  headers[authKey ?? 'authorization'] = `Bearer ${key}`;
  return { ...(init ?? {}), headers };
}

export function installBudgetFetch({ budget, getScope, getProviderHosts, getPrivateAllowedHosts = null, getKeyPool = null, audit, onGateEvent = null }) {
  const base = globalThis.fetch;
  if (typeof base !== 'function') return () => {};
  const send = (input, init) => (declaredHostHeader(input, init) ? hostPreservingFetch(input, init) : base(input, init));
  const keyCursor = new Map(); // host -> active pool index (process-sticky)
  const replayableBody = (b) => b == null || typeof b === 'string' || Buffer.isBuffer(b)
    || b instanceof ArrayBuffer || ArrayBuffer.isView(b) || b instanceof URLSearchParams;
  const sendWithRotation = async (input, init, host) => {
    const pool = getKeyPool?.().get(host) ?? null;
    if (!pool) return send(input, init);
    // normalize a replayable body once (Request inputs get buffered — their
    // stream can only be consumed once); streams stay single-attempt
    const method = init?.method ?? (input && typeof input === 'object' ? input.method : null) ?? 'GET';
    let body = init?.body;
    let replayable = replayableBody(body);
    if (body === undefined && input && typeof input === 'object' && method !== 'GET' && method !== 'HEAD') {
      try { body = Buffer.from(await input.arrayBuffer()); }
      catch { replayable = false; }
    }
    for (;;) {
      const cursor = keyCursor.get(host) ?? 0;
      const rotated = withBearerAuthorization(input, init, pool[cursor]);
      if (!rotated) return send(input, init); // non-bearer auth — rotation cannot apply
      const res = await send(input, { ...rotated, body });
      if (!res || res.status < 400 || ![401, 403, 429].includes(res.status)
          || !replayable || cursor >= pool.length - 1) return res;
      res.body?.cancel().catch(() => {});
      keyCursor.set(host, cursor + 1);
      audit?.write({ kind: 'PROVIDER_KEY_ROTATED', data: { host, keyIndex: cursor + 1, status: res.status } });
      if (cursor + 1 >= pool.length - 1) {
        audit?.write({ kind: 'PROVIDER_KEY_POOL_NEAR_EXHAUSTION', data: { host, remaining: 1 } });
      }
    }
  };

  const gated = async (input, init) => {
    let host = null;
    let hostname = null;
    try {
      const url = typeof input === 'string' ? input : input?.url;
      if (url) { const u = new URL(url); host = u.host; hostname = u.hostname; }
    } catch { /* unparseable url → not a provider call we gate */ }
    if (!host || !getProviderHosts().has(host)) return send(input, init);

    // dedup-h #1402 egress policy — allowPrivateNetwork per-provider: provider
    // traffic may never silently target loopback/RFC1918/link-local/metadata
    // space. A self-hosted endpoint is an explicit opt-in declared on the
    // provider entry; enforcement lives HERE at egress time (a registration-
    // time hint is UX — hand-edited models.json and DNS-rebinding still hit
    // this gate). Runs before the budget short-circuit: the egress rule is
    // not a spend rule.
    if (!getPrivateAllowedHosts?.().has(host)) {
      let addrs = [];
      if (isIP(hostname)) addrs = [hostname];
      else {
        try { addrs = (await dnsLookup(hostname, { all: true })).map((a) => a.address); }
        catch { /* unresolvable — the real fetch will fail honestly downstream */ }
      }
      const hit = addrs.find((a) => isPrivateResolved(a));
      if (hit) {
        audit?.write({ kind: 'PROVIDER_PRIVATE_EGRESS_REFUSED', data: { host, resolved: hit } });
        return new Response(
          JSON.stringify({
            error: {
              type: 'private_egress_refused',
              message: `provider host '${host}' resolves to private/loopback address ${hit} — declare allowPrivateNetwork on the provider to use a self-hosted endpoint`,
            },
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        );
      }
    }

    if (!budget?.configured) return sendWithRotation(input, init, host);
    const scope = getScope();
    const gate = budget.admit(scope);
    onGateEvent?.({ host, scope, admitted: gate.ok, rule: gate.rule ?? null });
    if (gate.ok) {
      // count the request itself: retries/compaction/internal calls each
      // consume call budget — token/cost usage is billed later by the
      // channel's usage events (countCall:false there avoids double-count)
      try { budget.record({ scope, source: 'turn', usage: {}, countCall: true }); }
      catch { /* ledger went unwritable mid-run — next admit() fails closed */ }
      return sendWithRotation(input, init, host);
    }

    audit?.write({
      kind: 'BUDGET_PROVIDER_DENY',
      data: { scope, rule: gate.rule, reason: gate.reason, host },
    });
    return new Response(
      JSON.stringify({
        error: {
          type: 'budget_exceeded',
          message: `budget gate: ${gate.reason} — provider request denied before spend`,
        },
      }),
      { status: 402, headers: { 'content-type': 'application/json' } },
    );
  };

  globalThis.fetch = gated;
  return () => { globalThis.fetch = base; };
}

/**
 * Collect the set of hosts that count as provider calls: every configured
 * provider's baseUrl host, plus the built-in endpoint hosts pi-ai adapters
 * default to when a provider entry has no explicit baseUrl.
 */
export function collectProviderHosts(modelRuntime) {
  const hosts = new Set([
    'api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com',
    'openrouter.ai', 'api.mistral.ai', 'api.groq.com', 'api.deepseek.com',
    'api.moonshot.cn', 'api.cerebras.ai', 'api.x.ai', 'aiplatform.googleapis.com',
  ]);
  try {
    for (const p of modelRuntime?.getProviders?.() ?? []) {
      if (p?.baseUrl) {
        try { hosts.add(new URL(p.baseUrl).host); } catch { /* malformed baseUrl — ignore */ }
      }
    }
  } catch { /* runtime not ready — built-in hosts still apply */ }
  return hosts;
}

/**
 * dedup-h #1402: URL-hosts whose provider declared `allowPrivateNetwork` —
 * the self-hosted opt-in set consulted by the egress gate above. Reads
 * <agentDir>/models.json provider entries plus auth.json baseUrl overrides
 * (an auth-level endpoint override inherits the provider's flag — same trust
 * domain). Both files are operator-private. An env-ref baseUrl ($NAME) is
 * resolved through process.env; an unresolvable ref contributes no host —
 * fail-closed, the provider's traffic stays refused until the operator
 * declares a concrete endpoint.
 */
export function collectPrivateAllowedHosts(agentDir) {
  const allowed = new Set();
  const hostOf = (base) => {
    const b = typeof base === 'string' && base.startsWith('$') ? process.env[base.slice(1)] : base;
    try { return new URL(String(b ?? '')).host || null; } catch { return null; }
  };
  let cfg = null;
  try { cfg = JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf-8')); } catch { /* absent */ }
  const flagged = new Set();
  for (const [pid, spec] of Object.entries(cfg?.providers ?? {})) {
    if (spec?.allowPrivateNetwork !== true) continue;
    flagged.add(pid);
    const h = hostOf(spec?.baseUrl);
    if (h) allowed.add(h);
  }
  try {
    const auth = JSON.parse(readFileSync(join(agentDir, 'auth.json'), 'utf-8'));
    for (const [pid, cred] of Object.entries(auth ?? {})) {
      if (!flagged.has(pid)) continue;
      const h = hostOf(cred?.baseUrl ?? cred?.auth?.baseUrl);
      if (h) allowed.add(h);
    }
  } catch { /* absent */ }
  return allowed;
}

/**
 * dedup-h #1636: provider key pools from <agentDir>/key-pool.json —
 * `{ "providers": { "<id>": ["k1", "k2", ...] } }`. Returns Map<host, keys[]>.
 * A pool needs at least two resolvable keys to rotate; entries support $ENV
 * refs resolved per call (an unresolvable ref is dropped — if that leaves
 * fewer than two keys the provider simply has no pool). Host mapping follows
 * the same trust domain as collectPrivateAllowedHosts: the provider's
 * models.json baseUrl plus the auth.json baseUrl override. Operator-private
 * file; never logged.
 */
export function collectKeyPool(agentDir) {
  const pool = new Map();
  let cfg = null;
  try { cfg = JSON.parse(readFileSync(join(agentDir, 'key-pool.json'), 'utf-8')); } catch { return pool; }
  if (!cfg?.providers || typeof cfg.providers !== 'object') return pool;
  let models = null;
  let auth = null;
  try { models = JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf-8')); } catch { /* absent */ }
  try { auth = JSON.parse(readFileSync(join(agentDir, 'auth.json'), 'utf-8')); } catch { /* absent */ }
  const resolve = (v) => {
    if (typeof v !== 'string' || !v) return null;
    if (v.startsWith('$')) {
      const val = process.env[v.slice(1)];
      return typeof val === 'string' && val ? val : null;
    }
    return v;
  };
  const hostOf = (base) => {
    const b = typeof base === 'string' && base.startsWith('$') ? process.env[base.slice(1)] : base;
    try { return new URL(String(b ?? '')).host || null; } catch { return null; }
  };
  for (const [pid, keys] of Object.entries(cfg.providers)) {
    if (!Array.isArray(keys)) continue;
    const resolved = keys.map(resolve).filter(Boolean);
    if (resolved.length < 2) continue;
    const hosts = new Set();
    const h1 = hostOf(models?.providers?.[pid]?.baseUrl);
    if (h1) hosts.add(h1);
    const h2 = hostOf(auth?.[pid]?.baseUrl ?? auth?.[pid]?.auth?.baseUrl);
    if (h2) hosts.add(h2);
    for (const h of hosts) pool.set(h, resolved);
  }
  return pool;
}
