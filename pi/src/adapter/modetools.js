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

/**
 * request_permission — model asks the operator to unblock a tool for the
 * rest of the session (Codex request_permissions analogue). The model can
 * never elevate itself: the card goes to the operator; only on approval is
 * the named tool added to the session allow set. The grant is session-
 * scoped — a fresh conversation asks again.
 */
export function requestPermissionTool({ asks }) {
  return {
    name: 'request_permission',
    label: 'Request Permission',
    description:
      'Ask the operator to allow a tool for the rest of this session without ' +
      'an approval card each call (e.g. repeated shell commands you need for ' +
      'this task). The operator decides — you cannot grant it yourself.',
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'tool name to unblock for this session' },
        reason: { type: 'string', description: 'why this tool is needed (shown to the operator)' },
      },
      required: ['tool'],
    },
    async execute(id, p) {
      const tool = String(p?.tool ?? '').trim();
      if (!tool) {
        return { content: [{ type: 'text', text: 'request_permission requires {tool}' }], isError: true };
      }
      if (!asks?.ask || !asks?.grantSession) {
        return { content: [{ type: 'text', text: 'request_permission unavailable: no operator channel' }], isError: true };
      }
      const answer = await asks.ask({
        toolName: 'request_permission',
        toolCallId: id,
        rule: 'permission_request',
        summary: `agent 请求本会话内免卡使用 '${tool}'`,
        detail: String(p?.reason ?? '').slice(0, 500) || null,
        args: { tool },
        argsTruncated: false,
        argsTotalChars: null,
      });
      if (answer !== 'allow' && answer !== 'allow_session' && answer !== 'always') {
        return { content: [{ type: 'text', text: `request_permission '${tool}' refused (${answer})` }], isError: true };
      }
      asks.grantSession(tool);
      return { content: [{ type: 'text', text: `'${tool}' allowed for this session — operator granted` }] };
    },
  };
}
