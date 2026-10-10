/**
 * hookbridge managed extension — bridges SDK extension events that can only
 * be answered from inside the session runner to the governed HookRunner gate.
 *
 * dedup-h #4059 — before_provider_request (check/replace provider payloads):
 * the SDK's emitBeforeProviderRequest passes the assembled request payload
 * through extension handlers and uses the returned value as the request. The
 * bootstrap injects the gate via setProviderGate(); without injection the
 * handler is a pass-through (undefined = keep original payload).
 *
 * Fail-open at this seam: a handler error inside the SDK runner keeps the
 * ORIGINAL payload (runner catches and keeps currentPayload). The gate-side
 * deny therefore means "keep original + audit" — this seam can reshape a
 * request, never veto one.
 */

let providerGate = null;

/**
 * Injected once by the composition root. fn(payload) must resolve to one of:
 *   {args: <object>} → the object replaces the request payload
 *   {deny: <string>} → original kept, reason audited by the caller
 *   null/undefined   → keep original
 */
export function setProviderGate(fn) {
  providerGate = typeof fn === 'function' ? fn : null;
}

export default function hookBridge(pi) {
  pi.on('before_provider_request', async (event) => {
    if (!providerGate) return undefined;
    let ans = null;
    try {
      ans = await providerGate(event?.payload ?? null);
    } catch {
      return undefined; // gate blew up — original payload proceeds
    }
    if (ans && typeof ans === 'object' && ans.args && typeof ans.args === 'object' && !Array.isArray(ans.args)) {
      return ans.args;
    }
    return undefined;
  });
}
