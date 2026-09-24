/**
 * dedup-h #1858 — hooks.toml before_tool/after_tool analogue:
 *
 *  - pre_tool gate answering {"args":{…}} rewrites the tool input: the
 *    shared validatedArgs mutates IN PLACE (that object is what the loop
 *    executes), then the whole decide chain RE-ENTERS so the rewritten call
 *    faces every deterministic gate — kernel, deny prefixes, boundaries.
 *    Bounded to one rewrite; a second {args} answer denies closed.
 *  - post_tool gate on the tool_result seam: {"append":"…"} appends text to
 *    the model-facing result; {"deny"}/failures suppress it (fail-closed).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeDecide } from '../src/bootstrap/decide.js';
import { postToolHookExtension } from '../src/adapter/index.js';
import { FileOpsGuard } from '../src/adapter/fileops.js';
import { AuditWriter } from '../../host/src/core/audit.js';

function rig({ gate, kernelArgs = null, denyPrefixes = [], asks = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pai-hr-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  const audit = new AuditWriter({ auditDir: join(dir, 'audit') });
  if (denyPrefixes.length) {
    mkdirSync(join(dir, '.pai'), { recursive: true });
    writeFileSync(join(dir, '.pai', 'commands.json'), JSON.stringify({ denyPrefixes }));
  }
  const fileOps = new FileOpsGuard(dir);
  const seen = kernelArgs ?? [];
  const core = {
    audit,
    kernel: { decideToolCall: async (c) => { seen.push({ ...c.args }); return null; } },
  };
  const decide = makeDecide({
    core, executor: null, fileOps, getSurface: () => null,
    workdir: dir, asks, preToolGate: gate ?? null,
  });
  return { dir, decide, seen, audit };
}

const bashCtx = (command, id = 't1') => ({
  toolCall: { name: 'bash', id },
  args: { command },
  assistantMessage: null, context: null,
});

test('#1858 {args} rewrite mutates the shared arg object in place and admits', async () => {
  // rewrite fires once — an idempotent hook answers {args} only on the
  // original input, mirroring real rewrite hooks
  const gate = { fireGate: async (ev, p) => (p.args?.command === 'rm -rf /' ? { args: { command: 'echo hi' } } : null) };
  const { decide, seen } = rig({ gate });
  const ctx = bashCtx('rm -rf /');
  const argsRef = ctx.args;
  const r = await decide(ctx);
  assert.equal(r, undefined, 'rewritten call admits through the full chain');
  assert.equal(ctx.args, argsRef, 'mutation is in place — the executed object');
  assert.deepEqual(ctx.args, { command: 'echo hi' });
  assert.deepEqual(seen[0], { command: 'rm -rf /' }, 'kernel first sees the original args');
  assert.deepEqual(seen.at(-1), { command: 'echo hi' }, 'kernel re-runs on the rewritten args');
});

test('#1858 rewritten args re-run deterministic gates — deny prefix still blocks', async () => {
  const gate = { fireGate: async (ev, p) => (p.args?.command === 'echo safe' ? { args: { command: 'forbidden-cmd --flag' } } : null) };
  const { decide } = rig({ gate, denyPrefixes: ['forbidden-cmd'] });
  const r = await decide(bashCtx('echo safe'));
  assert.equal(r?.block, true);
  assert.equal(r.rule, 'command_denylist', 'rewritten command faces the deny-prefix gate');
});

test('#1858 a second {args} answer denies closed (rewrite bound = 1)', async () => {
  const gate = { fireGate: async () => ({ args: { command: 'echo again' } }) };
  const { decide, seen } = rig({ gate });
  // gate rewrites on EVERY pass — pass 1 must refuse, not loop
  const r = await decide(bashCtx('echo once'));
  assert.equal(r?.block, true);
  assert.equal(r.rule, 'pre_tool_hook');
  assert.match(r.reason, /rewrote args twice/);
  assert.equal(seen.length, 2, 'kernel ran on original + rewritten args');
});

test('#1858 deny/requireApproval veto unchanged alongside rewrite support', async () => {
  const gate = { fireGate: async () => ({ deny: 'nope' }) };
  const { decide } = rig({ gate });
  const r = await decide(bashCtx('echo hi'));
  assert.equal(r?.block, true);
  assert.equal(r.rule, 'pre_tool_hook');
  assert.match(r.reason, /refused: nope/);
});

test('#1858 post_tool extension appends hook context to the model-facing result', async () => {
  const gate = { fireGate: async (ev, payload) => {
    assert.equal(ev, 'post_tool');
    assert.equal(payload.tool, 'read');
    assert.equal(payload.output, 'file body');
    return { append: ['operator note: file is generated'] };
  } };
  const handlers = {};
  const fakePi = { on: (ev, fn) => { handlers[ev] = fn; } };
  postToolHookExtension(() => gate).factory(fakePi);
  const out = await handlers.tool_result({
    toolName: 'read', toolCallId: 't9', input: { path: 'x' },
    content: [{ type: 'text', text: 'file body' }], isError: false,
  });
  assert.deepEqual(out.content, [
    { type: 'text', text: 'file body' },
    { type: 'text', text: 'operator note: file is generated' },
  ]);
});

test('#1858 post_tool deny suppresses the output; absent gate passes through', async () => {
  const denyGate = { fireGate: async () => ({ deny: 'leaked secret' }) };
  const h1 = {};
  postToolHookExtension(() => denyGate).factory({ on: (ev, fn) => { h1[ev] = fn; } });
  const out = await h1.tool_result({
    toolName: 'read', toolCallId: 't1', input: {},
    content: [{ type: 'text', text: 'secret body' }], isError: false,
  });
  assert.equal(out.content.length, 1);
  assert.match(out.content[0].text, /refused this tool result: leaked secret/);
  // no gate configured → passthrough (undefined = no modification)
  const h2 = {};
  postToolHookExtension(() => null).factory({ on: (ev, fn) => { h2[ev] = fn; } });
  const pass = await h2.tool_result({ toolName: 'read', content: [{ type: 'text', text: 'x' }] });
  assert.equal(pass, undefined);
});

test('#2004 external_verify re-fires the gate with the flag; the verdict binds', async () => {
  const calls = [];
  const gate = {
    fireGate: async (ev, p) => {
      calls.push(p);
      return p.externalVerification
        ? { deny: 'out-of-band check refused' }
        : { requireApproval: 'deploy?', externalVerify: { label: 'hardware key' } };
    },
  };
  const pendings = [];
  const asks = { ask: async (d) => { pendings.push(d); return 'external_verify'; } };
  const { decide } = rig({ gate, asks });
  const r = await decide(bashCtx('deploy'));
  assert.equal(r?.block, true, 'external verification refusal blocks');
  assert.match(r.reason, /out-of-band check refused/);
  assert.equal(calls.length, 2, 'gate fired twice: escalate, then verify');
  assert.equal(calls[1].externalVerification, true, 'second fire carries the flag');
  assert.deepEqual(pendings[0].externalVerify, { label: 'hardware key' }, 'choice rides the pending descriptor');
});

test('#2004 external_verify + silent second answer admits; chained escalation denies', async () => {
  // hook verifies externally and stays silent — verification passed
  const gateOk = {
    fireGate: async (ev, p) => p.externalVerification ? null
      : { requireApproval: 'deploy?', externalVerify: { label: 'x' } },
  };
  const asks = { ask: async () => 'external_verify' };
  const ok = await rig({ gate: gateOk, asks }).decide(bashCtx('deploy'));
  assert.equal(ok, undefined, 'external verification pass admits through the chain');

  // hook tries to chain a second ask instead of returning a verdict — closed
  const gateLoop = {
    fireGate: async (ev, p) => p.externalVerification
      ? { requireApproval: 'again?' }
      : { requireApproval: 'deploy?', externalVerify: { label: 'x' } },
  };
  const blocked = await rig({ gate: gateLoop, asks }).decide(bashCtx('deploy'));
  assert.equal(blocked?.block, true, 'a second requireApproval denies closed');
  assert.match(blocked.reason, /cannot re-escalate/);
});
