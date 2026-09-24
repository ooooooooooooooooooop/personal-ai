/**
 * dedup-h #1392 — wand action: the operator describes a change in plain
 * language on an approval card; command_rewrite routes the request through
 * judgeCall's per-feature model seam ('wand') to a fast model and returns
 * the rewritten command FOR REVIEW — it never approves or executes.
 */
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHost } from '../src/bootstrap/host.js';

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

test('#1392 command_rewrite — NL instruction reaches the fast model; rewrite returned for review', async () => {
  // Local OpenAI-compatible endpoint standing in for the feature model.
  const hits = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push(JSON.parse(body || '{}'));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'rm -f scratch/*.log' } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'pai-wand-'));
    provision(dir);
    // provider 'wandp' only exists to aim judgeCall at the local endpoint —
    // feature-models.json routes the 'wand' feature key to it.
    mkdirSync(join(dir, 'pi-agent'), { recursive: true });
    writeFileSync(join(dir, 'pi-agent', 'models.json'), JSON.stringify({
      providers: { wandp: { baseUrl: `http://127.0.0.1:${port}` } },
    }));
    writeFileSync(join(dir, 'feature-models.json'), JSON.stringify({
      wand: { provider: 'wandp', model: 'wand-mini' },
    }));
    const host = await startHost({ instanceRoot: dir, workdir: dir, sessionOptions: { model: stubModel } });
    try {
      const r = await host.channel.handle({
        type: 'command_rewrite', command: 'rm -rf scratch/', instruction: '改成只删 .log 文件',
      });
      assert.equal(r.success, true);
      assert.equal(r.data.command, 'rm -f scratch/*.log');
      // the call actually hit the feature model — right model, instruction carried
      assert.equal(hits.length, 1);
      assert.equal(hits[0].model, 'wand-mini');
      assert.match(hits[0].messages.at(-1).content, /只删/);
      // malformed calls fail closed without touching the model
      assert.equal((await host.channel.handle({ type: 'command_rewrite', command: 'x' })).success, false);
      assert.equal((await host.channel.handle({ type: 'command_rewrite', instruction: 'x' })).success, false);
      assert.equal(hits.length, 1);
    } finally {
      host.dispose();
    }
  } finally {
    srv.close();
  }
});

test('#1392 command_rewrite fail-closed — unreachable feature model → honest error, never silent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-wand2-'));
  provision(dir);
  mkdirSync(join(dir, 'pi-agent'), { recursive: true });
  writeFileSync(join(dir, 'pi-agent', 'models.json'), JSON.stringify({
    providers: { wandp: { baseUrl: 'http://127.0.0.1:9' } },
  }));
  writeFileSync(join(dir, 'feature-models.json'), JSON.stringify({
    wand: { provider: 'wandp', model: 'm' },
  }));
  const host = await startHost({ instanceRoot: dir, workdir: dir, sessionOptions: { model: stubModel } });
  try {
    const r = await host.channel.handle({ type: 'command_rewrite', command: 'rm -rf a', instruction: 'narrow it' });
    assert.equal(r.success, false);
    assert.match(r.error, /rewrite|model/i);
  } finally {
    host.dispose();
  }
});
