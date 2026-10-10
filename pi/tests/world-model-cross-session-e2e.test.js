/**
 * Cross-session probe: the discriminating case for "is it in effect".
 *
 * The first probe (ordinary task) could not answer the question: D1 requires the
 * loop to turn only for 重要应用/检验任务, and adds 普通问题不要求完整闭环. So an
 * ordinary task behaving inertly is CORRECT, and proves nothing either way.
 *
 * What the gate criteria actually name as externalized-state demand — the reason
 * to be in CORE at all — is: 跨阶段/跨会话继续 · 恢复 open prediction · 持续
 * competing models · mutation 去重/绑定 · 长期 provenance. This probe uses the
 * first two, and it is the shape the H5 batch validated (跨会话测量 / 跨会话 mutation).
 *
 * Session 1 leaves a prediction that CANNOT be settled in the same session — the
 * fact it predicts is about the world as it will be found LATER. Session 2 is a
 * different host process on the same instance. Whether the open prediction is
 * carried, and whether session 2 closes it, is the measurement.
 *
 * Skipped unless PAI_WM_E2E=1.
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

/** The assistant's own words — never the user prompt. */
function assistantText(dir) {
  const sessDir = join(dir, 'sessions');
  if (!existsSync(sessDir)) return '';
  let out = '';
  for (const f of readdirSync(sessDir).filter((n) => n.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(sessDir, f), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e?.message?.role !== 'assistant') continue;
      for (const p of (e.message.content ?? [])) if (p?.type === 'text') out += `${p.text}\n`;
    }
  }
  return out;
}

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
    baseUrl: 'http://127.0.0.1:8317/v1', api: 'openai-completions', apiKey: '$CPA_API_KEY', allowPrivateNetwork: true,
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

/** One host process = one session. Disposed before the next starts. */
async function runSession(instance, prompt) {
  const host = await start(instance);
  try {
    await host.session.prompt(prompt);
  } finally {
    host.dispose();
  }
}

const S1 = 'Do this and nothing else. Step 1: write a file named wm-state.txt containing exactly '
  + 'the number 41. Step 2: register a prediction that a LATER session will still find that file '
  + 'with exactly that content, and leave it open — do not evaluate it now, because the thing it '
  + 'predicts is about the world as it will be found later, not about right now. Then reply DONE.';

const S2 = 'A previous session left something for you to check. Find out what it was, verify '
  + 'whether it still holds, and settle it — if a prediction from that session is still open, '
  + 'evaluate it against what you actually find. Then report, in one line, the value you found '
  + 'and whether the earlier prediction held.';

test('CROSS-SESSION, armed: does an open prediction survive the session boundary?',
  { skip: SKIP, timeout: 420_000 }, async () => {
    process.env.PAI_WORLD_MODEL_MODE = 'core';
    const inst = makeInstance('pai-wm-xsession-');
    try {
      await runSession(inst, S1);
      const after1 = ledgerEvents(inst.dir);
      const k1 = after1.map((e) => e.event_type);

      await runSession(inst, S2);
      const after2 = ledgerEvents(inst.dir);
      const k2 = after2.map((e) => e.event_type);
      const text2 = assistantText(inst.dir);

      console.log(`[world-model] session1 events: ${JSON.stringify(k1)}`);
      console.log(`[world-model] session2 events: ${JSON.stringify(k2)}`);
      console.log(`[world-model] session2 said: ${text2.replace(/\s+/g, ' ').slice(-300)}`);

      // MECHANICAL, and therefore assertable: the world survived the boundary.
      assert.ok(existsSync(join(inst.dir, 'wm-state.txt')),
        `session 1 did not complete: no wm-state.txt. events=${JSON.stringify(k1)}`);
      assert.equal(readFileSync(join(inst.dir, 'wm-state.txt'), 'utf-8').trim(), '41');

      // MECHANICAL: session 1 opened a prediction. If it did not, the rest of this
      // probe has nothing to measure and the finding is about session 1, not session 2.
      const opened = k1.includes('PREDICTION_CREATED');
      const carried = k2.includes('PREDICTION_CREATED') || k2.includes('PREDICTION_EVALUATED')
        || k2.includes('OBSERVATION_RECORDED');
      console.log(`[world-model] opened_in_s1=${opened} s2_continued=${carried} `
        + `s2_found_value=${text2.includes('41')}`);

      assert.ok(opened,
        `session 1 never opened a prediction, so this probe measured nothing. events=${JSON.stringify(k1)}`);

      // WHAT D1 ACTUALLY REQUIRES, and therefore what may be asserted. D1's chain is
      // State → Model → Prediction → Action → Observation → Update, and it says twice
      // that there is no separate evaluation stage: Prediction Error is 诊断量…不是与
      // Observation 并列的现实步骤, and Revision 是更新机制（非独立环节）. So the
      // requirement this probe may enforce is that the loop reaches OBSERVATION —
      // evidence — not that it performs a step the theory does not define.
      assert.ok(k2.includes('OBSERVATION_RECORDED'),
        `the loop never reached Observation, so no comparison is derivable. events=${JSON.stringify(k2)}`);

      // REPORTED, not asserted: whether the entity takes the Update step. That is
      // behaviour, and with `update` now requiring evidence (an observation) rather
      // than a separate evaluation, the mechanism no longer stands in its way.
      const updated = k2.includes('MODEL_UPDATED');
      console.log(`[world-model] reached_observation=${k2.includes('OBSERVATION_RECORDED')} `
        + `took_update=${updated} evaluated_explicitly=${k2.includes('PREDICTION_EVALUATED')}`);
    } finally {
      delete process.env.PAI_WORLD_MODEL_MODE;
    }
  });

test('CROSS-SESSION, default mode: does the entity raise the depth for a task that needs it?',
  { skip: SKIP, timeout: 420_000 }, async () => {
    delete process.env.PAI_WORLD_MODEL_MODE;   // the shipping default
    const inst = makeInstance('pai-wm-xsession-off-');
    await runSession(inst, S1);
    await runSession(inst, S2);

    const evs = ledgerEvents(inst.dir);
    const ks = evs.map((e) => e.event_type);
    const text = assistantText(inst.dir);
    console.log(`[world-model] default cross-session: events=${JSON.stringify(ks)} `
      + `found_value=${text.includes('41')}`);

    // The task must still complete with the world model inert. If turning it off
    // breaks ordinary work, that is worse than not having it — this IS asserted.
    assert.ok(existsSync(join(inst.dir, 'wm-state.txt')),
      `the task did not complete with the world model off — a defect. events=${JSON.stringify(ks)}`);
  });
