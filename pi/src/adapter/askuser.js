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

const FIELD_TYPES = new Set(['text', 'textarea', 'number', 'boolean', 'select']);

/**
 * ask_structured — schema→form structured operator input (dedup-h #33 /
 * AskUserForStructuredInput analogue). The model declares a field list; the
 * UI renders a form card; the answer resolves to a validated values object.
 * Host-side PendingAsks re-validates required/number/boolean/select bounds —
 * the UI is a renderer, not the contract owner.
 */
export function askStructuredTool(getAsks) {
  return {
    name: 'ask_structured',
    label: 'Ask Structured Input',
    description:
      'Collect structured input from the operator as a form. Declare fields ' +
      '(key/label/type/required/options) — the operator fills a form card and ' +
      'the answer resolves to a validated object. Use when the answer has ' +
      'several named parts (config values, review fields, parameters); prefer ' +
      'ask_user for a single free-text question.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'form title shown to the operator' },
        fields: {
          type: 'array',
          description: 'form fields, max 12',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'object key in the answer' },
              label: { type: 'string', description: 'field label' },
              type: { type: 'string', enum: ['text', 'textarea', 'number', 'boolean', 'select'] },
              required: { type: 'boolean' },
              options: { type: 'array', items: { type: 'string' }, description: 'required when type=select' },
              default: { description: 'prefilled value' },
              description: { type: 'string', description: 'field help text' },
            },
            required: ['key', 'type'],
          },
        },
      },
      required: ['fields'],
    },
    async execute(toolCallId, params) {
      const asks = getAsks?.();
      if (!asks) {
        return {
          content: [{ type: 'text', text: 'ask_structured unavailable: no operator question channel is configured' }],
          isError: true,
        };
      }
      const fields = Array.isArray(params.fields) ? params.fields : [];
      if (!fields.length || fields.length > 12) {
        return { content: [{ type: 'text', text: 'ask_structured requires 1-12 fields' }], isError: true };
      }
      const keys = new Set();
      for (const f of fields) {
        const key = String(f?.key ?? '').trim();
        if (!key) return { content: [{ type: 'text', text: 'every field requires a non-empty key' }], isError: true };
        if (keys.has(key)) return { content: [{ type: 'text', text: `duplicate field key '${key}'` }], isError: true };
        keys.add(key);
        if (!FIELD_TYPES.has(f?.type)) {
          return { content: [{ type: 'text', text: `field '${key}': unknown type '${f?.type}' (text|textarea|number|boolean|select)` }], isError: true };
        }
        if (f.type === 'select' && (!Array.isArray(f.options) || !f.options.length)) {
          return { content: [{ type: 'text', text: `field '${key}': type=select requires options[]` }], isError: true };
        }
      }
      const title = String(params.title ?? '').trim() || '需要填写信息';
      const answer = await asks.ask({
        kind: 'form',
        toolName: 'ask_structured',
        toolCallId,
        rule: 'user_question',
        summary: title,
        fields,
      });
      if (REFUSAL_ANSWERS[answer]) {
        return {
          content: [{ type: 'text', text: `form unanswered: ${REFUSAL_ANSWERS[answer]} — proceed on your best judgment or end the turn` }],
        };
      }
      return {
        content: [{ type: 'text', text: `operator submitted: ${JSON.stringify(answer)}` }],
        details: { answer },
      };
    },
  };
}
