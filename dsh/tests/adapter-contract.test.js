/**
 * L4 contract evidence (invariant-7 ladder): the REAL DSH adapter passes the
 * same host contract surface FakeBody proved at L2 — registry facts, scoped
 * leases with fencing, handoff envelope produce/consume — within DSH's
 * DECLARED capabilities (honest gaps fail-closed, never silently degraded).
 */
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DshBody } from '../adapter/index.js';
import { BodyRegistry } from '../../host/src/core/registry.js';
import { DomainLeaseStore } from '../../host/src/core/lease.js';
import { HandoffStore } from '../../host/src/core/handoff.js';
import { eligible } from '../../host/src/core/eligibility.js';

function paths() {
  const root = mkdtempSync(join(tmpdir(), 'pai-dsh-l4-'));
  return { root, checkpointsDir: join(root, 'checkpoints') };
}

test('L4: dsh facts register cleanly and eligibility honors declared coverage', () => {
  const p = paths();
  const registry = new BodyRegistry(p);
  const dsh = new DshBody({ runId: 'dsh-run-1' });
  registry.register(dsh.facts());
  const facts = registry.get('dsh');
  assert.equal(facts.verified_capabilities.final_post_extension_guard, 'unsupported');
  assert.equal(facts.verified_capabilities.mcp_native, 'supported');

  // within declared coverage → eligible
  const inScope = eligible(facts, {
    requiredCapabilities: [
      { capability: 'agent_loop', negotiable: false },
      { capability: 'durable_jobs', negotiable: false },
      { capability: 'mcp_native' },
    ],
  });
  assert.ok(inScope.eligible);
  assert.equal(inScope.degraded.length, 0);

  // outside declared coverage → FAIL_CLOSED, never degraded-but-allowed
  const outOfScope = eligible(facts, {
    requiredCapabilities: [{ capability: 'final_post_extension_guard', negotiable: false }],
  });
  assert.equal(outOfScope.eligible, false);
  assert.equal(outOfScope.failClosed[0].invariant, 'final_post_extension_guard');
});

test('L4: dsh body holds leases and is fenced like any writer', () => {
  const p = paths();
  const leases = new DomainLeaseStore(p);
  const a = new DshBody({ runId: 'r1' });
  const b = new DshBody({ runId: 'r2' });

  assert.ok(a.claim(leases, 'domain', 'world-model').ok);
  assert.equal(b.claim(leases, 'domain', 'world-model').ok, false);
  assert.ok(a.writeEffect(leases, 'domain', 'world-model'));
  assert.equal(b.writeEffect(leases, 'domain', 'world-model'), false);
  leases.close();
});

test('L4: dsh adapter exports and imports a real continuity envelope', () => {
  const p = paths();
  const dsh = new DshBody({ runId: 'dsh-run-1' });
  const envelope = dsh.exportContinuity({
    goalIdentity: 'goal-1',
    canonicalCursor: 'sha256:cursor',
    soulIdentity: 'soul:personal-ai@1',
    predictions: [{ id: 'pred-1' }, { id: 'pred-2' }],
    jobs: [{ job_id: 'job-1', current_attempt: 2, checkpoint_ref: 'cp.json' }],
    policyIdentity: 'sha256:policy',
    provenanceChain: ['pi:run-1'],
    source: { body: 'pi', session: 's-1', run: 'run-1' },
  });
  assert.equal(envelope.kind, 'PortableContinuityEnvelope');
  assert.deepEqual(envelope.openPredictions, ['pred-1', 'pred-2']);

  // adapter-side translation: envelope → DSH-consumable projection
  const out = dsh.importContinuity(envelope, {
    dir: join(p.root, 'dsh-in'),
    briefing: 'continue the migration rehearsal',
  });
  assert.ok(existsSync(out.projectionPath));
  assert.deepEqual(out.resumed, { predictions: 2, jobCursors: 1 });
  const text = readFileSync(out.projectionPath, 'utf-8');
  assert.ok(text.includes('pred-1'));
  assert.ok(text.includes('job-1 @ attempt 2'));
  assert.ok(text.includes('pi:run-1')); // provenance carried into projection
});

test('L4: runTask reports unavailable honestly when no dsh cli is installed', async () => {
  const dsh = new DshBody({ runId: 'r', dshCli: join(tmpdir(), 'no-such-dsh-bin.js') });
  const r = await dsh.runTask('hello');
  assert.equal(r.ok, false);
  assert.equal(r.unavailable, true);
});
