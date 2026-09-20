/**
 * ask_user — structured operator question (Claude Code AskUserQuestion /
 * Cline ask_followup_question analogue).
 *
 * The tool suspends on the PendingAsks surface as kind:'question' — a
 * different contract from approval asks: the operator's answer is an option
 * label or free text, questions are never auto-allowed for the session, and
 * timeout/abort resolve to a refusal the model can see. The ask card renders
 * in the UI exactly like an approval gate, so a run that needs an answer is
 * blocked on a human, not on a retry.
 */

const REFUSAL_ANSWERS = {
  deny: 'the operator declined to answer',
  timeout: 'the operator did not answer before the question expired',
  aborted: 'the session was interrupted while the question was pending',
};

/**
 * @param {() => import('../../../host/src/core/asks.js').PendingAsks} getAsks
 *        live PendingAsks registry (assigned after core construction)
 */
export function askUserTool(getAsks) {
  return {
    name: 'ask_user',
    label: 'Ask User',
    description:
      'Ask the operator a question and wait for their answer. Use when you need ' +
      'a decision, clarification, or missing information that only the user can ' +
      'provide. Offer 2-4 concise options when the answer space is enumerable; ' +
      'the operator can always answer in free text instead.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'the question shown to the operator' },
        options: {
          type: 'array',
          description: 'suggested answers (2-4); the operator may still answer in free text',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['label'],
          },
        },
      },
      required: ['question'],
    },
    async execute(toolCallId, params) {
      const asks = getAsks?.();
      const question = String(params.question ?? '').trim();
      if (!question) {
        return { content: [{ type: 'text', text: 'ask_user requires a non-empty question' }], isError: true };
      }
      if (!asks) {
        return {
          content: [{ type: 'text', text: 'ask_user unavailable: no operator question channel is configured' }],
          isError: true,
        };
      }
      const options = (params.options ?? [])
        .map((o) => ({ label: String(o?.label ?? '').trim(), description: o?.description ?? null }))
        .filter((o) => o.label)
        .slice(0, 4);
      const answer = await asks.ask({
        kind: 'question',
        toolName: 'ask_user',
        toolCallId,
        rule: 'user_question',
        summary: question,
        options,
      });
      if (REFUSAL_ANSWERS[answer]) {
        return {
          content: [{ type: 'text', text: `question unanswered: ${REFUSAL_ANSWERS[answer]} — proceed on your best judgment or end the turn` }],
        };
      }
      return {
        content: [{ type: 'text', text: `operator answered: ${answer}` }],
        details: { answer },
      };
    },
  };
}
