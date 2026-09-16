/**
 * Pi adapter — composite guard installation.
 *
 * Verified against @earendil-works/* 0.85.1:
 *  - AgentSession._installAgentToolHooks() assigns agent.beforeToolCall as the
 *    extension `tool_call` bridge (agent-session.js:224). Assigning our own
 *    function directly would OVERWRITE that bridge, not run after it.
 *  - Execution order: prepareArguments → validateToolArguments →
 *    beforeToolCall → execute (agent-loop.js:410-449). Extensions mutate the
 *    already-validated args in place via the shared event.input reference —
 *    no re-validation afterwards. So the composite must revalidate.
 *  - beforeToolCall can only veto ({block, reason, terminate}), never mutate.
 *
 * Install order: call AFTER createAgentSession() so the bridge exists.
 * Re-seal on every new AgentSession / runtime replacement.
 */

/**
 * @param {object} agent          session.agent (has mutable beforeToolCall)
 * @param {object} hooks
 * @param {(toolCall, args) => {ok: boolean, reason?: string, normalizedArgs?: object}} hooks.revalidate
 *        post-mutation schema validation. Pi's validateToolArguments returns a
 *        NEW normalized object instead of mutating event.input — when
 *        normalizedArgs is returned the composite writes it back onto the
 *        SAME args reference the loop will execute (agent-loop.js:441).
 * @param {(ctx, signal) => Promise<object|undefined>} hooks.decide
 *        PAI authoritative final guard (GovernanceKernel.decideToolCall).
 *        Throws = fail-closed block; the kernel must not crash-open the guard.
 */
export function installCompositeGuard(agent, { revalidate, decide }) {
  const piBridge = agent.beforeToolCall;
  if (typeof piBridge !== 'function') {
    throw new Error('expected Pi extension bridge at agent.beforeToolCall');
  }

  const composite = async (ctx, signal) => {
    // 1. Pi extension bridge — managed extensions may mutate ctx.args in place
    const bridgeResult = await piBridge(ctx, signal);
    if (bridgeResult?.block) return bridgeResult;
    if (signal?.aborted) return { block: true, reason: 'aborted' };

    // 2. post-mutation revalidation — extension edits are NOT schema-checked by Pi
    const check = revalidate(ctx.toolCall, ctx.args);
    if (!check.ok) {
      return {
        block: true,
        reason: `post-mutation schema violation: ${check.reason ?? 'invalid args'}`,
      };
    }
    if (check.normalizedArgs && check.normalizedArgs !== ctx.args) {
      // write normalized args back onto the executed object (remove dropped keys)
      for (const k of Object.keys(ctx.args)) {
        if (!(k in check.normalizedArgs)) delete ctx.args[k];
      }
      Object.assign(ctx.args, check.normalizedArgs);
    }

    // 3. PAI authoritative final guard — fail closed on kernel error
    try {
      return await decide(ctx, signal);
    } catch (err) {
      return {
        block: true,
        reason: `final guard error (fail-closed): ${err?.message ?? String(err)}`,
      };
    }
  };

  agent.beforeToolCall = composite;

  return {
    /** Assert the composite is still installed (call after reload/replacement). */
    sealed: () => agent.beforeToolCall === composite,
    /** Restore Pi's original bridge (tests, teardown). */
    restore: () => {
      agent.beforeToolCall = piBridge;
    },
  };
}
