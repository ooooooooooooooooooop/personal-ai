/**
 * Structured denial rendering — Kimi-style repair guidance.
 *
 * The kernel returns denials as structured fields {rule, expected, actual,
 * repair}. This module renders them into reason text that tells the model
 * (or operator) exactly what was wrong and what a passing call looks like —
 * a denial you cannot act on just burns turns.
 */

/** Render a kernel decision into a human/model-readable denial reason. */
export function renderDenial(decision, ctx) {
  const parts = [`denied: ${decision.reason ?? decision.rule ?? 'policy'}`];
  if (decision.expected != null) parts.push(`expected: ${fmt(decision.expected)}`);
  if (decision.actual != null) parts.push(`got: ${fmt(decision.actual)}`);
  if (decision.repair) parts.push(`how to fix: ${decision.repair}`);
  parts.push(`(rule=${decision.rule ?? 'unspecified'}, tool=${ctx?.toolName ?? 'unknown'})`);
  return parts.join(' | ');
}

/** Attach a rendered reason onto a kernel decision without mutating the original. */
export function withRenderedReason(decision, ctx) {
  if (!decision?.block) return decision;
  return { ...decision, reason: renderDenial(decision, ctx) };
}

const fmt = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
