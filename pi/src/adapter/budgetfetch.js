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
 * Denial shape: a synthetic `402` JSON response. A 4xx client error is
 * non-retryable for provider adapters (unlike a thrown network error or 429,
 * which trigger retry policies), so an over-budget request fails once with a
 * readable reason instead of burning N denied retries.
 */
export function installBudgetFetch({ budget, getScope, getProviderHosts, audit, onGateEvent = null }) {
  const base = globalThis.fetch;
  if (typeof base !== 'function') return () => {};

  const gated = async (input, init) => {
    if (!budget?.configured) return base(input, init);
    let host = null;
    try {
      const url = typeof input === 'string' ? input : input?.url;
      host = url ? new URL(url).host : null;
    } catch { /* unparseable url → not a provider call we gate */ }
    if (!host || !getProviderHosts().has(host)) return base(input, init);

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
