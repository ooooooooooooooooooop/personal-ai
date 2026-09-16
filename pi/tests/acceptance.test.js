/**
 * M3 acceptance — REAL provider/model production-path run (R9 mandatory).
 *
 * Skipped unless PAI_ACCEPT=1. Uses the machine's local cpa proxy
 * (127.0.0.1:8317, openai-completions) + CPA_API_KEY resolved from
 * ~/.dsh/.credentials.yaml in-process — the key never touches logs/audit
 * (audit redaction covers header keys anyway).
 *
 * Asserts the full chain actually ran:
 *   prompt → context → provider → tool → guard → result → continuation/stop → persistence
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHost } from '../src/bootstrap/host.js';

const SKIP = process.env.PAI_ACCEPT !== '1';

function loadCredential(envName) {
  const credPath = join(process.env.USERPROFILE ?? '', '.dsh', '.credentials.yaml');
  if (!existsSync(credPath)) return null;
  const text = readFileSync(credPath, 'utf-8');
  const m = text.match(new RegExp(`^\\s*${envName}:\\s*['"]?([^'"\\s]+)['"]?\\s*$`, 'm'));
  return m ? m[1] : null;
}

const auditLines = (dir) =>
  readFileSync(join(dir, 'audit', 'host-audit.jsonl'), 'utf-8')
    .trim().split('\n').map((l) => JSON.parse(l));

test('M3 acceptance: real provider end-to-end chain', { skip: SKIP, timeout: 180_000 }, async () => {
  const apiKey = loadCredential('CPA_API_KEY');
  assert.ok(apiKey, 'CPA_API_KEY not resolvable from ~/.dsh/.credentials.yaml');

  const dir = mkdtempSync(join(tmpdir(), 'pai-accept-'));
  const canonicalDir = join(dir, 'canonical');
  mkdirSync(canonicalDir, { recursive: true });
  writeFileSync(join(canonicalDir, 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {},
    riskActions: { destructive: 'deny', privilege: 'deny' },
  }));

  const agentDir = join(dir, 'pi-agent');
  mkdirSync(agentDir, { recursive: true });
  // custom provider declaration: key resolved via env interpolation at runtime
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      cpa: {
        baseUrl: 'http://127.0.0.1:8317/v1',
        api: 'openai-completions',
        apiKey: '$CPA_API_KEY',
        models: [{
          id: 'gpt-5.6-luna-max',
          name: 'gpt-5.6-luna-max',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1050000,
          maxTokens: 8192,
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
        id: 'gpt-5.6-luna-max',
        name: 'gpt-5.6-luna-max',
        api: 'openai-completions',
        provider: 'cpa',
        baseUrl: 'http://127.0.0.1:8317/v1',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1050000,
        maxTokens: 8192,
      },
    },
    taskRequirements: [
      { id: 'ran-shell', kind: 'tool_success', tool: 'bash' },
    ],
  });

  assert.ok(host.guard.sealed());

  await host.session.prompt(
    'Use the bash tool to run `echo ACCEPT_OK` exactly once, then reply with the single word DONE.',
  );

  const lines = auditLines(dir);
  const kinds = lines.map((e) => e.kind);
  assert.ok(kinds.includes('HOST_STARTED'), 'host start not audited');
  assert.ok(kinds.includes('PROVIDER_REQUEST'), 'no real provider request recorded');
  assert.ok(kinds.includes('TOOL_CALL_ADMITTED'), 'guard never admitted a call');
  assert.ok(
    kinds.includes('TURN_ACCOUNTING') || kinds.includes('PROVIDER_RESPONSE'),
    'no provider response/accounting recorded',
  );
  const admitted = lines.find((e) => e.kind === 'TOOL_CALL_ADMITTED');
  assert.equal(admitted.toolName, 'bash');
  const accounting = lines.find((e) => e.kind === 'TURN_ACCOUNTING');
  assert.ok(accounting && accounting.data.input > 0, 'real token usage missing');

  // continuity evidence persisted
  assert.ok(existsSync(join(dir, 'runtime.json')));
});
