/**
 * Shared governed mode switch (M131): one ask-card → applyMode path used by
 * both the mode_request tool and recipe frontmatter `mode:` fields. Returns
 * { ok, text } — callers render the outcome into their own tool result.
 */
export async function requestModeSwitch({ catalogModes, applyMode, asks, name, reason = '', toolCallId = null }) {
  const catalog = catalogModes();
  if (!catalog.includes(name)) {
    return { ok: false, text: `unknown mode '${name}' — available: ${catalog.join(', ')}` };
  }
  if (!asks?.ask) {
    return { ok: false, text: 'no operator channel — mode switch unavailable' };
  }
  const answer = await asks.ask({
    toolName: 'mode_request',
    toolCallId,
    rule: 'mode_request',
    summary: `agent 请求切换到 '${name}' 模式`,
    detail: String(reason ?? '').slice(0, 500) || null,
    args: { name },
    argsTruncated: false,
    argsTotalChars: null,
  });
  if (answer !== 'allow' && answer !== 'allow_session' && answer !== 'always') {
    return { ok: false, text: `mode '${name}' refused (${answer}) — continue under the current mode` };
  }
  const r = applyMode(name);
  return r
    ? { ok: true, text: `mode switched to '${r.mode}'` }
    : { ok: false, text: `mode '${name}' failed to apply` };
}

/**
 * Shared governed model switch (dedup-h #146): one ask-card → channel
 * model_set path used by recipe frontmatter `model:` fields. The recipe
 * file is untrusted workdir content — it can REQUEST a model change, it
 * can never force one; refusal is reported honestly in the tool result.
 * spec: 'provider/model' or a registered alias. Returns { ok, text }.
 */
export async function requestModelSwitch({ spec, asks, runChannel, toolCallId = null }) {
  const raw = String(spec ?? '').trim();
  const m = raw.match(/^([^\s/]+)\/(\S+)$/);
  const cmd = m
    ? { type: 'model_set', provider: m[1], model: m[2] }
    : { type: 'model_set', alias: raw };
  if (!raw) return { ok: false, text: 'empty model spec' };
  if (!asks?.ask) return { ok: false, text: 'no operator channel — model switch unavailable' };
  if (!runChannel) return { ok: false, text: 'no channel dispatch — model switch unavailable' };
  const answer = await asks.ask({
    toolName: 'model_request',
    toolCallId,
    rule: 'model_request',
    summary: `agent 请求切换模型 '${raw}'`,
    detail: `recipe frontmatter requests model ${raw}`,
    args: { model: raw },
    argsTruncated: false,
    argsTotalChars: null,
  });
  if (answer !== 'allow' && answer !== 'allow_session' && answer !== 'always') {
    return { ok: false, text: `model '${raw}' refused (${answer}) — continue under the current model` };
  }
  const r = await runChannel(cmd).catch((e) => ({ success: false, error: String(e?.message ?? e) }));
  return r?.success
    ? { ok: true, text: `model switched to '${raw}'` }
    : { ok: false, text: `model '${raw}' failed: ${r?.error ?? 'no response'}` };
}

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
      const r = await requestModeSwitch({
        catalogModes, applyMode, asks, name,
        reason: String(p?.reason ?? ''), toolCallId: _id,
      });
      return r.ok
        ? { content: [{ type: 'text', text: r.text }] }
        : { content: [{ type: 'text', text: `mode_request: ${r.text}` }], isError: true };
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
