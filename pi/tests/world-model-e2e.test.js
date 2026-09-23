/**
 * World-model end-to-end — REAL provider run.
 *
 * The adapter passes BCC-1 in isolation and the wiring has unit tests, but
 * neither proves the loop actually produces evidence in a live session. This
 * drives a real turn through the real provider and reads the LEDGER, which is
 * the artifact the mind/ toolchain consumes.
 *
 * Skipped unless PAI_WM_E2E=1 (same convention as acceptance.test.js). Needs
 * the local cpa proxy (127.0.0.1:8317, openai-completions) and CPA_API_KEY.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHost } from '../src/bootstrap/host.js';

const SKIP = process.env.PAI_WM_E2E !== '1';
const MODEL = process.env.PAI_WM_E2E_MODEL || 'gpt-5.6-luna-max';
const day = new Date().toISOString().slice(0, 10);

const readJsonl = (path) => readFileSync(path, 'utf-8').trim().split('\n')
  .filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

test('world-model e2e: a real turn lands RAW_EVIDENCE in the ledger', { skip: SKIP, timeout: 300_000 }, async () => {
  const apiKey = process.env.CPA_API_KEY;
  assert.ok(apiKey, 'CPA_API_KEY is required');

  const dir = mkdtempSync(join(tmpdir(), 'pai-wm-e2e-'));
  const canonicalDir = join(dir, 'canonical');
  mkdirSync(canonicalDir, { recursive: true });
  writeFileSync(join(canonicalDir, 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {},
    riskActions: { destructive: 'deny', privilege: 'deny' },
  }));

  const agentDir = join(dir, 'pi-agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      cpa: {
        baseUrl: 'http://127.0.0.1:8317/v1',
        api: 'openai-completions',
        apiKey: '$CPA_API_KEY',
        models: [{
          id: MODEL, name: MODEL, reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1050000, maxTokens: 8192,
        }],
      },
    },
  }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.CPA_API_KEY = apiKey;

  const host = await startHost({
    instanceRoot: dir,
    workdir: dir,
    sessionOptions: {
      agentDir,
      model: {
        id: MODEL, name: MODEL, api: 'openai-completions', provider: 'cpa',
        baseUrl: 'http://127.0.0.1:8317/v1', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1050000, maxTokens: 8192,
      },
    },
  });

  // A real turn that must use a tool — the evidence path only runs on tool results.
  await host.session.prompt(
    'Use the bash tool to run `echo WM_E2E_OK` exactly once, then reply with the single word DONE.',
  );

  const stateDir = join(dir, 'world-model');
  const ledgerPath = join(stateDir, 'ledger', `${day}.jsonl`);
  assert.ok(existsSync(ledgerPath), `ledger must exist at ${ledgerPath}`);

  const events = readJsonl(ledgerPath);
  assert.ok(events.length > 0, 'ledger must not be empty — the loop was dark before');

  const raw = events.filter((e) => e.event_type === 'RAW_EVIDENCE');
  assert.ok(raw.length > 0, `no RAW_EVIDENCE captured; event types: ${JSON.stringify(events.map((e) => e.event_type))}`);

  // BCC-1 6.2: monotonic seq + a causal chain, and the L0 layer for raw evidence.
  const seqs = events.map((e) => e.seq);
  assert.ok(seqs.every((s, i) => i === 0 || seqs[i - 1] <= s), `seq must be monotonic: ${seqs}`);
  for (let i = 1; i < events.length; i++) {
    assert.equal(events[i].prev_event, events[i - 1].event_id, 'prev_event must chain to the previous event');
  }
  assert.equal(raw[0].layer, 'L0', 'RAW_EVIDENCE is L0');
  assert.ok(raw[0].event_id && raw[0].seq, 'raw evidence carries envelope identity');
  assert.ok(raw[0].tool?.canonical_tool_id, 'raw evidence carries tool identity (6.4)');
  assert.ok(raw.some((e) => e.tool.body_tool_id === 'bash'), `bash must appear; got ${JSON.stringify(raw.map((e) => e.tool))}`);

  // The runtime stream the toolchain reads alongside the ledger.
  const runsDir = join(stateDir, 'runs');
  assert.ok(existsSync(runsDir) && readFileSync(join(runsDir, `${host.session.sessionId}.jsonl`), 'utf-8').trim().length > 0,
    'runs/<session>.jsonl must carry the same events (lp_evaluator reads it)');
});
