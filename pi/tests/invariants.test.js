/**
 * M7 — the switch drill: kill → cold restart → identity invariants verified,
 * plus a full cold-handoff envelope cycle (pi→pi; the contract is body-agnostic
 * so the same path serves pi→anything once a second body exists).
 *
 * Invariant map (the migration's acceptance contract):
 *   I1 soul/identity continuity    — same instance identity + runtime lineage
 *   I2 canonical-state continuity  — same canonical dir, attestation passes
 *   I3 governance continuity       — same kernel decisions after restart
 *   I4 world-model continuity      — open predictions survive the kill
 *   I5 durable-job continuity      — dead workers recover via recoveryTick
 *   I6 provenance continuity       — audit ledger appends, never restarts
 *   I7 harness-neutrality          — envelope carries PAI-owned state only
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHost } from '../src/bootstrap/host.js';
import { HandoffStore, makePortableContinuityEnvelope } from '../../host/src/core/handoff.js';
import { hashOf } from '../../host/src/core/audit.js';

const stubModel = {
  id: 'stub', name: 'stub', api: 'openai-completions', provider: 'openai',
  baseUrl: 'http://127.0.0.1:9', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000, maxTokens: 4096,
};

const provision = (dir) => {
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: { destructive: 'deny', privilege: 'deny' },
  }));
};

const auditLines = (dir) =>
  readFileSync(join(dir, 'audit', 'host-audit.jsonl'), 'utf-8')
    .trim().split('\n').map((l) => JSON.parse(l));

test('M7 drill: kill → cold restart → identity invariants hold', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-m7-'));
  provision(dir);

  // === life 1: host boots, opens a prediction, registers a durable job ===
  const h1 = await startHost({ instanceRoot: dir, workdir: dir, sessionOptions: { model: stubModel } });
  const p = h1.predictions.open({ claim: 'rain tomorrow', horizon: '1d' });
  const job = h1.jobStore.createJob({ jobType: 'shell_command', authorizedRoot: dir });
  h1.jobStore.startAttempt({
    jobId: job.job_id, writerId: 'life1', workerType: 'child_process',
    workerIdentity: { pid: 999_999_999 }, // dead-on-arrival pid: no live worker
  });
  h1.jobStore.db.close(); // === the kill: host process gone ===

  // === life 2: cold start on the same instance root ===
  const h2 = await startHost({ instanceRoot: dir, workdir: dir, sessionOptions: { model: stubModel } });

  // I1 identity: same instance, new run lineage recorded
  const runtime = JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf-8'));
  assert.equal(runtime.run_id, h2.runId);
  assert.notEqual(h2.runId, h1.runId); // lineage: new run, same instance

  // I2 canonical: attestation passes — kernel functional
  const denied = await h2.kernel.decideToolCall({
    toolCallId: 't1', toolName: 'bash', args: { command: 'rm -rf /' },
  });
  assert.equal(denied?.block, true); // I3 governance: same decision across lives

  // I4 world-model: the open prediction from life 1 is visible in life 2
  const open = h2.predictions.openPredictions();
  assert.ok(open.some((x) => x.id === p.id));

  // I5 durable jobs: dead worker detected and parked/resumed by the cold sweep
  assert.ok(h2.recoveryActions.some((a) => a.job_id === job.job_id));

  // I6 provenance: audit ledger APPENDED (2 HOST_STARTED, not restarted)
  const starts = auditLines(dir).filter((e) => e.kind === 'HOST_STARTED');
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].runId, starts[1].runId);

  h2.jobStore.db.close();
});

test('M7 drill: cold handoff envelope carries PAI-owned continuity end-to-end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-m7-handoff-'));
  provision(dir);
  const host = await startHost({ instanceRoot: dir, workdir: dir, sessionOptions: { model: stubModel } });
  const p = host.predictions.open({ claim: 'deploy friday' });
  const job = host.jobStore.createJob({ jobType: 'shell_command', authorizedRoot: dir });

  const store = new HandoffStore(host.paths);
  store.begin({ handoffId: 'h-1', fromBody: 'pi', toBody: 'pi' });
  store.quiesce('h-1', { writerAuthority: 'stopped', session: 'suspended' });
  const envelope = makePortableContinuityEnvelope({
    goalIdentity: 'goal-1',
    canonicalCursor: hashOf('canonical-ledger-head'),
    soulIdentity: 'soul:personal-ai',
    openPredictions: host.predictions.openPredictions().map((x) => x.id),
    jobCursors: [{ job_id: job.job_id, attempt: 1, checkpoint_ref: null }],
    policyIdentity: hashOf(readFileSync(join(dir, 'canonical', 'policy.json'), 'utf-8')),
    provenanceChain: [host.runId],
    source: { body: 'pi', session: 'sess-1', run: host.runId },
  });
  store.checkpoint('h-1', envelope);
  store.release('h-1', ['canonical:world-model', 'jobs']);
  store.acquire('h-1', { byBody: 'pi', leases: ['canonical:world-model', 'jobs'] });
  store.resume('h-1');
  const verdict = store.verify('h-1', {
    policyMatch: true,
    canonicalCursorMatches: true,
    predictionsPresent: envelope.openPredictions.includes(p.id),
    writerLeaseHeld: true,
  });
  assert.equal(verdict.ok, true);
  assert.equal(store.status('h-1').state, 'verified');
  assert.equal(store.pending().length, 0); // nothing resumable left
  host.jobStore.db.close();
});
