/**
 * Compiled-artifact channels — REAL provider runs.
 *
 * Two artifacts, two axes, one pattern:
 *   briefing.md         <- current.yaml     what is BELIEVED  (state)     -> ContextEnvelope
 *   instruction/generated.md <- governance.yaml  how to OPERATE    (authority) -> InstructionEnvelope
 *
 * Both were broken, in the same way: something read a path nothing wrote.
 *   - briefing was read from <soul>/briefing/briefing.md; its declared compiler
 *     (soul/manifest.json) writes <canonical>/briefing.md.
 *   - the instruction channel was read from <canonical>/instruction/generated.md, which no producer
 *     created at all — so the model was never told the rules it is subject to,
 *     including `predict-before-change`, which the gate ENFORCES.
 *
 * Each test plants a token that can only come from the compiled artifact, asks
 * the model to report it, and reads ONLY the assistant's own text.
 *
 * Skipped unless PAI_WM_E2E=1 (same convention as acceptance.test.js).
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHost } from '../src/bootstrap/host.js';

const SKIP = process.env.PAI_WM_E2E !== '1';
const MODEL = process.env.PAI_WM_E2E_MODEL || 'gpt-5.6-luna-max';
const REPO = 'C:/Desktop/personal-ai';
const PYTHON = process.env.PAI_PYTHON || 'python';

/** The assistant's own text only — the user prompt must never count. */
function assistantText(dir) {
  const sessDir = join(dir, 'sessions');
  if (!existsSync(sessDir)) return '';
  const files = readdirSync(sessDir).filter((f) => f.endsWith('.jsonl')).sort().slice(-1);
  let out = '';
  for (const f of files) {
    for (const line of readFileSync(join(sessDir, f), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e?.message?.role !== 'assistant') continue;
      for (const p of (e.message.content ?? [])) if (p?.type === 'text') out += `${p.text}\n`;
    }
  }
  return out;
}

/** Instance with the repo's soul, a bootstrap canonical, and the cpa provider. */
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
    // dedup-h #1402 — self-hosted loopback endpoint: explicit egress opt-in
    allowPrivateNetwork: true,
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

test('briefing channel: the compiled briefing reaches the model', { skip: SKIP, timeout: 300_000 }, async () => {
  assert.ok(process.env.CPA_API_KEY, 'CPA_API_KEY is required');
  const TOKEN = 'ENT-BRIEFING-PROBE-7F3A';
  const inst = makeInstance('pai-brief-e2e-');

  const cur = readFileSync(join(inst.canonicalDir, 'current.yaml'), 'utf-8');
  writeFileSync(join(inst.canonicalDir, 'current.yaml'), `${cur}\nidentity:\n  entity_id: ${TOKEN}\n`);

  const compiled = spawnSync(PYTHON,
    [join(REPO, 'mind/canonical_compile.py'), '--canonical', inst.canonicalDir], { encoding: 'utf-8' });
  const briefingPath = join(inst.canonicalDir, 'briefing.md');
  assert.ok(existsSync(briefingPath),
    `compiler must emit <canonical>/briefing.md; stderr: ${(compiled.stderr || '').slice(-300)}`);
  assert.ok(readFileSync(briefingPath, 'utf-8').includes(TOKEN),
    'the compiled briefing must carry the entity token');

  const host = await start(inst);
  await host.session.prompt(
    'Your system context contains a <briefing>. Reply with ONLY the entity_id it states, verbatim. '
    + 'If you have no briefing, reply exactly NO_BRIEFING.');

  const text = assistantText(inst.dir);
  assert.ok(!text.includes('NO_BRIEFING'), `model reported no briefing; reply: ${text.slice(-200)}`);
  assert.ok(text.includes(TOKEN), `the briefing did not reach the model; reply: ${text.slice(-200)}`);
});

test('instruction channel: the compiled operating policy reaches the model', { skip: SKIP, timeout: 300_000 }, async () => {
  assert.ok(process.env.CPA_API_KEY, 'CPA_API_KEY is required');
  const TOKEN = 'AUTH-ROOT-POLICY-PROBE-4C19';
  const inst = makeInstance('pai-policy-e2e-');

  // Plant the token in the GOVERNANCE (the policy's source), then compile.
  const govPath = join(inst.canonicalDir, 'governance.yaml');
  const gov = readFileSync(govPath, 'utf-8');
  writeFileSync(govPath, gov.replace(/entity_root:.*$/m, `entity_root: ${TOKEN}`));

  const compiled = spawnSync(PYTHON,
    [join(REPO, 'mind/instruction_compile.py'), '--canonical', inst.canonicalDir], { encoding: 'utf-8' });
  const instrPath = join(inst.canonicalDir, 'instruction', 'generated.md');
  assert.ok(existsSync(instrPath),
    `compiler must emit <canonical>/instruction/generated.md; stderr: ${(compiled.stderr || '').slice(-300)}`);
  const policyText = readFileSync(instrPath, 'utf-8');
  assert.ok(policyText.includes(TOKEN), 'the compiled policy must carry the planted root authority');
  assert.ok(policyText.includes('predict-before-change'),
    'the compiled policy must state the revision rule the gate enforces');
  // The invariants had no other home the agent could reach: they lived only in
  // skills/world-model-runtime, and pi sets noSkills: true.
  assert.ok(policyText.includes('Invariants'),
    'the compiled policy must carry the invariants — the skill never reaches pi');

  const host = await start(inst);
  await host.session.prompt(
    'Your operating policy states who holds entity_root authority. Reply with ONLY that value, '
    + 'verbatim, nothing else. If you have no operating policy, reply exactly NO_POLICY.');

  const text = assistantText(inst.dir);
  assert.ok(!text.includes('NO_POLICY'), `model reported no policy; reply: ${text.slice(-200)}`);
  assert.ok(text.includes(TOKEN), `the policy did not reach the model; reply: ${text.slice(-200)}`);
});
