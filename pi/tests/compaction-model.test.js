/**
 * dedup-h #1546 — agent.compaction_model: a profile-declared (or
 * feature-models 'compaction') model generates the compaction summary
 * instead of the session model, via the session_before_compact
 * {compaction} extension result.
 */
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHost } from '../src/bootstrap/host.js';
import { loopGovernanceExtension } from '../src/adapter/loop.js';
import { AuditWriter } from '../../host/src/core/audit.js';
import { instancePaths } from '../../host/src/core/instance.js';

const stubModel = {
  id: 'stub', name: 'stub', api: 'openai-completions', provider: 'openai',
  baseUrl: 'http://127.0.0.1:9', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000, maxTokens: 4096,
};

const provision = (dir) => {
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
};

const fakePreparation = () => ({
  firstKeptEntryId: 'e9',
  tokensBefore: 5000,
  previousSummary: 'earlier: parsed v1',
  messagesToSummarize: [
    { role: 'user', content: 'refactor the parser' },
    { role: 'assistant', content: [{ type: 'text', text: 'done — moved it to parser2.js' }] },
  ],
  fileOps: { read: new Set(['a.js', 'b.js']), written: new Set(['b.js']), edited: new Set(['c.js']) },
  settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
});

const loopRig = (dir, compactionSummarize) => {
  const audit = new AuditWriter(instancePaths(dir));
  const handlers = {};
  const pi = { on: (e, fn) => { handlers[e] = fn; } };
  loopGovernanceExtension({ audit, compactionSummarize }).factory(pi);
  return { handlers, audit, dir };
};

const auditKinds = (dir) =>
  readFileSync(join(dir, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf-8')
    .trim().split('\n').map((l) => JSON.parse(l).kind);

test('#1546 loop: configured summarizer yields a ready {compaction} — pi never calls its own model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-compact-loop-'));
  const seen = [];
  const { handlers } = loopRig(dir, async (system, user) => {
    seen.push({ system, user });
    return { text: 'COMPACTED BY CHEAP MODEL', model: 'cheap/fast' };
  });
  const res = await handlers.session_before_compact({
    reason: 'threshold', willRetry: false, branchEntries: [],
    preparation: fakePreparation(),
    customInstructions: 'keep the parser notes',
  });
  assert.equal(seen.length, 1, 'summarizer called once');
  assert.match(seen[0].user, /refactor the parser/, 'transcript serialized into the prompt');
  assert.match(seen[0].system, /keep the parser notes/, 'customInstructions carried');
  assert.match(seen[0].system, /earlier: parsed v1/, 'previousSummary merged into the prompt');
  const c = res?.compaction;
  assert.ok(c, 'handler returns {compaction}');
  assert.equal(c.summary, 'COMPACTED BY CHEAP MODEL');
  assert.equal(c.firstKeptEntryId, 'e9');
  assert.equal(c.tokensBefore, 5000);
  assert.equal(c.details.compactionModel, 'cheap/fast');
  assert.deepEqual(c.details.readFiles, ['a.js'], 'read-only files exclude modified');
  assert.deepEqual([...c.details.modifiedFiles].sort(), ['b.js', 'c.js']);
  assert.ok(auditKinds(dir).includes('COMPACTION_MODEL'), 'routed compaction audited');
});

test('#1546 loop: absent/failed summarizer → native path + honest fallback audit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-compact-null-'));
  const { handlers } = loopRig(dir, null);
  const res = await handlers.session_before_compact({ reason: 'manual', preparation: fakePreparation() });
  assert.equal(res, undefined, 'unconfigured → pi native path runs');
  const dir2 = mkdtempSync(join(tmpdir(), 'pai-compact-fail-'));
  const { handlers: h2 } = loopRig(dir2, async () => null);
  const res2 = await h2.session_before_compact({ reason: 'overflow', preparation: fakePreparation() });
  assert.equal(res2, undefined, 'empty summarizer result → native path runs');
  assert.ok(auditKinds(dir2).includes('COMPACTION_MODEL_FALLBACK'), 'fallback audited, never silent');
});

test('#1546 e2e: feature-models compaction routes the summarization call to that model', async () => {
  const hits = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push(JSON.parse(body || '{}'));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'SUMMARY FROM FEATURE MODEL' } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'pai-compact-e2e-'));
    provision(dir);
    mkdirSync(join(dir, 'pi-agent'), { recursive: true });
    writeFileSync(join(dir, 'pi-agent', 'models.json'), JSON.stringify({
      providers: { compp: { baseUrl: `http://127.0.0.1:${port}`, allowPrivateNetwork: true } },
    }));
    writeFileSync(join(dir, 'feature-models.json'), JSON.stringify({
      compaction: { provider: 'compp', model: 'compact-x' },
    }));
    const host = await startHost({ instanceRoot: dir, workdir: dir, sessionOptions: { model: stubModel } });
    try {
      const res = await host.session.extensionRunner.emit({
        type: 'session_before_compact',
        preparation: fakePreparation(),
        branchEntries: [], reason: 'threshold', willRetry: false,
        signal: new AbortController().signal,
      });
      assert.equal(res?.compaction?.summary, 'SUMMARY FROM FEATURE MODEL');
      assert.equal(res?.compaction?.details?.compactionModel, 'compp/compact-x');
      assert.equal(hits.length, 1, 'one summarization call');
      assert.equal(hits[0].model, 'compact-x', 'the configured model was called');
      assert.match(hits[0].messages.at(-1).content, /refactor the parser/);
      const kinds = readFileSync(join(dir, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf-8')
        .trim().split('\n').map((l) => JSON.parse(l).kind);
      assert.ok(kinds.includes('COMPACTION_MODEL'), 'audit records the routed model');
    } finally {
      host.dispose();
    }
  } finally {
    srv.close();
  }
});

test('#1546 e2e: PAI_COMPACTION_MODEL env stamp wins (agent-level override)', async () => {
  const hits = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push(JSON.parse(body || '{}'));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'SUMMARY VIA ENV STAMP' } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const prev = process.env.PAI_COMPACTION_MODEL;
  process.env.PAI_COMPACTION_MODEL = 'compp/env-model';
  try {
    const dir = mkdtempSync(join(tmpdir(), 'pai-compact-env-'));
    provision(dir);
    mkdirSync(join(dir, 'pi-agent'), { recursive: true });
    writeFileSync(join(dir, 'pi-agent', 'models.json'), JSON.stringify({
      providers: { compp: { baseUrl: `http://127.0.0.1:${port}`, allowPrivateNetwork: true } },
    }));
    // a feature-models 'compaction' entry also exists — the env stamp must win
    writeFileSync(join(dir, 'feature-models.json'), JSON.stringify({
      compaction: { provider: 'compp', model: 'file-model' },
    }));
    const host = await startHost({ instanceRoot: dir, workdir: dir, sessionOptions: { model: stubModel } });
    try {
      const res = await host.session.extensionRunner.emit({
        type: 'session_before_compact',
        preparation: fakePreparation(),
        branchEntries: [], reason: 'manual', willRetry: false,
        signal: new AbortController().signal,
      });
      assert.equal(res?.compaction?.summary, 'SUMMARY VIA ENV STAMP');
      assert.equal(hits[0].model, 'env-model', 'env stamp overrides the file entry');
      assert.equal(res?.compaction?.details?.compactionModel, 'compp/env-model');
    } finally {
      host.dispose();
    }
  } finally {
    if (prev === undefined) delete process.env.PAI_COMPACTION_MODEL;
    else process.env.PAI_COMPACTION_MODEL = prev;
    srv.close();
  }
});

test('#1546 e2e: nothing configured → no interception (native summarizer path)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-compact-none-'));
  provision(dir);
  const host = await startHost({ instanceRoot: dir, workdir: dir, sessionOptions: { model: stubModel } });
  try {
    const res = await host.session.extensionRunner.emit({
      type: 'session_before_compact',
      preparation: fakePreparation(),
      branchEntries: [], reason: 'threshold', willRetry: false,
      signal: new AbortController().signal,
    });
    assert.equal(res?.compaction, undefined, 'no configured model → pi native summarizer runs');
  } finally {
    host.dispose();
  }
});

// dedup-h #2087 — model request wait time honors the configured timeout:
// a feature-models.json {timeout_ms} reaches the actual fetch, it is not
// shadowed by the callsite default (the "first-token timeout ignored" fix).
test('#2087 e2e: feature timeout_ms bounds the summarization request', async () => {
  let delayMs = 400;
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'SUMMARY OK' } }] }));
    }, delayMs));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'pai-compact-to-'));
    provision(dir);
    mkdirSync(join(dir, 'pi-agent'), { recursive: true });
    writeFileSync(join(dir, 'pi-agent', 'models.json'), JSON.stringify({
      providers: { compp: { baseUrl: `http://127.0.0.1:${port}`, allowPrivateNetwork: true } },
    }));
    // 60ms configured timeout vs 400ms server → premature-cancel axis: the
    // configured value, not the 30s callsite default, bounds the request.
    writeFileSync(join(dir, 'feature-models.json'), JSON.stringify({
      compaction: { provider: 'compp', model: 'compact-x', timeout_ms: 60 },
    }));
    const host = await startHost({ instanceRoot: dir, workdir: dir, sessionOptions: { model: stubModel } });
    try {
      const emit = () => host.session.extensionRunner.emit({
        type: 'session_before_compact',
        preparation: fakePreparation(),
        branchEntries: [], reason: 'threshold', willRetry: false,
        signal: new AbortController().signal,
      });
      const res = await emit();
      assert.equal(res?.compaction, undefined,
        'configured 60ms timeout aborts a 400ms response (default 30s would have waited)');
      const kinds = () => readFileSync(join(dir, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf-8')
        .trim().split('\n').map((l) => JSON.parse(l).kind);
      assert.ok(kinds().includes('COMPACTION_MODEL_FALLBACK'), 'abort surfaces as the honest fallback');

      // a generous configured timeout reaches the wire too — not a clamp
      writeFileSync(join(dir, 'feature-models.json'), JSON.stringify({
        compaction: { provider: 'compp', model: 'compact-x', timeout_ms: 10_000 },
      }));
      delayMs = 50;
      const res2 = await emit();
      assert.equal(res2?.compaction?.summary, 'SUMMARY OK', 'configured 10s admits the response');
    } finally {
      host.dispose();
    }
  } finally {
    srv.close();
  }
});

// dedup-h #2240 — maxActiveTranscriptBytes analogue: the serialized
// transcript fed to the summarizer is byte-bounded; over-cap keeps the
// most recent bytes, marks the drop in-band AND audits it.
test('#2240 loop: oversized transcript is tail-bounded, marked, and audited', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-compact-cap-'));
  const seen = [];
  const { handlers } = loopRig(dir, async (system, user) => {
    seen.push(user);
    return { text: 'S', model: 'cheap/fast' };
  });
  const prep = fakePreparation();
  prep.messagesToSummarize = [
    { role: 'user', content: 'OLD-HEAD-' + 'x'.repeat(200 * 1024) },
    { role: 'assistant', content: [{ type: 'text', text: 'RECENT-TAIL-KEPT' }] },
  ];
  await handlers.session_before_compact({ reason: 'overflow', preparation: prep });
  const user = seen[0];
  assert.ok(user.startsWith('[transcript truncated'), 'truncation marked in-band');
  assert.ok(user.includes('RECENT-TAIL-KEPT'), 'most recent content preserved');
  assert.ok(!user.includes('OLD-HEAD-'), 'over-cap head dropped');
  assert.ok(Buffer.byteLength(user, 'utf-8') < 200 * 1024, 'bounded well under the oversized source');
  assert.ok(auditKinds(dir).includes('COMPACTION_TRANSCRIPT_TRUNC'), 'truncation audited');
});

test('#2240 loop: under-cap transcript passes through unmarked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-compact-nocap-'));
  const seen = [];
  const { handlers } = loopRig(dir, async (s, user) => { seen.push(user); return { text: 'S', model: 'm' }; });
  await handlers.session_before_compact({ reason: 'manual', preparation: fakePreparation() });
  assert.ok(!seen[0].startsWith('[transcript truncated'), 'small transcript unmarked');
  assert.ok(!auditKinds(dir).includes('COMPACTION_TRANSCRIPT_TRUNC'), 'no spurious audit');
});
