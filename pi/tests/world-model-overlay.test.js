/**
 * The overlay must be dropped WHOLESALE when it is stale — never partially
 * applied. Freshness is the one boundary that is machine-enforced at run time
 * (scope_conditions are declarative prose, reviewed at compile time), so it is
 * the one that most needs a test.
 *
 * Same mtime discipline as the doctor's compiled_artifacts check: an artifact
 * that is not newer than the source it was compiled from is stale.
 */
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/adapter/world-model.js';

const OVERLAY = {
  schema_version: 1,
  canonical_watermark: 'w',
  relaxations: [{
    model_id: 'M-x', match: { tool: 'bash', command_head: 'ls' }, class: 'reversible',
    scope_conditions: ['headless session'], evidence_refs: ['e2 run'],
  }],
};

/** @param {{overlayAgeSec?: number}} cfg overlayAgeSec > 0 ⇒ overlay older than the source */
function rig({ overlayAgeSec = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pai-wm-overlay-'));
  const canonicalDir = join(dir, 'canonical');
  mkdirSync(canonicalDir, { recursive: true });
  writeFileSync(join(canonicalDir, 'current.yaml'), 'world_model:\n  models: {}\n');
  if (overlayAgeSec != null) {
    writeFileSync(join(canonicalDir, 'reversibility.json'), JSON.stringify(OVERLAY));
    const past = new Date(Date.now() - overlayAgeSec * 1000);
    utimesSync(join(canonicalDir, 'reversibility.json'), past, past);
  }
  let guard = null;
  let tool = null;
  apply({
    on: () => {}, get: () => null,
    tools: { register: (t) => { tool = t; }, guard: (fn) => { guard = fn; } },
  }, { stateDir: join(dir, 'state'), canonicalDir, mode: 'core', bodyId: 'test' });
  const exec = { agent: { session: { id: 's1' } } };
  const denial = (t, args) => guard({ name: t, arguments: args, agent: { session: { id: 's1' } } });
  /** A prediction WITHOUT the irreversible flag — the thing the overlay should make sufficient. */
  const predictUnflagged = () => tool.execute(
    { op: 'predict', subject: 'listing the dir', intended_action: 'bash ls' }, exec);
  return { denial, predictUnflagged };
}

test('a FRESH overlay lets an UNFLAGGED prediction cover the relaxed command only', async () => {
  const { denial, predictUnflagged } = rig({ overlayAgeSec: -60 });  // overlay newer than source
  await predictUnflagged();
  // Relaxed: the same unflagged prediction is now sufficient for `ls`.
  assert.equal(denial('bash', { command: 'ls -la' }), undefined,
    'a fresh overlay drops the irreversible verdict, so no flag is required');
  // Not relaxed: a different command head still demands the flag.
  assert.match(String(denial('bash', { command: 'rm -rf /tmp/x' }) || ''), /BLOCKED/,
    'rm is a different command head and must still demand irreversible:true');
});

test('a STALE overlay is ignored wholesale — the unflagged prediction is not enough', async () => {
  const { denial, predictUnflagged } = rig({ overlayAgeSec: 600 });  // overlay older than source
  await predictUnflagged();
  assert.match(String(denial('bash', { command: 'ls -la' }) || ''), /BLOCKED/,
    'a stale overlay must not relax anything — the prior stands');
});

test('no overlay at all ⇒ behaviour is exactly the prior', async () => {
  const { denial, predictUnflagged } = rig({});
  await predictUnflagged();
  assert.match(String(denial('bash', { command: 'ls -la' }) || ''), /BLOCKED/);
  assert.match(String(denial('bash', { command: 'rm -rf /tmp/x' }) || ''), /BLOCKED/);
  assert.equal(denial('read', { path: 'x' }), undefined, 'reads were never gated');
});
