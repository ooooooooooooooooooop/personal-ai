import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { HandoffStore, makePortableContinuityEnvelope } from '../src/core/handoff.js';

function store() {
  return new HandoffStore({ checkpointsDir: join(mkdtempSync(join(tmpdir(), 'pai-ho-')), 'cp') });
}

const ENVELOPE = {
  goalIdentity: 'goal-1',
  canonicalCursor: 'cur:42',
  soulIdentity: { soul_version: '0.1.2' },
  openPredictions: [],
  jobCursors: [],
  policyIdentity: 'pol:9',
  provenanceChain: 'chain:abc',
  source: { body: 'dsh', session: 'sess-1', run: 'run-1' },
};

test('cold handoff walks the full seven-phase machine', () => {
  const s = store();
  s.begin({ handoffId: 'h1', fromBody: 'dsh', toBody: 'pi', report: { pending: 0 } });
  s.quiesce('h1', { writerAuthorityStopped: true });
  s.checkpoint('h1', makePortableContinuityEnvelope(ENVELOPE));
  s.release('h1', [{ domain: 'world-model', generation: 3 }]);
  s.acquire('h1', { byBody: 'pi', leases: [{ domain: 'world-model', generation: 4 }] });
  s.resume('h1');
  const v = s.verify('h1', {
    policyIdentity: true, stateCursor: true, provenanceParent: true,
    writerLease: true, capabilityCoverage: true,
  });
  assert.ok(v.ok);
  assert.equal(v.record.state, 'verified');
  assert.equal(s.pending().length, 0);
});

test('release must precede acquire — no dual-write window', () => {
  const s = store();
  s.begin({ handoffId: 'h2', fromBody: 'dsh', toBody: 'pi' });
  s.quiesce('h2');
  s.checkpoint('h2', makePortableContinuityEnvelope(ENVELOPE));
  assert.throws(() => s.acquire('h2', { byBody: 'pi' }), /illegal handoff transition/);
});

test('envelope requires Personal-AI-owned fields; harness state rejected', () => {
  assert.throws(
    () => makePortableContinuityEnvelope({ goalIdentity: 'g' }),
    /missing required fields/,
  );
  assert.throws(
    () => makePortableContinuityEnvelope({ ...ENVELOPE, source: { body: 'dsh' } }),
    /source\.session/,
  );
});

test('verify failure marks handoff failed (fail-closed, not continue)', () => {
  const s = store();
  s.begin({ handoffId: 'h3', fromBody: 'dsh', toBody: 'pi' });
  s.quiesce('h3');
  s.checkpoint('h3', makePortableContinuityEnvelope(ENVELOPE));
  s.release('h3');
  s.acquire('h3', { byBody: 'pi' });
  s.resume('h3');
  const v = s.verify('h3', {
    policyIdentity: true, stateCursor: true, provenanceParent: true,
    writerLease: false, capabilityCoverage: true,
  });
  assert.equal(v.ok, false);
  assert.deepEqual(v.failures, ['writerLease']);
  assert.equal(s.status('h3').state, 'failed');
});

test('verify is fail-closed on MISSING checks — callers cannot skip a gate', () => {
  const s = store();
  s.begin({ handoffId: 'h5', fromBody: 'dsh', toBody: 'pi' });
  s.quiesce('h5');
  s.checkpoint('h5', makePortableContinuityEnvelope(ENVELOPE));
  s.release('h5');
  s.acquire('h5', { byBody: 'pi' });
  s.resume('h5');
  const v = s.verify('h5', { policyIdentity: true, writerLease: true });
  assert.equal(v.ok, false);
  assert.deepEqual(v.failures, ['stateCursor', 'provenanceParent', 'capabilityCoverage']);
  assert.equal(s.status('h5').state, 'failed');
});

test('pending() surfaces cold handoffs for recovery', () => {
  const s = store();
  s.begin({ handoffId: 'h4', fromBody: 'dsh', toBody: 'pi' });
  s.quiesce('h4');
  s.checkpoint('h4', makePortableContinuityEnvelope(ENVELOPE));
  assert.equal(s.pending().length, 1);
  assert.equal(s.pending()[0].id, 'h4');
});
