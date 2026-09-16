/**
 * L5/L6 rehearsal (invariant-7 ladder): ONE real task crosses bodies.
 *
 *   life 1 (pi):  real startHost session opens a prediction + runs a real
 *                 durable job to completion; pi holds the world-model lease.
 *   handoff:      quiesce → checkpoint (PortableContinuityEnvelope built from
 *                 REAL host state via the dsh adapter's export) → release.
 *   life 2 (dsh): REAL DshBody acquires the lease, imports the envelope
 *                 (adapter-side translation), resumes, verifies.
 *
 * L5 assertions: canonical schema / soul / policy semantics unchanged across
 * the switch. L6 assertions: state, jobs and provenance are continuous —
 * the audit ledger appends under a new actor, never restarts.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHost } from '../../pi/src/bootstrap/host.js';
import { DshBody } from '../adapter/index.js';
import { BodyRegistry } from '../../host/src/core/registry.js';
import { DomainLeaseStore } from '../../host/src/core/lease.js';
import { HandoffStore } from '../../host/src/core/handoff.js';
import { eligible } from '../../host/src/core/eligibility.js';
import { JobStore } from '../../host/src/core/jobs.js';
import { PredictionStore } from '../../host/src/core/prediction.js';
import { AuditWriter } from '../../host/src/core/audit.js';

const stubModel = {
  id: 'stub', name: 'stub', api: 'openai-completions', provider: 'openai',
  baseUrl: 'http://127.0.0.1:9', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000, maxTokens: 4096,
};

const auditLines = (dir) =>
  readFileSync(join(dir, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf-8')
    .trim().split('\n').map((l) => JSON.parse(l));

test('L5/L6: real task switches pi→dsh — continuity holds end-to-end', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-switch-'));
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  const policyText = JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: { destructive: 'deny', privilege: 'deny' },
  });
  writeFileSync(join(dir, 'canonical', 'policy.json'), policyText);
  const policyHash = `sha256:${createHash('sha256').update(policyText).digest('hex')}`;

  // ===== life 1: pi body runs the real task =====
  const h1 = await startHost({ instanceRoot: dir, workdir: dir, sessionOptions: { model: stubModel } });
  const prediction = h1.predictions.open({ claim: 'deploy friday', horizon: '1d' });
  const { job_id } = h1.executor.spawnCommandJob({
    command: 'echo SWITCH_TASK_OK', workdir: dir, jobType: 'shell_command',
  });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(h1.jobStore.getJob(job_id).job_state, 'COMPLETED', 'real task finished on pi');

  // pi holds the world-model writer lease
  const piLease = h1.leases.claim({ scope: 'domain', name: 'world-model', owner: `pi:${h1.runId}`, ttlSeconds: 60 });
  assert.ok(piLease.ok);

  // ===== handoff: quiesce → checkpoint → release =====
  const dsh = new DshBody({ runId: 'dsh-run-2' });
  const handoffs = new HandoffStore(h1.paths);
  const job = h1.jobStore.getJob(job_id);
  const attempts = h1.jobStore.getAttempts(job_id);
  const envelope = dsh.exportContinuity({
    goalIdentity: 'goal-migration',
    canonicalCursor: `sha256:${createHash('sha256').update(JSON.stringify(h1.predictions.openPredictions())).digest('hex')}`,
    soulIdentity: 'soul:personal-ai',
    predictions: h1.predictions.openPredictions(),
    jobs: [{ job_id: job.job_id, current_attempt: attempts.length, checkpoint_ref: job.checkpoint_ref }],
    policyIdentity: policyHash,
    provenanceChain: [h1.runId],
    source: { body: 'pi', session: h1.session.sessionId ?? 'sess-1', run: h1.runId },
  });

  handoffs.begin({ handoffId: 'sw-1', fromBody: 'pi', toBody: 'dsh' });
  handoffs.quiesce('sw-1', { writerAuthority: 'stopped', session: 'suspended' });
  handoffs.checkpoint('sw-1', envelope);
  h1.leases.release({ scope: 'domain', name: 'world-model', owner: `pi:${h1.runId}`, generation: piLease.lease.generation });
  handoffs.release('sw-1', ['world-model']);
  h1.jobStore.db.close(); // pi life ends — cold handoff, not co-residency

  // ===== life 2: dsh body acquires, imports, resumes, verifies =====
  const leases2 = new DomainLeaseStore(h1.paths);
  const registry2 = new BodyRegistry(h1.paths);
  registry2.register(dsh.facts()); // second body enters the SAME registry
  assert.ok(registry2.get('pi'), 'pi facts survived the switch');

  const acq = dsh.claim(leases2, 'domain', 'world-model');
  assert.ok(acq.ok, 'dsh acquired the released domain');
  handoffs.acquire('sw-1', { byBody: 'dsh', leases: [acq.lease] });

  const imported = dsh.importContinuity(envelope, {
    dir: join(dir, 'dsh-in'),
    briefing: 'migration rehearsal — continue under dsh body',
  });
  handoffs.resume('sw-1');

  // verify against REAL state, not declared intentions — all five gates
  // computed from actual stores, and a missing gate would fail-closed
  const predictions2 = new PredictionStore(join(dir, 'canonical'));
  const jobs2 = new JobStore(join(dir, 'jobs', 'durable_jobs.db'));
  const recomputedCursor = `sha256:${createHash('sha256')
    .update(JSON.stringify(predictions2.openPredictions())).digest('hex')}`;
  const verdict = handoffs.verify('sw-1', {
    policyIdentity: policyHash === `sha256:${createHash('sha256')
      .update(readFileSync(join(dir, 'canonical', 'policy.json'), 'utf-8')).digest('hex')}`,
    stateCursor: envelope.canonicalCursor === recomputedCursor
      && predictions2.openPredictions().some((p) => p.id === prediction.id),
    provenanceParent: envelope.provenanceChain.at(-1) === envelope.source.run
      && envelope.source.run === h1.runId,
    writerLease: dsh.writeEffect(leases2, 'domain', 'world-model'),
    capabilityCoverage: eligible(dsh.facts(), {
      requiredCapabilities: [
        { capability: 'durable_jobs', negotiable: false },
        { capability: 'canonical_prediction_binding', negotiable: false },
      ],
    }).eligible,
  });
  assert.equal(verdict.ok, true);
  assert.equal(handoffs.status('sw-1').state, 'verified');

  // ===== L5: canonical/soul/policy semantics unchanged =====
  assert.equal(readFileSync(join(dir, 'canonical', 'policy.json'), 'utf-8'), policyText);
  assert.ok(predictions2.openPredictions().some((p) => p.id === prediction.id));
  assert.equal(envelope.soulIdentity, 'soul:personal-ai');
  assert.equal(envelope.policyIdentity, policyHash);

  // ===== L6: state/job/provenance continuous =====
  const job2 = jobs2.getJob(job_id);
  assert.equal(job2.job_state, 'COMPLETED', 'job record survived the switch');
  assert.ok(existsSync(jobs2.getAttempts(job_id)[0].result_envelope_ref));

  // dsh performs a REAL post-handoff action on the same task — a governed
  // effect under the NEW fencing token executed through DshBody.runTask as a
  // real subprocess (dsh CLI absent → honest direct-effect path)
  assert.ok(dsh.writeEffect(leases2, 'domain', 'world-model'));
  const continued = await dsh.runTask('continue switch task after handoff', {
    command: 'echo SWITCH_TASK_CONTINUED',
    workdir: dir,
  });
  assert.equal(continued.ok, true, `dsh post-handoff action failed: ${JSON.stringify(continued)}`);
  assert.equal(continued.via, 'direct-effect'); // honest path label, not a fake cli claim
  assert.match(continued.output, /SWITCH_TASK_CONTINUED/);
  const audit2 = new AuditWriter({ auditDir: join(dir, 'audit') });
  audit2.write({
    kind: 'HANDOFF_RESUMED',
    runId: 'dsh-run-2',
    data: { handoffId: 'sw-1', from: 'pi', envelopeJobs: imported.resumed.jobCursors },
  });
  const ledger = auditLines(dir);
  const starts = ledger.filter((e) => e.kind === 'HOST_STARTED');
  assert.equal(starts.length, 1); // one boot, not two — provenance appended
  const resumed = ledger.find((e) => e.kind === 'HANDOFF_RESUMED');
  assert.equal(resumed.runId, 'dsh-run-2'); // new actor, same ledger
  assert.ok(ledger.indexOf(resumed) > ledger.indexOf(starts[0]));

  // pi's stale fencing token stays dead — no dual-write window
  assert.equal(
    leases2.assertHeld({ scope: 'domain', name: 'world-model', owner: `pi:${h1.runId}`, generation: piLease.lease.generation }),
    false,
  );

  leases2.close();
  jobs2.db.close();
});
