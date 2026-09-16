/**
 * Eligibility — R8's `eligible(body, task)` predicate.
 *
 * Two disjoint outcome classes:
 *   degraded   — negotiable capability gap. Selector MAY still pick the body;
 *                the run is legal but audit must annotate real coverage.
 *   failClosed — non-negotiable correctness invariant can't hold. Refuse.
 *                NEVER "degraded but allowed".
 *
 * Architecture may refuse only because "this execution cannot keep a system
 * invariant", never because "we dislike this body".
 */
export const NON_NEGOTIABLE_INVARIANTS = [
  'single_writer_lease',
  'provenance_identity',
  'prediction_binding',
  'policy_attestation',
  'handoff_boundary',
  'schema_compatibility',
];

/**
 * @param {import('./contracts.js').BodyFacts} body
 * @param {object} task
 * @param {{capability: string, negotiable?: boolean}[]} task.requiredCapabilities
 * @param {{invariant: string, ok: boolean, reason?: string}[]} task.invariantChecks
 *        pre-evaluated non-negotiable invariant results for THIS execution
 * @returns {import('./contracts.js').EligibilityResult}
 */
export function eligible(body, task = {}) {
  const degraded = [];
  const failClosed = [];
  const caps = body?.capabilities ?? {};

  for (const req of task.requiredCapabilities ?? []) {
    const level = caps[req.capability] ?? 'unsupported';
    if (level === 'supported') continue;
    if (req.negotiable === false) {
      failClosed.push({
        invariant: req.capability,
        reason: `required capability is ${level} on body ${body?.body_id ?? '?'}`,
      });
    } else {
      degraded.push(`${req.capability}=${level}`);
    }
  }

  for (const check of task.invariantChecks ?? []) {
    if (!check.ok) {
      failClosed.push({
        invariant: check.invariant,
        reason: check.reason ?? 'invariant does not hold',
      });
    }
  }

  return { eligible: failClosed.length === 0, degraded, failClosed };
}
