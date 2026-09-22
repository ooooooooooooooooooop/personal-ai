/**
 * M114 js_repl — persistent JS REPL: state survives calls, exec-class
 * governance (riskActions.exec + write lease), scrubbed child env.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jsReplTool } from '../src/adapter/jsrepl.js';

test('M114: declarations persist across calls; restart clears; async values awaited', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-repl-'));
  const tool = jsReplTool({ workdir: dir });
  try {
    const r1 = await tool.execute('c1', { code: 'var counter = 41; const label = "pai"; counter + 1' });
    assert.equal(r1.isError, undefined, JSON.stringify(r1));
    assert.match(r1.content[0].text, /=> 42/);
    // a second call sees both var and const declarations
    const r2 = await tool.execute('c2', { code: 'counter + "-" + label' });
    assert.match(r2.content[0].text, /=> 41-pai/);
    // async: a promise result is awaited, not stringified as [object Promise]
    const r3 = await tool.execute('c3', { code: 'Promise.resolve(7 * 6)' });
    assert.match(r3.content[0].text, /=> 42/);
    // errors are reported, not thrown
    const r4 = await tool.execute('c4', { code: 'throw new Error("boom")' });
    assert.match(r4.content[0].text, /ERROR: boom/);
    // restart clears state — counter is gone
    const r5 = await tool.execute('c5', { code: 'typeof counter', restart: true });
    assert.match(r5.content[0].text, /=> undefined/);
  } finally {
    tool.dispose();
  }
});

test('M114: child env is secret-scrubbed — model code cannot read operator credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-repl-env-'));
  const env = { ...process.env, AWS_SECRET_ACCESS_KEY: 'should-not-leak', PAI_REPL_MARKER: 'visible' };
  const tool = jsReplTool({ workdir: dir, env });
  try {
    const r = await tool.execute('c', { code: 'JSON.stringify({ s: process.env.AWS_SECRET_ACCESS_KEY ?? null, m: process.env.PAI_REPL_MARKER ?? null })' });
    const seen = JSON.parse(r.content[0].text.replace(/^=> /, ''));
    assert.equal(seen.s, null, 'secret key scrubbed from child env');
    assert.equal(seen.m, 'visible', 'ordinary env reaches the child');
  } finally {
    tool.dispose();
  }
});
