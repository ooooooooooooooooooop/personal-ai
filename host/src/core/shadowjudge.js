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
 *   PAI_SHADOW_JUDGE_MODE   'shadow' (default, telemetry only) | 'guard'
 *
 * Guard mode (user-directed upgrade): the judge runs BEFORE the admitted
 * call executes. One-way ratchet — a judge verdict may only ESCALATE an
 * admit to ask/deny; a deterministic deny is returned unchanged and is
 * structurally incapable of being downgraded. Unreachable judge → admit
 * stands (deterministic chain already gated the call) + GUARDIAN_BYPASS
 * audit on state transitions only.
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
  #guardDown = false; // transition-flag for GUARDIAN_BYPASS/RECOVERED audits

  constructor(cfg, { audit = null, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
    this.url = cfg?.url ?? null;
    this.model = cfg?.model ?? null;
    this.apiKey = cfg?.apiKey ?? null;
    this.mode = cfg?.mode === 'guard' ? 'guard' : 'shadow';
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

  /**
   * Guard mode — runs while a call is still admitted-but-not-executed.
   * Returns a block object to refuse, or null to let the admit stand.
   * One-way ratchet: 'deny'/'ask' escalate; 'allow' admits; unreachable
   * judge admits (deterministic chain already gated) with transition audits.
   * NEVER called for already-denied outcomes — the caller returns those
   * unchanged, so a deny cannot be downgraded by this path.
   */
  async guard(toolName, args, { asks = null, signal = null, toolCallId = null } = {}) {
    if (!this.enabled) return null;
    let j = null;
    try { j = await this.#judge(toolName, args); } catch { j = null; }
    if (!j) {
      if (!this.#guardDown) {
        this.#guardDown = true;
        this.audit?.write({ kind: 'GUARDIAN_BYPASS', toolName, data: { reason: 'judge unreachable — deterministic admit stands' } });
      }
      return null;
    }
    if (this.#guardDown) {
      this.#guardDown = false;
      this.audit?.write({ kind: 'GUARDIAN_RECOVERED', toolName, data: {} });
    }
    this.stats.judged++;
    if (j.verdict === 'deny') {
      this.audit?.write({ kind: 'GUARDIAN_DENY', toolName, data: { reason: j.reason, latencyMs: j.latencyMs } });
      return { block: true, rule: 'guardian', reason: `guardian review refused: ${j.reason}` };
    }
    if (j.verdict === 'ask') {
      if (!asks) {
        this.audit?.write({ kind: 'GUARDIAN_ASK_CLOSED', toolName, data: { reason: j.reason } });
        return { block: true, rule: 'guardian', reason: `guardian requires review but no operator channel (fail-closed): ${j.reason}` };
      }
      const answer = await asks.ask({
        toolName, toolCallId, rule: 'guardian',
        summary: `guardian flags this call for review: ${j.reason}`,
        detail: `second-opinion classifier returned 'ask'`,
        args, argsTruncated: false, argsTotalChars: null,
      }, signal);
      this.audit?.write({ kind: 'GUARDIAN_ASK_ANSWERED', toolName, data: { reason: j.reason, answer } });
      if (answer === 'allow' || answer === 'allow_session' || answer === 'always') return null;
      return { block: true, rule: 'guardian', reason: `guardian review denied by operator (${answer})` };
    }
    return null; // 'allow' — admit stands
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
    { url, model, apiKey: env.PAI_SHADOW_JUDGE_KEY ?? null, mode: env.PAI_SHADOW_JUDGE_MODE },
    { audit, fetchImpl, timeoutMs: Number(env.PAI_SHADOW_JUDGE_TIMEOUT_MS) || 8000 },
  );
}
