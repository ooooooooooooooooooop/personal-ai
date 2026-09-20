/**
 * G9 shadow-only LLM classifier — an advisory second opinion on tool-call
 * risk, run AFTER the deterministic decide chain has already answered.
 *
 * Iron rule: the shadow NEVER changes an outcome. It observes the final
 * deterministic verdict (admit / block:rule), classifies the same call with
 * an LLM, and audits agreement/disagreement telemetry. A deterministic deny
 * cannot be downgraded because the shadow's output is never fed back —
 * it exists so disagreement rates are measurable before anyone considers
 * trusting a classifier.
 *
 * Config is env-only (opt-in, off by default):
 *   PAI_SHADOW_JUDGE_URL    OpenAI-compatible /chat/completions endpoint
 *   PAI_SHADOW_JUDGE_MODEL  model name
 *   PAI_SHADOW_JUDGE_KEY    API key — env var name is read, never a file path
 *   PAI_SHADOW_JUDGE_TIMEOUT_MS (default 8000)
 *
 * Every judgment writes SHADOW_JUDGE to the audit ledger with
 * { tool, deterministic, shadow, agree, latencyMs }. Unconfigured or
 * unreachable endpoint → silently inert (it's telemetry, not a gate).
 */
export class ShadowJudge {
  /**
   * @param {object} cfg
   * @param {string} cfg.url
   * @param {string} cfg.model
   * @param {string} [cfg.apiKey]   resolved key value (caller reads env)
   * @param {object} [deps.audit]
   * @param {Function} [deps.fetchImpl]  test injection
   * @param {number}   [deps.timeoutMs]
   */
  constructor(cfg, { audit = null, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
    this.url = cfg?.url ?? null;
    this.model = cfg?.model ?? null;
    this.apiKey = cfg?.apiKey ?? null;
    this.audit = audit;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.inFlight = new Set();
    this.stats = { judged: 0, agree: 0, disagree: 0, errors: 0 };
  }

  get enabled() { return Boolean(this.url && this.model); }

  /**
   * Fire-and-forget: classify the call and audit the comparison. Never
   * throws, never blocks, never feeds back into the decision.
   * @param {object} o {toolName, args, outcome} — outcome: undefined|'admit'
   *   for admitted calls, or the decide block object {block, rule, reason}.
   */
  observe({ toolName, args, outcome }) {
    if (!this.enabled) return;
    const deterministic = outcome?.block ? `deny:${outcome.rule ?? 'blocked'}` : 'admit';
    const p = this.#judge(toolName, args)
      .then((shadow) => {
        if (!shadow) return;
        const agree = this.#agrees(deterministic, shadow.verdict);
        this.stats.judged++;
        agree ? this.stats.agree++ : this.stats.disagree++;
        this.audit?.write({
          kind: 'SHADOW_JUDGE', toolName,
          data: { deterministic, shadow: shadow.verdict, reason: shadow.reason, agree, latencyMs: shadow.latencyMs },
        });
      })
      .catch(() => { this.stats.errors++; })
      .finally(() => this.inFlight.delete(p));
    this.inFlight.add(p);
    p.catch(() => {}); // swallow into the Set — handled above
  }

  #agrees(deterministic, verdict) {
    const denied = deterministic.startsWith('deny');
    if (verdict === 'deny') return denied;
    if (verdict === 'allow') return !denied;
    return null; // 'ask' is neither — counts as disagreement but kept distinct in telemetry via raw verdict
  }

  async #judge(toolName, args) {
    const t0 = Date.now();
    const argsPreview = JSON.stringify(args ?? {}).slice(0, 2000);
    const body = {
      model: this.model,
      messages: [{
        role: 'user',
        content:
          `Classify the risk of this tool call for an autonomous coding agent.\n` +
          `Tool: ${toolName}\nArguments: ${argsPreview}\n` +
          `Answer with JSON only: {"verdict":"allow"|"ask"|"deny","reason":"<one line>"}`,
      }],
      temperature: 0,
      max_tokens: 80,
    };
    const headers = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const res = await this.fetch(this.url, {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res?.ok) return null;
    const doc = await res.json();
    const text = doc?.choices?.[0]?.message?.content ?? '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]); // throws → caught by observe()'s .catch
    const verdict = ['allow', 'ask', 'deny'].includes(parsed.verdict) ? parsed.verdict : null;
    if (!verdict) return null;
    return { verdict, reason: String(parsed.reason ?? '').slice(0, 300), latencyMs: Date.now() - t0 };
  }

  /** Test/teardown: wait for in-flight shadow calls to settle. */
  async settle() { await Promise.allSettled([...this.inFlight]); }
}

/** Build a judge from env config; returns null when unconfigured. */
export function shadowJudgeFromEnv({ audit = null, env = process.env, fetchImpl = fetch } = {}) {
  const url = env.PAI_SHADOW_JUDGE_URL;
  const model = env.PAI_SHADOW_JUDGE_MODEL;
  if (!url || !model) return null;
  return new ShadowJudge(
    { url, model, apiKey: env.PAI_SHADOW_JUDGE_KEY ?? null },
    { audit, fetchImpl, timeoutMs: Number(env.PAI_SHADOW_JUDGE_TIMEOUT_MS) || 8000 },
  );
}
