/**
 * notify_user — Kimi NotifyUser analogue. The model raises an operator
 * notification (toast + system event) WITHOUT suspending the turn — it is
 * one-way messaging, distinct from ask_user (which awaits an answer) and
 * from approval cards (which gate a call). Audited via the tool-execution
 * ledger like every governed call; the event itself is audit-annotated.
 */
export function notifyUserTool(getEmit) {
  return {
    name: 'notify_user',
    label: 'Notify User',
    description:
      'Send a one-way notification to the operator (toast + notification event). ' +
      'Use for progress milestones, warnings, or results the human should notice ' +
      'but does not need to answer. For questions use ask_user instead.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'notification text shown to the operator' },
        level: { type: 'string', enum: ['info', 'warn', 'err'], description: 'severity (default info)' },
      },
      required: ['message'],
    },
    async execute(_id, p) {
      const message = String(p?.message ?? '').trim();
      if (!message) return { content: [{ type: 'text', text: 'notify_user requires a non-empty message' }], isError: true };
      const level = ['info', 'warn', 'err'].includes(p?.level) ? p.level : 'info';
      const emit = getEmit?.();
      if (!emit) return { content: [{ type: 'text', text: 'notify channel unavailable' }], isError: true };
      emit({ type: 'notify', message: message.slice(0, 500), level });
      return { content: [{ type: 'text', text: `notified operator (${level}): ${message.slice(0, 80)}` }] };
    },
  };
}
