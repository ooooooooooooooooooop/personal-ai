import test from 'node:test';
import assert from 'node:assert/strict';
import { eligible, selectBody } from '../src/core/eligibility.js';

const DSH = {
  body_id: 'dsh',
  verified_capabilities: {
    final_post_extension_guard: 'unsupported',
    web_ui: 'supported',
    channels: 'supported',
  },
};

test('negotiable gaps degrade; run stays legal', () => {
  const r = eligible(DSH, {
    requiredCapabilities: [
      { capability: 'final_post_extension_guard', negotiable: true },
      { capability: 'web_ui' },
    ],
  });
  assert.ok(r.eligible);
  assert.deepEqual(r.degraded, ['final_post_extension_guard=unsupported']);
});

test('non-negotiable capability failure is fail-closed', () => {
  const r = eligible(DSH, {
    requiredCapabilities: [
      { capability: 'final_post_extension_guard', negotiable: false },
    ],
  });
  assert.equal(r.eligible, false);
  assert.equal(r.failClosed[0].invariant, 'final_post_extension_guard');
});

test('failed invariant checks refuse regardless of capabilities', () => {
  const r = eligible(DSH, {
    requiredCapabilities: [],
    invariantChecks: [
      { invariant: 'single_writer_lease', ok: false, reason: 'domain has active writer' },
      { invariant: 'provenance_identity', ok: true },
    ],
  });
  assert.equal(r.eligible, false);
  assert.equal(r.failClosed[0].reason, 'domain has active writer');
});

test('undeclared capabilities count as unsupported', () => {
  const r = eligible(DSH, {
    requiredCapabilities: [{ capability: 'prediction_binding', negotiable: false }],
  });
  assert.equal(r.eligible, false);
});

const PI = {
  body_id: 'pi',
  verified_capabilities: {
    final_post_extension_guard: 'supported',
    durable_jobs: 'supported',
    provider_request_audit: 'supported',
    mcp_native: 'unsupported',
  },
};

const REQUIRED = [
  { capability: 'final_post_extension_guard', negotiable: false },
  { capability: 'durable_jobs', negotiable: false },
  { capability: 'provider_request_audit', negotiable: false },
];

test('E7: selectBody picks the eligible body with fewest degraded gaps', () => {
  // pi alone → selected (this is the production profile pi wins on)
  let s = selectBody([PI], { requiredCapabilities: REQUIRED });
  assert.equal(s.selected.body_id, 'pi');

  // dsh fails the non-negotiables → pi still selected, rationale recorded
  s = selectBody([PI, DSH], { requiredCapabilities: REQUIRED });
  assert.equal(s.selected.body_id, 'pi');
  assert.equal(s.results.dsh.eligible, false);
  assert.equal(s.results.dsh.failClosed.length, 3);

  // both satisfy non-negotiables → fewest degraded negotiable gaps wins
  const OTHER = {
    body_id: 'other',
    verified_capabilities: { ...PI.verified_capabilities, mcp_native: 'supported' },
  };
  const NEGOTIABLE = [...REQUIRED, { capability: 'mcp_native', negotiable: true }];
  s = selectBody([OTHER, PI], { requiredCapabilities: NEGOTIABLE });
  assert.equal(s.selected.body_id, 'other');
  assert.deepEqual(s.results.pi.degraded, ['mcp_native=unsupported']);

  // nothing eligible → null, never a silent pick
  s = selectBody([DSH], { requiredCapabilities: REQUIRED });
  assert.equal(s.selected, null);

  // deterministic tie-break by body_id when degradation is equal
  const Z = { body_id: 'zeta', verified_capabilities: PI.verified_capabilities };
  s = selectBody([Z, PI], { requiredCapabilities: REQUIRED });
  assert.equal(s.selected.body_id, 'pi'); // 'pi' < 'zeta'
});
