/**
 * P3 shadow judge — advisory second opinion on ASK cards only; it can
 * never change a verdict (web-review ruling: static kernel = authority).
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { instancePaths } from '../src/core/instance.js';
import { AuditWriter } from '../src/core/audit.js';
import { AttestedPolicy } from '../src/core/policy.js';
import { GovernanceKernel } from '../src/core/governance.js';
import { JudgeAdvisor } from '../src/core/judge.js';

function fixture(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pai-judge-'));
  const canonicalDir = join(dir, 'canonical');
  mkdirSync(canonicalDir, { recursive: true });
  writeFileSync(join(canonicalDir, 'policy.json'), JSON.stringify({
    version: 1, deny: [],
    tools: { bash: { action: 'ask' } },
    riskActions: {},
    ...over,
  }));
  const paths = instancePaths(dir);
  const audit = new AuditWriter(paths);
  return { dir, paths, audit, policy: new AttestedPolicy(canonicalDir) };
}

test('judge disabled → assess null', async () => {
  const j = new JudgeAdvisor({});
  assert.equal(j.enabled, false);
  assert.equal(await j.assess({ toolName: 'bash' }), null);
});

test('judge parses RISK/SUGGEST/WHY; unparseable → null; error → null; all audited', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-judge-audit-'));
  const audit = new AuditWriter(instancePaths(dir));
  const good = new JudgeAdvisor({
    audit,
    call: async () => 'RISK: high\nSUGGEST: deny\nWHY: recursive delete of user files',
  });
  const op = await good.assess({ toolName: 'bash', toolCallId: 't1', args: { command: 'rm -rf /' } });
  assert.deepEqual(op, { risk: 'high', suggest: 'deny', why: 'recursive delete of user files' });

  const bad = new JudgeAdvisor({ audit, call: async () => 'gibberish' });
  assert.equal(await bad.assess({ toolName: 'bash' }), null);

  const throwing = new JudgeAdvisor({ audit, call: async () => { throw new Error('provider down'); } });
  assert.equal(await throwing.assess({ toolName: 'bash' }), null);

  const raw = readFileSync(audit.file, 'utf-8');
  const kinds = raw.trim().split('\n').map((l) => JSON.parse(l).kind);
  assert.equal(kinds.filter((k) => k === 'JUDGE_OPINION').length, 3);
  assert.match(raw, /provider down/);
});

test('governance: judge opinion rides the ASK card but never flips the verdict', async () => {
  const seen = [];
  const judge = new JudgeAdvisor({
    call: async () => 'RISK: low\nSUGGEST: allow\nWHY: benign ls',
  });
  const { audit, policy } = fixture();
  const denyKernel = new GovernanceKernel({
    audit, policy, judge,
    ask: async (pending) => { seen.push(pending); return 'deny'; },
  });
  const d = await denyKernel.decideToolCall({
    toolName: 'bash', toolCallId: 'c1', args: { command: 'ls' },
  });
  assert.equal(d.block, true, 'judge suggest=allow must NOT override operator deny');
  assert.equal(seen[0].advisory.suggest, 'allow');
  assert.equal(seen[0].advisory.risk, 'low');

  // judge throws → ask still reaches the operator (fail-open to human)
  const broken = new JudgeAdvisor({ call: async () => { throw new Error('x'); } });
  const { audit: a2, policy: p2 } = fixture();
  const k2 = new GovernanceKernel({
    audit: a2, policy: p2, judge: broken,
    ask: async (pending) => { seen.push(pending); return 'allow'; },
  });
  const d2 = await k2.decideToolCall({ toolName: 'bash', toolCallId: 'c2', args: { command: 'ls' } });
  assert.equal(d2, undefined, 'allowed calls return undefined — no block');
  assert.equal(seen[1].advisory, null, 'broken judge → no advice, card still worked');
});
