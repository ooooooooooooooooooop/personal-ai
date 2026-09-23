import test from 'node:test';
import assert from 'node:assert/strict';
import { isIrreversibleByDefault, isIrreversibleArgs, overlayRelaxes }
  from '../src/core/irreversible.js';

/**
 * The learned overlay (finding G11): models the canonical learned about
 * tool/command behaviour, compiled into a form the gate can read.
 *
 * These pin the ASYMMETRY that makes it safe. The overlay may only RELAX a
 * verdict the built-in prior already reached; it can never tighten, never
 * touch a call the prior considers safe, and there is no way to disable the
 * prior wholesale. Without that asymmetry it would be a backdoor, not learning.
 */
const OVERLAY = {
  schema_version: 1,
  canonical_watermark: 'x',
  relaxations: [
    { model_id: 'M-x', match: { tool: 'bash', command_head: 'ls' }, class: 'reversible',
      scope_conditions: ['headless session'], evidence_refs: ['e2 run'] },
  ],
};

test('the prior is untouched: an overlay cannot make a safe call unsafe', () => {
  // `read` is not consequential at all — the overlay has no purchase here.
  assert.equal(isIrreversibleByDefault('read'), false);
  assert.equal(overlayRelaxes(OVERLAY, 'read', [{ path: 'x' }]), false);
});

test('the prior is untouched: an overlay cannot tighten an unrelated tool', () => {
  assert.equal(overlayRelaxes(OVERLAY, 'write', [{ path: 'x' }]), false);
  assert.equal(isIrreversibleByDefault('write'), false, 'write stays a reversible edit');
});

test('a matching relaxation drops the prior verdict for that command head', () => {
  assert.equal(isIrreversibleByDefault('bash'), true, 'the prior says irreversible');
  assert.equal(overlayRelaxes(OVERLAY, 'bash', [{ command: 'ls -la' }]), true);
});

test('a DIFFERENT command head under the same tool is NOT relaxed', () => {
  // This is the whole point: relaxing `ls` must not relax `rm`.
  assert.equal(overlayRelaxes(OVERLAY, 'bash', [{ command: 'rm -rf /tmp/x' }]), false);
  assert.equal(isIrreversibleArgs([{ command: 'rm -rf /tmp/x' }]), true,
    'and the prior still catches it');
});

test('a relaxation with no command_head matches the whole tool', () => {
  const broad = { relaxations: [{ model_id: 'M-x', match: { tool: 'bash' }, class: 'reversible',
    scope_conditions: ['x'], evidence_refs: ['y'] }] };
  assert.equal(overlayRelaxes(broad, 'bash', [{ command: 'anything at all' }]), true);
});

test('only `reversible` entries are honoured — a tightening is ignored', () => {
  const tighten = { relaxations: [{ model_id: 'M-x', match: { tool: 'bash' },
    class: 'consequential', scope_conditions: ['x'], evidence_refs: ['y'] }] };
  assert.equal(overlayRelaxes(tighten, 'bash', [{ command: 'ls' }]), false,
    'the overlay cannot tighten; that is the prior\'s job');
});

test('an absent, empty or malformed overlay relaxes nothing', () => {
  for (const o of [null, undefined, {}, { relaxations: null }, { relaxations: [] }]) {
    assert.equal(overlayRelaxes(o, 'bash', [{ command: 'ls' }]), false);
  }
});

test('the tool name is normalised the same way the prior normalises it', () => {
  const o = { relaxations: [{ model_id: 'M-x', match: { tool: 'Bash' }, class: 'reversible',
    scope_conditions: ['x'], evidence_refs: ['y'] }] };
  assert.equal(overlayRelaxes(o, 'bash', [{ command: 'ls' }]), true);
});
