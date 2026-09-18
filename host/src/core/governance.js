/**
 * Governance kernel — the harness-neutral authority surface.
 *
 * M2 semantics (all fail-closed):
 *  1. policy attestation: every decision re-proves the canonical policy block
 *     hasn't drifted (invariant #4). Drift = block + terminate the batch.
 *  2. policy tool rules: per-tool allow/deny/constraint from the attested doc.
 *  3. negative capabilities: a hardcoded floor the config layer cannot weaken —
 *     writes aimed at audit/lease/instance internals are denied regardless of
 *     what policy.json says.
 *  4. command classification: shell-ish args are parsed into executable units
 *     by an injected classifier; risk classes map onto policy riskActions.
 *  5. prediction binding: tools flagged requiresPrediction (or calls carrying
 *     predictionId) must bind to an OPEN prediction — closed/missing = block.
 *
 * Denials are structured: {rule, expected, actual, repair} — adapters render
 * them into repair-oriented reason text (Kimi-style guidance).
 */
export class GovernanceKernel {
  /**
   * @param {object} deps
   * @param {import('./audit.js').AuditWriter} deps.audit
   * @param {import('./policy.js').AttestedPolicy} deps.policy
   * @param {import('./prediction.js').PredictionStore} [deps.predictions]
   * @param {(source:string)=>Promise<{units:Array,parseError:string|null,risk:string}>} [deps.commandClassifier]
   * @param {string[]} [deps.protectedRoots]   negative-capability path roots
   * @param {Record<string,string>} [deps.commandArgs]  toolName -> arg holding a shell command
   * @param {(pending:object, signal?:AbortSignal) => Promise<string>} [deps.ask]
   *        operator-in-the-loop surface for the 'ask' policy action; absent =
   *        ask rules fail closed (unanswerable questions are denials)
   * @param {() => string} [deps.modeProvider]  session risk-mode ('normal'|'plan').
   *        'plan' escalates mutating-capable calls to 'ask'; it can only
   *        tighten, never loosen — deny/negative-capability rules return first.
   * @param {string[]} [deps.mutatingTools]  tool names that mutate without a
   *        shell command (write/edit/delete) — plan mode asks these too.
   */
  constructor({ audit, policy, predictions = null, commandClassifier = null, protectedRoots = [], commandArgs = {}, ask = null, modeProvider = null, mutatingTools = [] }) {
    if (!audit) throw new Error('GovernanceKernel requires an AuditWriter');
    if (!policy) throw new Error('GovernanceKernel requires an AttestedPolicy');
    this.audit = audit;
    this.policy = policy;
    this.predictions = predictions;
    this.commandClassifier = commandClassifier;
    this.protectedRoots = protectedRoots.map((r) => r.replace(/\\/g, '/'));
    this.commandArgs = commandArgs;
    this.ask = ask;
    this.modeProvider = modeProvider;
    this.mutatingTools = new Set(mutatingTools);
  }

  #deny(ctx, rule, detail) {
    const decision = {
      block: true,
      terminate: detail.terminate === true,
      reason: detail.reason,
      rule,
      expected: detail.expected ?? null,
      actual: detail.actual ?? null,
      repair: detail.repair ?? null,
    };
    this.audit.write({
      kind: 'TOOL_CALL_DENIED',
      toolName: ctx.toolName,
      data: { toolCallId: ctx.toolCallId, rule, ...detail, reason: detail.reason },
    });
    return decision;
  }

  #allow(ctx, via) {
    this.audit.write({
      kind: 'TOOL_CALL_ADMITTED',
      toolName: ctx.toolName,
      data: { toolCallId: ctx.toolCallId, via },
    });
    return undefined;
  }

  /**
   * Suspend the call and put the question to the operator. The answer maps
   * back onto ordinary decisions — deny/timeout/abort all refuse, so a UI
   * that never answers can only ever produce denials.
   */
  async #ask(ctx, rule, detail) {
    const summary = summarizeArgs(ctx.args);
    if (!this.ask) {
      return this.#deny(ctx, 'ask_unavailable', {
        reason: `policy requires operator approval for '${ctx.toolName}' but no ask channel is configured (fail-closed)`,
        actual: summary,
        repair: 'connect a UI that answers asks, or change the policy action to allow/deny',
      });
    }
    this.audit.write({
      kind: 'GOVERNANCE_ASK', toolName: ctx.toolName,
      data: { toolCallId: ctx.toolCallId, rule, summary },
    });
    const answer = await this.ask(
      { toolName: ctx.toolName, toolCallId: ctx.toolCallId, rule, summary, detail: detail.reason ?? null, args: sanitizeAskArgs(ctx.args) },
      ctx.signal,
    );
    this.audit.write({
      kind: 'GOVERNANCE_ASK_RESOLVED', toolName: ctx.toolName,
      data: { toolCallId: ctx.toolCallId, rule, answer },
    });
    if (answer === 'allow' || answer === 'allow_session') {
      return this.#allow(ctx, `operator:${answer}`);
    }
    const reasons = {
      deny: 'operator denied the call',
      timeout: 'operator did not answer before the ask expired',
      aborted: 'session aborted while awaiting operator',
    };
    return this.#deny(ctx, `ask_${answer}`, {
      reason: `${reasons[answer] ?? `ask unresolved (${answer})`} — ${detail.reason}`,
      actual: summary,
      repair: 're-issue after operator approval, or choose a permitted action',
    });
  }

  /**
   * Authoritative final decision for a tool call.
   * @param {import('./contracts.js').ToolCallContext} ctx
   * @returns {Promise<import('./contracts.js').ToolCallDecision|undefined>}
   */
  async decideToolCall(ctx) {
    // 1. policy attestation — drift is a governance-level emergency
    try {
      this.policy.assertFresh();
    } catch (err) {
      return this.#deny(ctx, 'policy_drift', {
        terminate: true,
        reason: `policy drift (fail-closed): ${err.message}`,
        repair: 're-attest canonical policy and restart the session',
      });
    }

    const args = ctx.args ?? {};
    const rules = this.policy.toolPolicy?.[ctx.toolName] ?? {};

    // 2. explicit tool rule
    if (rules.action === 'deny') {
      return this.#deny(ctx, 'tool_denied', {
        reason: `tool '${ctx.toolName}' denied by policy`,
        repair: rules.repair ?? 'choose an allowed tool',
      });
    }

    // 3. negative capabilities — config cannot soften these
    const badPath = this.#scanProtectedRoots(args);
    if (badPath) {
      return this.#deny(ctx, 'negative_capability', {
        reason: `argument targets protected runtime path: ${badPath}`,
        actual: badPath,
        repair: 'write inside the task worktree, never into instance internals',
      });
    }

    // 4. command classification
    let cmdMutatingCapable = false;
    const cmdArg = this.commandArgs[ctx.toolName];
    if (cmdArg && typeof args[cmdArg] === 'string' && this.commandClassifier) {
      const parsed = await this.commandClassifier(args[cmdArg]);
      if (parsed.parseError) {
        return this.#deny(ctx, 'command_unparseable', {
          reason: `command could not be parsed (${parsed.parseError}); unparseable commands are unverifiable`,
          repair: 'split the command into simpler units',
        });
      }
      const riskActions = this.policy.doc?.riskActions ?? {};
      // strictest applicable action: known worst risk AND unknown-unit policy
      const actions = [parsed.risk, ...(parsed.hasUnknown ? ['unknown'] : [])]
        .map((cls) => riskActions[cls] ?? 'allow');
      // anything above benign reads can mutate state — plan mode escalates it
      cmdMutatingCapable = parsed.risk !== 'benign' || parsed.hasUnknown === true;
      const action = actions.includes('terminate') ? 'terminate'
        : actions.includes('deny') ? 'deny'
        : actions.includes('ask') ? 'ask' : 'allow';
      if (action === 'ask') {
        return this.#ask(ctx, `risk_${parsed.risk}`, {
          reason: `command risk class '${parsed.risk}' requires operator approval by policy`,
        });
      }
      if (action === 'deny') {
        return this.#deny(ctx, `risk_${parsed.risk}`, {
          reason: `command risk class '${parsed.risk}' denied by policy`,
          actual: parsed.units.map((u) => u.raw).join(' | '),
          repair: 'remove the denied unit or request elevation through the operator',
        });
      }
      if (action === 'terminate') {
        return this.#deny(ctx, `risk_${parsed.risk}`, {
          terminate: true,
          reason: `command risk class '${parsed.risk}' halts the batch by policy`,
        });
      }
    }

    // 5. per-tool ask — placed after deny/negative-capability/command checks:
    // an operator can approve what policy made optional, never what it forbade
    if (rules.action === 'ask') {
      return this.#ask(ctx, 'tool_ask', {
        reason: `tool '${ctx.toolName}' requires operator approval by policy`,
      });
    }

    // 6. prediction binding
    const needsPrediction = rules.requiresPrediction === true || args.predictionId != null;
    if (needsPrediction) {
      const predId = args.predictionId;
      if (!predId) {
        return this.#deny(ctx, 'prediction_required', {
          reason: `tool '${ctx.toolName}' requires a bound prediction (policy requiresPrediction)`,
          repair: 'open a prediction via the world-model surface and pass predictionId',
        });
      }
      if (!this.predictions) {
        return this.#deny(ctx, 'prediction_store_unavailable', {
          reason: 'prediction binding required but no PredictionStore is configured (fail-closed)',
        });
      }
      try {
        this.predictions.bindMutation(predId, { toolName: ctx.toolName, toolCallId: ctx.toolCallId, args });
        this.audit.write({
          kind: 'PREDICTION_BOUND', toolName: ctx.toolName, predictionId: predId,
          data: { toolCallId: ctx.toolCallId },
        });
      } catch (err) {
        return this.#deny(ctx, 'prediction_binding_failed', {
          reason: `prediction binding failed: ${err.message}`,
          actual: predId,
          repair: 'bind to an OPEN prediction',
        });
      }
    }

    // 7. session risk mode — 'plan' turns the session read-only by escalating
    // every mutating-capable call to an operator ask. It can only tighten:
    // deny/negative-capability/unparseable paths already returned above, and
    // the mode never softens an explicit policy rule.
    const mode = this.modeProvider?.() ?? 'normal';
    if (mode === 'plan' && (this.mutatingTools.has(ctx.toolName) || cmdMutatingCapable)) {
      return this.#ask(ctx, 'plan_mode', {
        reason: `session is in plan mode — '${ctx.toolName}' can mutate state; approve once, for the session, or switch back to act mode`,
      });
    }

    return this.#allow(ctx, 'kernel');
  }

  #scanProtectedRoots(value, depth = 0) {
    if (depth > 6 || value == null) return null;
    if (typeof value === 'string') {
      const v = value.replace(/\\/g, '/');
      return this.protectedRoots.find((root) => v.startsWith(root) || v.includes(`${root}/`)) ?? null;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = this.#scanProtectedRoots(item, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    if (typeof value === 'object') {
      for (const item of Object.values(value)) {
        const hit = this.#scanProtectedRoots(item, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }
}

/**
 * One-line operator-facing digest of tool args: prefer the fields a human
 * actually adjudicates (the command, the path, the query), else truncated
 * JSON. The summary is what the approver sees — it is not a decision input.
 */
function summarizeArgs(args) {
  if (args == null || typeof args !== 'object') return String(args ?? '');
  for (const key of ['command', 'path', 'file', 'target', 'url', 'query', 'pattern']) {
    if (typeof args[key] === 'string' && args[key]) return `${key}: ${clip(args[key])}`;
  }
  try { return clip(JSON.stringify(args)); } catch { return '[unserializable args]'; }
}

const clip = (s, n = 240) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Args carried onto the operator ask card — the operator approves what they
 * can SEE, so the real payload (command/path/content) must be inspectable.
 * Strings are clipped for transport; nothing is dropped by key.
 */
function sanitizeAskArgs(args, depth = 0) {
  if (args == null || typeof args !== 'object') return typeof args === 'string' ? clip(args, 4000) : args;
  if (Array.isArray(args)) return args.slice(0, 50).map((v) => sanitizeAskArgs(v, depth + 1));
  if (depth > 4) return '[nested]';
  const out = {};
  for (const [k, v] of Object.entries(args)) out[k] = sanitizeAskArgs(v, depth + 1);
  return out;
}
