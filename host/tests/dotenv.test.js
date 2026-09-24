/** dedup-h #1483 — .env file access: parse + trust-gated load matrix. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDotEnv, loadDotEnv } from '../src/core/dotenv.js';

test('parseDotEnv: comments, export prefix, quotes, malformed lines', () => {
  const d = parseDotEnv([
    '# a comment', '', 'FOO=bar', 'export BAZ=qux', 'SPACED =  spaced val  ',
    'QUOTED="hello world"', "SINGLE='sq'", 'BAD LINE NO EQ', '=nokey', '1BAD=lead-digit',
    'ESC="a\\nb\\tc"',
  ].join('\n'));
  assert.equal(d.FOO, 'bar');
  assert.equal(d.BAZ, 'qux');
  assert.equal(d.SPACED, 'spaced val');
  assert.equal(d.QUOTED, 'hello world');
  assert.equal(d.SINGLE, 'sq');
  assert.equal(d.ESC, 'a\nb\tc');
  assert.equal(d['BAD LINE NO EQ'], undefined);
  assert.equal(d[''], undefined);
  assert.equal(d['1BAD'], undefined);
});

test('#1483: instance .env loads; workdir .env only under trust; real env wins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-denv-'));
  const inst = join(dir, 'inst'); const wd = join(dir, 'wd');
  mkdirSync(inst, { recursive: true }); mkdirSync(wd, { recursive: true });
  writeFileSync(join(inst, '.env'), 'INST_KEY=inst-val\nSHARED=file-val\n');
  writeFileSync(join(wd, '.env'), 'WD_KEY=wd-val\nSHARED=wd-val\n');

  // untrusted workdir → only instance keys land
  const env1 = { SHARED: 'real-env-wins' };
  const l1 = loadDotEnv(inst, wd, { trusted: () => false, env: env1 });
  assert.equal(env1.INST_KEY, 'inst-val');
  assert.equal(env1.WD_KEY, undefined, 'untrusted workdir .env must not load');
  assert.equal(env1.SHARED, 'real-env-wins', 'file never shadows real env');
  assert.deepEqual(l1.instance, ['INST_KEY']); // SHARED skipped — already set
  assert.deepEqual(l1.workdir, []);

  // trusted workdir → its keys land too (after instance; never override)
  const env2 = {};
  const l2 = loadDotEnv(inst, wd, { trusted: () => true, env: env2 });
  assert.equal(env2.WD_KEY, 'wd-val');
  assert.equal(env2.SHARED, 'file-val', 'instance .env wins over workdir');
  assert.deepEqual(l2.workdir, ['WD_KEY']);
});

test('#1483: absent .env is a silent no-op; corrupt file is tolerated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-denv2-'));
  const env = {};
  const l = loadDotEnv(dir, dir, { trusted: () => true, env });
  assert.deepEqual(l, { instance: [], workdir: [] });
  writeFileSync(join(dir, '.env'), ':::garbage\n\n???\nOK=1\n');
  const l2 = loadDotEnv(dir, null, { env });
  assert.equal(env.OK, '1');
  assert.deepEqual(l2.instance, ['OK']);
});
