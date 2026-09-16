/**
 * L2 contract evidence (R8/R9): a FakeBody that satisfies the Host contract
 * surface — registry facts, scoped leases, handoff machine — WITHOUT any real
 * harness. Passing this suite means the contract is implementable; it does
 * NOT yet prove harness-neutrality (that needs real Pi/DSH adapters, L3/L4).
 */
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BodyRegistry } from '../src/core/registry.js';
import { DomainLeaseStore } from '../src/core/lease.js';
import { HandoffStore, makePortableContinuityEnvelope } from '../src/core/handoff.js';
import { eligible } from '../src/core/eligibility.js';

/** Minimal body that honors the contract: declares facts, holds leases. */
class FakeBody {
  constructor(bodyId, capabilities) {
    this.body_id = bodyId;
    this.capabilities = capabilities;
    this.held = [];
  }
  facts() {
    return {
      body_id: this.body_id,
      adapter_version: '0.0.0-fake',
      verified_capabilities: this.capabilities,
      supported_effect_domains: ['memory'],
    };
  }
  claim(leases, scope, name) {
    const r = leases.claim({ scope, name, owner: `${this.body_id}:run`, ttlSeconds: 30 });
    if (r.ok) this.held.push({ scope, name, generation: r.lease.generation });
    return r;
  }
  /** governed write path: fencing check before every effect */
  writeEffect(leases, scope, name) {
    const lease = this.held.find((l) => l.scope === scope && l.name === name);
    return leases.assertHeld({ scope, name, owner: `${this.body_id}:run`, generation: lease?.generation });
  }
}

function paths() {
  const root = mkdtempSync(join(tmpdir(), 'pai-fake-'));
  return { root, checkpointsDir: join(root, 'checkpoints') };
}

test('L2: two fake bodies cannot co-write a domain; fencing evicts the loser', () => {
  const p = paths();
  const leases = new DomainLeaseStore(p, { now: () => 1000 });
  const a = new FakeBody('fake-a', {});
  const b = new FakeBody('fake-b', {});

  assert.ok(a.claim(leases, 'domain', 'world-model').ok);
  assert.equal(b.claim(leases, 'domain', 'world-model').ok, false);

  // a writes fine while it holds the fencing token
  assert.ok(a.writeEffect(leases, 'domain', 'world-model'));
  // b never held a token
  assert.equal(b.writeEffect(leases, 'domain', 'world-model'), false);
  leases.close();
});

test('L2: registry records facts; eligibility decides, not architecture', () => {
  const p = paths();
  const registry = new BodyRegistry(p);
  const strong = new FakeBody('strong', { guard: 'supported' });
  const weak = new FakeBody('weak', { guard: 'unsupported', ui: 'supported' });
  registry.register(strong.facts());
  registry.register(weak.facts());

  const strictTask = {
    requiredCapabilities: [{ capability: 'guard', negotiable: false }],
  };
  assert.ok(eligible(registry.get('strong'), strictTask).eligible);
  assert.equal(eligible(registry.get('weak'), strictTask).eligible, false);

  const laxTask = {
    requiredCapabilities: [{ capability: 'guard', negotiable: true }],
  };
  const r = eligible(registry.get('weak'), laxTask);
  assert.ok(r.eligible); // degraded but legal — selector's call
  assert.equal(r.degraded.length, 1);
});

test('L2: cold handoff transfers writer ownership through the machine', () => {
  const p = paths();
  const leases = new DomainLeaseStore(p, { now: () => 1000 });
  const handoffs = new HandoffStore(p);
  const from = new FakeBody('old-body', {});
  const to = new FakeBody('new-body', {});

  from.claim(leases, 'domain', 'jobs');
  const oldLease = from.held[0];

  handoffs.begin({ handoffId: 'hb', fromBody: 'old-body', toBody: 'new-body' });
  handoffs.quiesce('hb');
  handoffs.checkpoint('hb', makePortableContinuityEnvelope({
    goalIdentity: 'g', canonicalCursor: 'c', soulIdentity: {},
    openPredictions: [], jobCursors: [], policyIdentity: 'p',
    provenanceChain: 'pc', source: { body: 'old-body', session: 's', run: 'r' },
  }));
  leases.release({ scope: 'domain', name: 'jobs', owner: 'old-body:run', generation: oldLease.generation });
  handoffs.release('hb', [{ domain: 'jobs' }]);

  // new body acquires through the same lease store — no dual-write window
  const acq = to.claim(leases, 'domain', 'jobs');
  assert.ok(acq.ok);
  handoffs.acquire('hb', { byBody: 'new-body', leases: [acq.lease] });
  handoffs.resume('hb');
  const v = handoffs.verify('hb', {
    policyIdentity: true,
    stateCursor: true,
    provenanceParent: true,
    writerLease: to.writeEffect(leases, 'domain', 'jobs'),
    capabilityCoverage: true,
  });
  assert.ok(v.ok);
  // old body's stale token stays dead
  assert.equal(from.writeEffect(leases, 'domain', 'jobs'), false);
  leases.close();
});
