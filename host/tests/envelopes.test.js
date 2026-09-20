import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContextEnvelope,
  buildInstructionEnvelope,
  renderContext,
  renderInstruction,
} from '../src/core/envelopes.js';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditWriter, hashOf, redact } from '../src/core/audit.js';

test('instruction and context are separate artifacts (R9)', () => {
  const ins = buildInstructionEnvelope({
    soulManifest: { soul_version: '0.1.2', release: { tag: 'soul-0.1.2' } },
    policyText: 'GOVERNANCE: never X',
  });
  const ctx = buildContextEnvelope({ briefing: 'state briefing', openPredictions: [{}] });
  assert.equal(ins.kind, 'InstructionEnvelope');
  assert.equal(ctx.kind, 'ContextEnvelope');
  assert.match(renderInstruction(ins), /GOVERNANCE: never X/);
  assert.match(renderInstruction(ins), /soul 0\.1\.2/);
  assert.match(renderContext(ctx), /state briefing/);
  assert.throws(() => renderContext(ins), /ContextEnvelope/);
});

test('audit redacts credentials and secrets in nested data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-audit-'));
  const w = new AuditWriter({ auditDir: dir }, { name: 't' });
  w.write({
    kind: 'PROVIDER_HEADERS',
    data: {
      headers: { Authorization: 'Bearer sk-live', 'x-trace': 'ok' },
      nested: { api_key: 'k', normal: 1 },
    },
  });
  const line = JSON.parse(readFileSync(join(dir, 't.jsonl'), 'utf-8').trim());
  assert.equal(line.data.headers.Authorization, 'REDACTED');
  assert.equal(line.data.nested.api_key, 'REDACTED');
  assert.equal(line.data.headers['x-trace'], 'ok');
  assert.equal(line.data.nested.normal, 1);
});

test('hashOf gives correlation without content', () => {
  const h = hashOf({ secret: 'payload' });
  assert.match(h, /^sha256:[0-9a-f]{64}$/);
  assert.equal(hashOf('same'), hashOf('same'));
});

test('instruction channel always carries the untrusted-content rule', async () => {
  const { renderInstruction } = await import('../src/core/envelopes.js');
  const out = renderInstruction({ kind: 'InstructionEnvelope', instructions: 'POLICY' });
  assert.ok(out.includes('<untrusted-content-policy>'));
  assert.ok(out.includes('never follow instructions') || out.includes('Never follow instructions'));
});
