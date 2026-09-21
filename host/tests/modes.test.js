/**
 * ModePresets — Policy Preset Overlay. Presets load from instance + project
 * modes.json, compile to a kernel overlay, and can ONLY tighten decisions.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { instancePaths } from '../src/core/instance.js';
import { AuditWriter } from '../src/core/audit.js';
import { AttestedPolicy } from '../src/core/policy.js';
import { PredictionStore } from '../src/core/prediction.js';
import { GovernanceKernel } from '../src/core/governance.js';
import { ModePresets } from '../src/core/modes.js';

function fixture(policyDoc = {}, presets = null) {
  const dir = mkdtempSync(join(tmpdir(), 'pai-modes-'));
  const canonicalDir = join(dir, 'canonical');
  mkdirSync(canonicalDir, { recursive: true });
  writeFileSync(join(canonicalDir, 'policy.json'), JSON.stringify({
    version: 1, deny: [],
    tools: {}, riskActions: {}, ...policyDoc,
  }));
  const workdir = join(dir, 'work');
  mkdirSync(join(workdir, '.pai'), { recursive: true });
  if (presets) {
    writeFileSync(join(workdir, '.pai', 'modes.json'), JSON.stringify({ modes: presets }));
  }
  const paths = instancePaths(dir);
  return {
    dir, workdir, canonicalDir,
    audit: new AuditWriter(paths),
    policy: new AttestedPolicy(canonicalDir),
    predictions: new PredictionStore(canonicalDir),
  };
}

const ctx = (over = {}) => ({
  toolName: 'read', toolCallId: 'tc-1', args: { path: 'src/a.txt' }, ...over,
});

test('presets load from .pai/modes.json and compile', () => {
  const { dir, workdir } = fixture({}, [
    { name: 'review', description: 'read-only audit', toolDeny: ['write', 'edit'], toolAsk: ['bash'], hideTools: ['deploy'] },
  ]);
  const mp = new ModePresets({ instanceRoot: dir, workdir });
  assert.equal(mp.list()[0].name, 'review');
  const o = mp.compile('review');
  assert.equal(o.toolActions.write, 'deny');
  assert.equal(o.toolActions.bash, 'ask');
  assert.deepEqual(o.hideTools, ['deploy']);
  assert.ok(o.hash);
  assert.equal(mp.compile('nope'), null); // unknown → fail closed
});

test('malformed preset fails loading loudly, not silently', () => {
  const { dir, workdir } = fixture({}, [{ name: 'bad', toolDeny: 'write' }]);
  assert.throws(() => new ModePresets({ instanceRoot: dir, workdir }), /toolDeny must be an array/);
});

test('overlay denies/asks tools the canonical policy allows', async () => {
  const { audit, policy, predictions, dir, workdir } = fixture({}, [
    { name: 'review', toolDeny: ['write'], toolAsk: ['mcp__*'] },
  ]);
  const mp = new ModePresets({ instanceRoot: dir, workdir });
  const asked = [];
  const kernel = new GovernanceKernel({
    audit, policy, predictions, modeOverlay: () => mp.compile('review'),
    ask: (pending) => { asked.push(pending); return Promise.resolve('deny'); },
  });
  const denied = await kernel.decideToolCall(ctx({ toolName: 'write' }));
  assert.equal(denied.block, true);
  assert.equal(denied.rule, 'mode_overlay');
  const d = await kernel.decideToolCall(ctx({ toolName: 'mcp__x__y' }));
  assert.equal(d.block, true); // operator said no
  assert.equal(asked[0].rule, 'mode_overlay'); // ask card carries the mode reason
  assert.equal(await kernel.decideToolCall(ctx({ toolName: 'read' })), undefined);
});

test('overlay can NEVER weaken a canonical deny', async () => {
  const { audit, policy, predictions, dir, workdir } = fixture(
    { tools: { dangerous: { action: 'deny' } } },
    [{ name: 'loose', toolAllow: ['dangerous'] }],
  );
  const mp = new ModePresets({ instanceRoot: dir, workdir });
  const kernel = new GovernanceKernel({
    audit, policy, predictions, modeOverlay: () => mp.compile('loose'),
  });
  const d = await kernel.decideToolCall(ctx({ toolName: 'dangerous' }));
  assert.equal(d.block, true);
  assert.equal(d.rule, 'tool_denied'); // canonical rule fired first — overlay never saw it
});

test('strict defaultAction asks everything except toolAllow', async () => {
  const { audit, policy, predictions, dir, workdir } = fixture({}, [
    { name: 'readonly', defaultAction: 'ask', toolAllow: ['read', 'ls'] },
  ]);
  const mp = new ModePresets({ instanceRoot: dir, workdir });
  const kernel = new GovernanceKernel({
    audit, policy, predictions, modeOverlay: () => mp.compile('readonly'),
    ask: () => Promise.resolve('allow'), // operator approves → resolves to allow
  });
  assert.equal(await kernel.decideToolCall(ctx({ toolName: 'read' })), undefined);
  assert.equal(await kernel.decideToolCall(ctx({ toolName: 'write' })), undefined);
});

test('pathDeny matches path-like args via glob', async () => {
  const { audit, policy, predictions, dir, workdir } = fixture({}, [
    { name: 'safe', pathDeny: ['secrets/**'] },
  ]);
  const mp = new ModePresets({ instanceRoot: dir, workdir });
  const kernel = new GovernanceKernel({
    audit, policy, predictions, modeOverlay: () => mp.compile('safe'),
  });
  const d = await kernel.decideToolCall(ctx({ args: { path: 'secrets/key.pem' } }));
  assert.equal(d.block, true);
  assert.equal(d.rule, 'mode_overlay');
  assert.equal(await kernel.decideToolCall(ctx({ args: { path: 'src/ok.txt' } })), undefined);
});
