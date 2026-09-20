/**
 * mode_request — model-side governed mode transition (Claude ExitPlanMode
 * analogue). The model may REQUEST a switch; the operator approves it on an
 * ask card and applyMode performs it through the same audited path as the
 * mode chips. Never self-applies — a model asking to leave plan mode is
 * exactly the escalation the mode exists for.
 *
 * deps:
 *   catalogModes() → string[]  available mode names (builtins + presets)
 *   applyMode(name) → result   the shared governed transition
 *   asks            → PendingAsks (operator channel; absent = tool errors)
 */
export function modeRequestTool({ catalogModes, applyMode, asks }) {
  return {
    name: 'mode_request',
    label: 'Request Mode',
    description:
      'Ask the operator to switch session mode (normal/plan/review or a named preset). ' +
      'Use when the current posture blocks legitimate work — the request is an ' +
      'operator decision, not something you can grant yourself.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'mode name: normal | plan | review | <preset>' },
        reason: { type: 'string', description: 'why the switch is needed (shown to the operator)' },
      },
      required: ['name'],
    },
    async execute(_id, p) {
      const name = String(p?.name ?? '').trim();
      const catalog = catalogModes();
      if (!catalog.includes(name)) {
        return { content: [{ type: 'text', text: `mode_request: unknown mode '${name}' — available: ${catalog.join(', ')}` }], isError: true };
      }
      if (!asks?.ask) {
        return { content: [{ type: 'text', text: 'mode_request unavailable: no operator channel' }], isError: true };
      }
      const answer = await asks.ask({
        toolName: 'mode_request',
        toolCallId: _id,
        rule: 'mode_request',
        summary: `agent 请求切换到 '${name}' 模式`,
        detail: String(p?.reason ?? '').slice(0, 500) || null,
        args: { name },
        argsTruncated: false,
        argsTotalChars: null,
      });
      if (answer !== 'allow' && answer !== 'allow_session' && answer !== 'always') {
        return { content: [{ type: 'text', text: `mode_request '${name}' refused (${answer}) — continue under the current mode` }], isError: true };
      }
      const r = applyMode(name);
      return r
        ? { content: [{ type: 'text', text: `mode switched to '${r.mode}'` }] }
        : { content: [{ type: 'text', text: `mode_request '${name}' failed to apply` }], isError: true };
    },
  };
}
