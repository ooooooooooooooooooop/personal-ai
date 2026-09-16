/**
 * M8 acceptance-gap closure: ToolSurface + FileOpsGuard must be wired into the
 * REAL production decide chain (makeDecide), not just exist as modules.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDecide } from '../src/bootstrap/decide.js';
import { FileOpsGuard } from '../src/adapter/fileops.js';
import { ToolSurface } from '../src/adapter/surface.js';
import { AuditWriter } from '../../host/src/core/audit.js';

function rig({ kernelDecision = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pai-m8-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  const audit = new AuditWriter({ auditDir: join(dir, 'audit') });
  const fileOps = new FileOpsGuard(dir);
  const denyCalls = [];
  const surface = { deny: (n) => denyCalls.push(n) };
  const core = {
    audit,
    kernel: { decideToolCall: async () => kernelDecision },
  };
  const decide = makeDecide({ core, executor: null, fileOps, getSurface: () => surface, workdir: dir });
  return { dir, audit, fileOps, denyCalls, decide };
}

const opsLog = (dir) =>
  existsSync(join(dir, 'fileops.jsonl'))
    ? readFileSync(join(dir, 'fileops.jsonl'), 'utf-8').trim().split('\n').map(JSON.parse)
    : [];

test('admitted write produces a pre-execution backup receipt (production decide)', async () => {
  const { dir, decide } = rig();
  const target = join(dir, 'notes.txt');
  writeFileSync(target, 'original bytes');

  const result = await decide({ toolCall: { name: 'write' }, args: { path: target, content: 'x' } });
  assert.equal(result, undefined); // admitted — tool executes after backup

  const ops = opsLog(dir);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, 'backup');
  assert.equal(ops[0].target, target);
  assert.ok(existsSync(ops[0].backup));
  assert.equal(readFileSync(ops[0].backup, 'utf-8'), 'original bytes');
});

test('delete call is recycled, not destroyed, with a receipt', async () => {
  const { dir, decide } = rig();
  const target = join(dir, 'doomed.txt');
  writeFileSync(target, 'precious');

  const result = await decide({ toolCall: { name: 'delete' }, args: { path: target } });
  assert.equal(result.block, true);
  assert.match(result.reason, /recycle/);
  assert.ok(!existsSync(target)); // moved, not deleted
  const op = opsLog(dir).at(-1);
  assert.equal(op.op, 'delete');
  assert.ok(existsSync(op.recycledTo));
  assert.equal(readFileSync(op.recycledTo, 'utf-8'), 'precious');
});

test('terminate-level denial hides the tool via surface.deny', async () => {
  const { denyCalls, decide } = rig({ kernelDecision: { block: true, terminate: true, reason: 'x' } });
  const result = await decide({ toolCall: { name: 'bash' }, args: { command: 'rm -rf /' } });
  assert.equal(result.terminate, true);
  assert.deepEqual(denyCalls, ['bash']);
});

test('plain block does NOT hide the tool', async () => {
  const { denyCalls, decide } = rig({ kernelDecision: { block: true, reason: 'nope' } });
  await decide({ toolCall: { name: 'bash' }, args: { command: 'ls' } });
  assert.deepEqual(denyCalls, []);
});

test('audit ledger carries FILEOP events for the real chain', async () => {
  const { dir, decide } = rig();
  const target = join(dir, 'a.txt');
  writeFileSync(target, 'v1');
  await decide({ toolCall: { name: 'edit' }, args: { path: target, oldText: 'v1', newText: 'v2' } });
  const ledger = readFileSync(
    join(dir, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf-8');
  assert.ok(ledger.includes('FILEOP_BACKUP'));
});

test('B4: context seam re-projects LIVE open predictions (not a snapshot)', async () => {
  const { PredictionStore } = await import('../../host/src/core/prediction.js');
  const { buildContextEnvelope } = await import('../../host/src/core/envelopes.js');
  const { contextEnvelopeExtension } = await import('../src/adapter/index.js');

  const dir = mkdtempSync(join(tmpdir(), 'pai-m8-ctx-'));
  const predictions = new PredictionStore(dir);
  const provider = () => buildContextEnvelope({
    briefing: 'you are the test body',
    openPredictions: predictions.openPredictions(),
  });
  const ext = contextEnvelopeExtension(provider);

  // register the 'context' handler like Pi's extension API does
  let contextHandler;
  ext.factory({ on: (name, fn) => { if (name === 'context') contextHandler = fn; } });

  // no predictions yet — briefing only
  let out = contextHandler({ messages: ['m0'] });
  assert.equal(out.messages.length, 2);
  assert.ok(!out.messages[1].content[0].text.includes('<open-predictions>'));

  // open a prediction — the NEXT context event must carry its claim text.
  // This is the post-compaction re-injection path: the provider is re-read
  // per turn, so whatever survived survives compaction.
  predictions.open({ claim: 'user prefers tabs over spaces', horizon: 'session' });
  out = contextHandler({ messages: ['m0', 'm1'] });
  const rendered = out.messages.at(-1).content[0].text;
  assert.ok(rendered.includes('<open-predictions>'));
  assert.ok(rendered.includes('user prefers tabs over spaces'));
  assert.ok(rendered.includes('horizon: session'));

  // close it — it must disappear from the live projection
  const p = predictions.openPredictions()[0];
  predictions.close(p.id, 'observed in settings', 'confirmed');
  out = contextHandler({ messages: ['m0', 'm1', 'm2'] });
  assert.ok(!out.messages.at(-1).content[0].text.includes('<open-predictions>'));
});
