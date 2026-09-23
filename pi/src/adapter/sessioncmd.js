/**
 * session_command — model-invoked builtin commands (dedup-h #143; the
 * opencode "model can run slash commands" analogue). The model cannot tear
 * down or retarget the session mid-turn: the call emits a command_request
 * event to the operator surface, which runs it through the SAME code paths
 * as the operator's own slash commands (/clear /model /config /resume)
 * once the turn ends. The tool call itself rides the normal governed chain;
 * the surface effect is operator-visible in the transcript.
 */
const COMMANDS = ['clear', 'model', 'resume', 'config', 'new'];

export function sessionCommandTool(getEmit) {
  return {
    name: 'session_command',
    label: 'Session Command',
    description:
      'Request a builtin session command on the operator surface: ' +
      "'clear' starts a new session, 'new' starts a new session AND posts your arg " +
      "as its first message (Cline new_task analogue — use arg for the context handoff " +
      "briefing the fresh task continues from), 'model' switches model (arg: alias or provider/model), " +
      "'resume' switches to another session (arg: session id or name substring), " +
      "'config' views or sets session config (arg: key=value, or empty to view). " +
      'The command executes when the current turn ends — this call only queues the request.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: COMMANDS, description: 'builtin command to run' },
        arg: { type: 'string', description: 'command argument (optional)' },
      },
      required: ['name'],
    },
    async execute(_id, p) {
      const name = String(p?.name ?? '').trim();
      if (!COMMANDS.includes(name)) {
        return {
          content: [{ type: 'text', text: `session_command: unknown command '${name}' — allowed: ${COMMANDS.join(', ')}` }],
          isError: true,
        };
      }
      const emit = getEmit?.();
      if (!emit) return { content: [{ type: 'text', text: 'no operator surface attached — the command cannot run' }], isError: true };
      // 'new' carries a context-handoff briefing — a cramped cap would gut
      // the point of the feature; other commands only need short args.
      const arg = String(p?.arg ?? '').slice(0, name === 'new' ? 1000 : 300);
      emit({ type: 'command_request', name, arg });
      return {
        content: [{ type: 'text', text: `queued '${name}'${arg ? ` ${arg}` : ''} — runs on the operator surface when this turn ends` }],
      };
    },
  };
}
