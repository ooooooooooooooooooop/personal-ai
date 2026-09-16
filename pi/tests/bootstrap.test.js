/**
 * M1 end-to-end: startHost wires host core + pi body for real.
 * No model contact — stub model satisfies construction; the guard chain and
 * host artifacts are what matter here.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

  // body facts registered — facts, not status
  const body = host.registry.get('pi');
  assert.equal(body.capabilities.final_post_extension_guard, 'supported');
  assert.equal(body.capabilities.mcp_native, 'unsupported');

  // runtime identity on disk with both lockfile hashes
  const identity = JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf-8'));
  assert.equal(identity.adapter_id, 'pi');
  assert.ok(identity.lockfile_sha256.pi);
  assert.ok(identity.lockfile_sha256.host);

  // audit: HOST_STARTED recorded, run id present
  const auditLines = readFileSync(join(dir, 'audit', 'host-audit.jsonl'), 'utf-8')
    .trim().split('\n').map(JSON.parse);
  assert.ok(auditLines.some((e) => e.kind === 'HOST_STARTED'));

  // envelopes built as two distinct channels
  assert.equal(host.instructionEnvelope.kind, 'InstructionEnvelope');
  assert.equal(host.contextEnvelope.kind, 'ContextEnvelope');

  // lease store live: claim a domain through the real store
  const claim = host.leases.claim({ scope: 'domain', name: 'smoke', owner: 'pi:test', ttlSeconds: 60 });
  assert.ok(claim.ok);
  host.leases.close();
});
