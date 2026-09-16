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
  const caps = body?.verified_capabilities ?? body?.capabilities ?? {};

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

/**
 * Selection policy — "default body" is a mechanism output, not a declaration.
 *
 * Every registered body is evaluated through eligible(); the winner is the
 * eligible body with the FEWEST degraded (negotiable) gaps, ties broken
 * deterministically by body_id. Callers MUST still verify the result — a
 * bootstrap for body X refuses to start when X isn't selected.
 *
 * @param {import('./contracts.js').BodyFacts[]} bodies  registry.list()
 * @param {object} task  same shape as eligible()'s task
 * @returns {{selected: object|null, results: Object<string, EligibilityResult>}}
 */
export function selectBody(bodies, task = {}) {
  const results = {};
  const candidates = [];
  for (const body of bodies ?? []) {
    const r = eligible(body, task);
    results[body?.body_id ?? '?'] = r;
    if (r.eligible) candidates.push({ body, r });
  }
  candidates.sort(
    (a, b) => a.r.degraded.length - b.r.degraded.length
      || String(a.body.body_id).localeCompare(String(b.body.body_id)),
  );
  return { selected: candidates[0]?.body ?? null, results };
}
