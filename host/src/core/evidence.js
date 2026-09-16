/**
 * TurnEvidence evaluator — ZCode-style goal completion evidence gates.
 *
 * "The model said it's done" is not evidence. A task declares the evidence
 * kinds that must exist in the turn record; the evaluator checks the actual
 * record (tool calls that ran, their error status, assistant text, file
 * mutations) and returns the unmet gap list. The continuation queue decides
 * what to do with gaps — this module only measures.
 *
 * Evidence kinds:
 *   tool_call      — a tool call executed (optional `tool` name match)
 *   tool_success   — a tool call completed without error
 *   text_pattern   — assistant output contains `match` (substring or /regex/)
 *   file_change    — a governed file mutation happened (fileops receipt)
 *
 * @typedef {Object} EvidenceRequirement
 * @property {string} id
 * @property {'tool_call'|'tool_success'|'text_pattern'|'file_change'} kind
 * @property {string} [tool]
 * @property {string} [match]
 *
 * @typedef {Object} TurnRecord
 * @property {{name:string,isError:boolean}[]} toolCalls
 * @property {string} assistantText
 * @property {unknown[]} fileChanges
 */

function met(req, turn) {
  switch (req.kind) {
    case 'tool_call':
      return turn.toolCalls.some((c) => !req.tool || c.name === req.tool);
    case 'tool_success':
      return turn.toolCalls.some((c) => !c.isError && (!req.tool || c.name === req.tool));
    case 'text_pattern': {
      if (!req.match) return false;
      if (req.match.startsWith('/') && req.match.endsWith('/')) {
        return new RegExp(req.match.slice(1, -1)).test(turn.assistantText);
      }
      return turn.assistantText.includes(req.match);
    }
    case 'file_change':
      return turn.fileChanges.length > 0;
    default:
      return false;
  }
}

/**
 * @param {EvidenceRequirement[]} requirements
 * @param {TurnRecord} turn
 * @returns {import('./contracts.js').TurnEvidence} {sufficient, gaps}
 */
export function evaluateEvidence(requirements, turn) {
  const gaps = (requirements ?? [])
    .filter((req) => !met(req, turn))
    .map((req) => req.id);
  return { sufficient: gaps.length === 0, gaps };
}

/** Structured gap text for steer injection — repair-oriented, machine-parseable. */
export function renderGap(requirements, gaps) {
  const missing = (requirements ?? []).filter((r) => gaps.includes(r.id));
  const lines = missing.map((r) => `- ${r.id}: ${r.kind}${r.tool ? ` (tool=${r.tool})` : ''}${r.match ? ` match=${r.match}` : ''}`);
  return `EVIDENCE GAP — the goal is not yet proven. Missing evidence:\n${lines.join('\n')}\nProduce the missing evidence before concluding.`;
}
