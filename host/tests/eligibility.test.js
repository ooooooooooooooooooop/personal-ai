import test from 'node:test';
import assert from 'node:assert/strict';
import { eligible } from '../src/core/eligibility.js';

const DSH = {
  body_id: 'dsh',
  capabilities: {
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
