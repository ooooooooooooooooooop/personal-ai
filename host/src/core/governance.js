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
   */
  constructor({ audit, policy, predictions = null, commandClassifier = null, protectedRoots = [], commandArgs = {} }) {
    if (!audit) throw new Error('GovernanceKernel requires an AuditWriter');
    if (!policy) throw new Error('GovernanceKernel requires an AttestedPolicy');
    this.audit = audit;
    this.policy = policy;
    this.predictions = predictions;
    this.commandClassifier = commandClassifier;
    this.protectedRoots = protectedRoots.map((r) => r.replace(/\\/g, '/'));
    this.commandArgs = commandArgs;
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
      const action = actions.includes('terminate') ? 'terminate'
        : actions.includes('deny') ? 'deny' : 'allow';
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

    // 5. prediction binding
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
