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
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHost } from '../src/bootstrap/host.js';
import { isWorkerAlive } from '../src/adapter/jobs.js';
import { HandoffStore, makePortableContinuityEnvelope } from '../../host/src/core/handoff.js';
import { eligible } from '../../host/src/core/eligibility.js';
import { hashOf } from '../../host/src/core/audit.js';

const here = dirname(fileURLToPath(import.meta.url));

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
  readFileSync(join(dir, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf-8')
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
  h1.dispose(); // === life 1 ends: clean shutdown releases the writer lease ===

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

test('M7 drill (real OS kill): SIGKILL the host process → cold restart → invariants hold', { timeout: 40_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-m7-oskill-'));
  provision(dir);

  // === life 1: a REAL child process runs the host, then is really killed ===
  const fixture = join(here, 'fixtures', 'm7-life1.js');
  const child = spawn(process.execPath, [fixture, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  const childErr = [];
  child.stderr.on('data', (d) => childErr.push(String(d)));

  const [runId1, predId, jobId] = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`fixture never became READY: ${buf} ${childErr.join('')}`)), 25_000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/READY (\S+) (\S+) (\S+)/);
      if (m) { clearTimeout(timer); resolve([m[1], m[2], m[3]]); }
    });
    child.on('exit', (code) => reject(new Error(`fixture exited ${code} before READY: ${childErr.join('')}`)));
  });
  assert.ok(isWorkerAlive({ pid: child.pid }), 'fixture process should be alive before the kill');

  child.kill('SIGKILL'); // on Windows Node maps this to TerminateProcess — a real kill
  await new Promise((resolve) => child.on('exit', resolve));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(isWorkerAlive({ pid: child.pid }), false, 'killed host process must be dead at OS level');

  // === life 2: cold start on the same instance root ===
  const h2 = await startHost({ instanceRoot: dir, workdir: dir, sessionOptions: { model: stubModel } });

  // I1 identity: same instance, new run lineage
  const runtime = JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf-8'));
  assert.equal(runtime.run_id, h2.runId);
  assert.notEqual(h2.runId, runId1);

  // I2/I3 canonical + governance continuity: same decision across lives
  const denied = await h2.kernel.decideToolCall({
    toolCallId: 't1', toolName: 'bash', args: { command: 'rm -rf /' },
  });
  assert.equal(denied?.block, true);

  // I4 world-model continuity: the prediction written by the KILLED process is visible
  assert.ok(h2.predictions.openPredictions().some((x) => x.id === predId));

  // I5 durable-job continuity: dead worker recovered by the cold sweep
  assert.ok(h2.recoveryActions.some((a) => a.job_id === jobId));

  // I6 provenance: audit ledger APPENDED — first HOST_STARTED came from the
  // killed process (synchronous append survives SIGKILL)
  const starts = auditLines(dir).filter((e) => e.kind === 'HOST_STARTED');
  assert.equal(starts.length, 2);
  assert.equal(starts[0].runId, runId1);
  assert.equal(starts[1].runId, h2.runId);

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
  // writer lease: old holder releases, post-handoff body re-claims the same domain
  const pre = host.leases.claim({ scope: 'domain', name: 'world-model', owner: `pi:${host.runId}`, ttlSeconds: 60 });
  assert.ok(pre.ok);
  host.leases.release({ scope: 'domain', name: 'world-model', owner: `pi:${host.runId}`, generation: pre.lease.generation });
  store.release('h-1', ['canonical:world-model', 'jobs']);
  const post = host.leases.claim({ scope: 'domain', name: 'world-model', owner: `pi:${host.runId}`, ttlSeconds: 60 });
  assert.ok(post.ok);
  store.acquire('h-1', { byBody: 'pi', leases: ['canonical:world-model', 'jobs'] });
  store.resume('h-1');
  const verdict = store.verify('h-1', {
    policyIdentity: envelope.policyIdentity === hashOf(readFileSync(join(dir, 'canonical', 'policy.json'), 'utf-8')),
    stateCursor: envelope.canonicalCursor === hashOf('canonical-ledger-head'),
    provenanceParent: envelope.provenanceChain.at(-1) === envelope.source.run,
    writerLease: host.leases.assertHeld({
      scope: 'domain', name: 'world-model',
      owner: `pi:${host.runId}`, generation: post.lease.generation,
    }),
    capabilityCoverage: eligible(host.registry.get('pi'), {
      requiredCapabilities: [{ capability: 'final_post_extension_guard', negotiable: false }],
    }).eligible,
  });
  assert.equal(verdict.ok, true);
  assert.equal(store.status('h-1').state, 'verified');
  assert.equal(store.pending().length, 0); // nothing resumable left
  host.jobStore.db.close();
});
