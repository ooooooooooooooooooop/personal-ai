/**
 * Is the world model IN EFFECT — in a real session, not in a unit test?
 *
 * Everything else in this suite drives the guard or the shim directly, which
 * proves the MECHANISM exists. It does not prove the mechanism RUNS. The
 * world-model theory names this exact failure (§十二): 「试点通道内演示」≠
 * 「实体日常任务在跑」 — and the BCC-1 test file says it plainly about an earlier
 * state of this code: "an extension that never attaches, or a tool that never
 * registers, is the same as no adapter at all (which is exactly how this loop
 * stayed dark before)".
 *
 * So this asks the question with a real provider and a real session: does the
 * loop TURN? The observable is the ledger — it is written mechanically, whether
 * or not the model cooperates, so it cannot be faked by a helpful answer.
 *
 * Two axes, because "in effect" has two meanings:
 *   A. armed (PAI_WORLD_MODEL_MODE=core) — the gate is on; a consequential change
 *      CANNOT happen without a prediction, so the loop must turn.
 *   B. default (mode=off) — nothing forces it. Does the entity raise it on its
 *      own when the task calls for externalized state? This is the coverage
 *      question, and "no" is a legitimate finding, not a test failure.
 *
 * Skipped unless PAI_WM_E2E=1 (same convention as the other live tests).
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHost } from '../src/bootstrap/host.js';

const SKIP = process.env.PAI_WM_E2E !== '1';
const MODEL = process.env.PAI_WM_E2E_MODEL || 'gpt-5.6-luna-max';
const REPO = 'C:/Desktop/personal-ai';

/** Every event the world-model ledger holds for this instance. */
function ledgerEvents(dir) {
  const led = join(dir, 'world-model', 'ledger');
  if (!existsSync(led)) return [];
  const out = [];
  for (const f of readdirSync(led).filter((n) => n.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(led, f), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* torn tail row */ }
    }
  }
  return out;
}

const kinds = (evs) => evs.map((e) => e.event_type);

function makeInstance(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const canonicalDir = join(dir, 'canonical');
  mkdirSync(canonicalDir, { recursive: true });
  cpSync(join(REPO, 'soul/bootstrap/canonical'), canonicalDir, { recursive: true, force: true });
  cpSync(join(REPO, 'soul'), join(dir, 'soul'), { recursive: true, force: true });
  writeFileSync(join(canonicalDir, 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: { destructive: 'deny', privilege: 'deny' } }));
  const agentDir = join(dir, 'pi-agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { cpa: {
    baseUrl: 'http://127.0.0.1:8317/v1', api: 'openai-completions', apiKey: '$CPA_API_KEY',
    models: [{ id: MODEL, name: MODEL, reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1050000, maxTokens: 8192 }] } } }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return { dir, canonicalDir, agentDir };
}

function start(instance) {
  return startHost({ instanceRoot: instance.dir, workdir: instance.dir, sessionOptions: {
    agentDir: instance.agentDir,
    model: { id: MODEL, name: MODEL, api: 'openai-completions', provider: 'cpa',
      baseUrl: 'http://127.0.0.1:8317/v1', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1050000, maxTokens: 8192 } } });
}

/** A task whose completion REQUIRES a consequential change to the world. */
const TASK = 'Create a file named wm-probe.txt in the working directory containing exactly '
  + 'the text: probe-ok. Then reply with the single word DONE.';

test('ARMED: with the gate on, a real session turns the loop — the ledger proves it',
  { skip: SKIP, timeout: 300_000 }, async () => {
    process.env.PAI_WORLD_MODEL_MODE = 'core';
    const inst = makeInstance('pai-wm-armed-');
    const host = await start(inst);
    try {
      await host.session.prompt(TASK);
    } finally {
      host.dispose();
      delete process.env.PAI_WORLD_MODEL_MODE;
    }

    const evs = ledgerEvents(inst.dir);
    const ks = kinds(evs);

    // The ledger is written mechanically — this is not the model reporting on
    // itself. If the gate is armed and the task needs a change, a prediction
    // must exist, or the change could not have happened.
    assert.ok(ks.includes('PREDICTION_CREATED'),
      `the loop did not turn: no PREDICTION_CREATED. events=${JSON.stringify(ks)}`);
    assert.ok(existsSync(join(inst.dir, 'wm-probe.txt')),
      `the task did not complete — nothing to explain. events=${JSON.stringify(ks)}`);
    // NOTE ON SCOPE, because it decides what may be asserted here. D1 requires the
    // loop to be TURNING for 重要应用/检验任务 — and adds, in the same breath,
    // 普通问题不要求完整闭环（过度套用即形式主义）. This task is an ordinary one, so
    // the closure is NOT required and its absence is NOT a defect. What IS required,
    // and what §九 lists as a mechanism guarantee, is the entry: 检验预测先于结果
    // 的硬门禁. That is what is asserted. The closure is reported, not demanded.
    // Reported, not asserted: for an ordinary task D1 explicitly does not require
    // the full loop, and demanding it here would be the over-application D1 names.
    const closed = ks.includes('OBSERVATION_RECORDED') || ks.includes('PREDICTION_EVALUATED');
    console.log(`[world-model] armed, ordinary task: predicted=true closed=${closed} events=${JSON.stringify(ks)}`);
  });

test('DEFAULT: mode off — does the entity raise it on its own?',
  { skip: SKIP, timeout: 300_000 }, async () => {
    delete process.env.PAI_WORLD_MODEL_MODE;   // the shipping default
    const inst = makeInstance('pai-wm-default-');
    const host = await start(inst);
    try {
      await host.session.prompt(TASK);
    } finally {
      host.dispose();
    }

    const evs = ledgerEvents(inst.dir);
    const ks = kinds(evs);
    const activated = ks.includes('WM_ACTIVATE');
    const predicted = ks.includes('PREDICTION_CREATED');

    // This test ASSERTS NOTHING about whether the entity raised the mode: "no"
    // is a finding about coverage, not a defect in the mechanism. It reports,
    // loudly, because a loop that only turns when someone arms it by hand is
    // the 覆盖率错配 the theory warns about.
    console.log(`[world-model] default-mode session: task_done=${
      existsSync(join(inst.dir, 'wm-probe.txt'))} activated=${activated} predicted=${predicted}`);
    console.log(`[world-model] ledger events: ${JSON.stringify(ks)}`);

    // The one thing that IS a defect: the task must still complete. If turning
    // the world model off breaks ordinary work, that is worse than not having it.
    assert.ok(existsSync(join(inst.dir, 'wm-probe.txt')),
      `the task did not complete with the world model off — that is a defect, not a finding. events=${JSON.stringify(ks)}`);
  });
