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

/**
 * Why a compiler run did not produce its artifact, in one line.
 *
 * The old message showed `stderr` only, which is empty in the two cases that
 * actually happen: the process could not be spawned at all (sandbox denies child
 * processes — `spawnSync ... EBUSY`, `status: null`, reason in `.error`), or the
 * interpreter is fine but the compiler refuses (which it writes to stderr, so at
 * least that shows). Reporting `error`/`status`/`stdout` too turns "stderr: "
 * into something you can act on.
 */
function describeCompilerRun(py, args, r) {
  const bits = [`cmd: ${py} ${args.join(' ')}`];
  if (r.error) bits.push(`SPAWN FAILED: ${r.error.message} (the compiler never ran)`);
  bits.push(`status: ${r.status}`);
  if (r.stdout && r.stdout.trim()) bits.push(`stdout: ${r.stdout.trim().slice(-300)}`);
  if (r.stderr && r.stderr.trim()) bits.push(`stderr: ${r.stderr.trim().slice(-300)}`);
  return bits.join(' | ');
}

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

  // Rewrite the EXISTING `identity.entity_id` in place.
  //
  // This used to append a second top-level `identity:` block and rely on the later
  // one winning. It does not win: duplicate keys are undefined behaviour in YAML and
  // this repo's loader (PyYAML, same call the compiler makes) keeps the FIRST value,
  // so the briefing legitimately rendered REPLACE_ME and the assertion could never
  // pass. The test was probing the fixture, not the compiler.
  const curPath = join(inst.canonicalDir, 'current.yaml');
  const cur = readFileSync(curPath, 'utf-8');
  assert.match(cur, /^\s*entity_id:/m, 'fixture needs an entity_id line to rewrite');
  writeFileSync(curPath, cur.replace(/^(\s*)entity_id:.*$/m, `$1entity_id: ${TOKEN}`));

  const briefArgs = [join(REPO, 'mind/canonical_compile.py'), '--canonical', inst.canonicalDir];
  const compiled = spawnSync(PYTHON, briefArgs, { encoding: 'utf-8' });
  const briefingPath = join(inst.canonicalDir, 'briefing.md');
  assert.ok(existsSync(briefingPath),
    `compiler must emit <canonical>/briefing.md | ${describeCompilerRun(PYTHON, briefArgs, compiled)}`);
  assert.ok(readFileSync(briefingPath, 'utf-8').includes(TOKEN),
    'the compiled briefing must carry the entity token');

  const host = await start(inst);
  // Ask for the FACT, not for a tag. `renderContext` injects the briefing RAW —
  // ambient/steering/budget/pinned-files/memory/open-predictions all get a
  // `<...>` wrapper, the briefing does not. The prompt used to say "your system
  // context contains a <briefing>", presupposing a marker that does not exist, so
  // the assertion only held when the model inferred what was meant; answering
  // NO_BRIEFING was equally correct and the test failed for the wrong reason.
  await host.session.prompt(
    'Do not call any tool. Somewhere in your context is a line beginning with "entity:" (it also '
    + 'carries theory / schema / lineage_head). Reply with ONLY that line, verbatim. '
    + 'If no such line exists in your context, reply exactly NO_BRIEFING.');

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
  assert.match(gov, /^\s*entity_root:/m, 'fixture needs an entity_root line to rewrite');
  writeFileSync(govPath, gov.replace(/^(\s*)entity_root:.*$/m, `$1entity_root: ${TOKEN}`));

  const instrArgs = [join(REPO, 'mind/instruction_compile.py'), '--canonical', inst.canonicalDir];
  const compiled = spawnSync(PYTHON, instrArgs, { encoding: 'utf-8' });
  const instrPath = join(inst.canonicalDir, 'instruction', 'generated.md');
  assert.ok(existsSync(instrPath),
    `compiler must emit <canonical>/instruction/generated.md | ${describeCompilerRun(PYTHON, instrArgs, compiled)}`);
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
