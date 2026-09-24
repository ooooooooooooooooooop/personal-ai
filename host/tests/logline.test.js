/** dedup-h #3059 — LOG_JSON structured diagnostic logging. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';

const SRC = new URL('../src/core/logline.js', import.meta.url).pathname;

function run2(env) {
  const r = spawnSync(process.execPath, [
    '--input-type=module', '-e',
    `import { logLine } from ${JSON.stringify(`file://${SRC.replace(/\\/g, '/')}`)}; logLine('comp', 'hello', { n: 1 }, 'warn');`,
  ], { env: { ...process.env, ...env }, encoding: 'utf-8' });
  return r.stderr.trim();
}

test('#3059: LOG_JSON=1 emits a single JSON object with fields', () => {
  const line = run2({ LOG_JSON: '1' });
  const rec = JSON.parse(line);
  assert.equal(rec.component, 'comp');
  assert.equal(rec.msg, 'hello');
  assert.equal(rec.level, 'warn');
  assert.equal(rec.n, 1);
  assert.ok(rec.ts);
});

test('#3059: PAI_LOG_JSON=1 is an equivalent switch', () => {
  const rec = JSON.parse(run2({ PAI_LOG_JSON: '1', LOG_JSON: '' }));
  assert.equal(rec.component, 'comp');
});

test('#3059: flag off → bracketed human line, not JSON', () => {
  const line = run2({ LOG_JSON: '0', PAI_LOG_JSON: '' });
  assert.equal(line, '[comp] hello');
});
