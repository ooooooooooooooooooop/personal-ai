/**
 * M1 end-to-end: startHost wires host core + pi body for real.
 * No model contact — stub model satisfies construction; the guard chain and
 * host artifacts are what matter here.
 */
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHost } from '../src/bootstrap/host.js';

const stubModel = {
  id: 'stub', name: 'stub', api: 'openai-completions', provider: 'openai',
  baseUrl: 'http://127.0.0.1:9', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000, maxTokens: 4096,
};

test('startHost assembles a governed pi body end-to-end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-boot-'));
  // M2: canonical policy is a fail-closed requirement — provision the fixture
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: { destructive: 'deny', privilege: 'deny' },
  }));
  const host = await startHost({
    instanceRoot: dir,
    workdir: dir,
    sessionOptions: { model: stubModel },
  });

  // guard sealed on the REAL session
  assert.ok(host.guard.sealed());

  // body facts registered — facts, not status (frozen schema fields)
  const body = host.registry.get('pi');
  assert.equal(body.verified_capabilities.final_post_extension_guard, 'supported');
  assert.equal(body.verified_capabilities.mcp_native, 'unsupported');
  assert.equal(body.verified_capabilities.durable_jobs, 'supported');
  assert.equal(body.governance_coverage.tool_decide, 'supported');
  assert.equal(body.handoff_capabilities.resume, 'supported');

  // runtime identity on disk with both lockfile hashes
  const identity = JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf-8'));
  assert.equal(identity.adapter_id, 'pi');
  assert.ok(identity.lockfile_sha256.pi);
  assert.ok(identity.lockfile_sha256.host);

  // audit: HOST_STARTED recorded, run id present; BODY_SELECTED proves the
  // default body is a selector output, not a declaration
  const auditLines = readFileSync(
    join(dir, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf-8')
    .trim().split('\n').map(JSON.parse);
  assert.ok(auditLines.some((e) => e.kind === 'HOST_STARTED'));
  const sel = auditLines.find((e) => e.kind === 'BODY_SELECTED');
  assert.equal(sel?.data?.selected, 'pi');
  assert.ok(sel.data.results.pi.eligible);

  // envelopes built as two distinct channels
  assert.equal(host.instructionEnvelope.kind, 'InstructionEnvelope');
  assert.equal(host.contextEnvelope.kind, 'ContextEnvelope');

  // lease store live: claim a domain through the real store
  const claim = host.leases.claim({ scope: 'domain', name: 'smoke', owner: 'pi:test', ttlSeconds: 60 });
  assert.ok(claim.ok);
  host.leases.close();
});

test('M8-B4: canonical observations flow into the live context provider', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-boot-obs-'));
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  const host = await startHost({
    instanceRoot: dir,
    workdir: dir,
    sessionOptions: { model: stubModel },
  });

  // real canonical source — record an observation, the provider re-reads it
  host.observations.record({ kind: 'tool_result', subject: 'bash', detail: { isError: false }, actor: 'pi' });
  const env = host.contextProvider();
  assert.ok(env.observations.some((o) => o.subject === 'bash'));

  // rendered into the context channel text (what the model actually sees)
  const { renderContext } = await import('../../host/src/core/envelopes.js');
  const rendered = renderContext(env);
  assert.ok(rendered.includes('<observations>'));
  assert.ok(rendered.includes('[tool_result] bash'));

  // canonical durability: a fresh store over the same dir sees it — the
  // projection survives process restarts, so post-compaction turns re-read it
  const { ObservationStore } = await import('../../host/src/core/observation.js');
  const reopened = new ObservationStore(join(dir, 'canonical'));
  assert.ok(reopened.recent(20).some((o) => o.subject === 'bash'));

  host.leases.close();
});

test('M8: ToolSurface + FileOpsGuard are wired into the real session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-boot-m8-'));
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], riskActions: {},
    tools: { powershell: { action: 'deny' } }, // policy-denied from turn zero
  }));
  const host = await startHost({
    instanceRoot: dir,
    workdir: dir,
    sessionOptions: { model: stubModel },
  });

  // production instances exist — not just modules
  assert.ok(host.toolSurface);
  assert.ok(host.fileOps);

  // initial suppression: denied tool is off the REAL session's visible surface
  const active = host.session.getActiveToolNames();
  assert.ok(!active.includes('powershell'));
  assert.ok(host.toolSurface.isDenied('powershell'));

  // deny-memory persisted under the instance root
  assert.ok(existsSync(join(dir, 'deny-memory.json')));

  host.leases.close();
});

test('M89: session_import never mutates the source file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-import-'));
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  const host = await startHost({
    instanceRoot: dir,
    workdir: dir,
    sessionOptions: { model: stubModel },
  });
  // a foreign pi session file WITHOUT a trailing newline — upstream
  // loadEntriesFromFile() appends '\n' to repair that; importing must not
  // let that write reach the source (it is someone else's file)
  const src = join(dir, 'foreign.jsonl');
  const srcContent =
    JSON.stringify({ type: 'session', version: 3, id: 'src-1', timestamp: new Date().toISOString(), cwd: dir }) + '\n' +
    JSON.stringify({ type: 'message', id: 'm1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } });
  writeFileSync(src, srcContent); // deliberately no trailing newline
  const before = readFileSync(src);
  const r = await host.channel.handle({ type: 'session_import', path: src });
  assert.equal(r.success, true, `import failed: ${JSON.stringify(r)}`);
  assert.deepEqual(readFileSync(src), before, 'source bytes must be identical after import');
  // M89-R2: the fork stamps parentSession=<scratch>; the import must rewrite
  // the destination header to name the ORIGINAL source — provenance must not
  // dangle on a deleted temp file.
  const destFile = r.data?.file ?? r.file;
  assert.ok(destFile && existsSync(destFile), `imported session file missing: ${JSON.stringify(r)}`);
  const header = JSON.parse(readFileSync(destFile, 'utf-8').split('\n')[0]);
  assert.equal(header.parentSession, resolve(src), 'imported header must name the original source, not the deleted scratch');
  const scratchDir = join(dir, 'sessions', '.import-scratch');
  assert.ok(
    !existsSync(scratchDir) || readdirSync(scratchDir).length === 0,
    'scratch copy must be gone after import');
  host.leases.close();
});
