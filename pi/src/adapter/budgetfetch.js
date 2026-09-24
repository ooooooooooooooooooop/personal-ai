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
import { isIP } from 'node:net';
import { join } from 'node:path';
import { isPrivateResolved } from './web.js';

export function installBudgetFetch({ budget, getScope, getProviderHosts, getPrivateAllowedHosts = null, audit, onGateEvent = null }) {
  const base = globalThis.fetch;
  if (typeof base !== 'function') return () => {};

  const gated = async (input, init) => {
    let host = null;
    let hostname = null;
    try {
      const url = typeof input === 'string' ? input : input?.url;
      if (url) { const u = new URL(url); host = u.host; hostname = u.hostname; }
    } catch { /* unparseable url → not a provider call we gate */ }
    if (!host || !getProviderHosts().has(host)) return base(input, init);

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

    if (!budget?.configured) return base(input, init);
    const scope = getScope();
    const gate = budget.admit(scope);
    onGateEvent?.({ host, scope, admitted: gate.ok, rule: gate.rule ?? null });
    if (gate.ok) {
      // count the request itself: retries/compaction/internal calls each
      // consume call budget — token/cost usage is billed later by the
      // channel's usage events (countCall:false there avoids double-count)
      try { budget.record({ scope, source: 'turn', usage: {}, countCall: true }); }
      catch { /* ledger went unwritable mid-run — next admit() fails closed */ }
      return base(input, init);
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
