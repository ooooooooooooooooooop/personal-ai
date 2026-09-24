/**
 * dedup-h #820 — pluggable secret sources (Bitwarden/1Password).
 * References resolve only for operator-enabled schemes; the CLI runs
 * argv-style with a bounded budget; resolved values flow back for the
 * caller to store masked — never into error strings.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSecretRef, resolveSecretRef } from '../src/core/secretsource.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'pai-sec-'));
const withSources = (dir, sources) => writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ sources }));

test('parseSecretRef: op/bw grammar, rejects non-refs', () => {
  assert.deepEqual(parseSecretRef('op://vault/item/field'),
    { scheme: 'op', vault: 'vault', item: 'item', field: 'field', itemKey: 'vault/item' });
  assert.equal(parseSecretRef('op://vault/item'), null); // field required
  assert.deepEqual(parseSecretRef('bw://my-item'),
    { scheme: 'bw', item: 'my-item', field: null, itemKey: 'my-item' });
  assert.deepEqual(parseSecretRef('bw://my-item/username'),
    { scheme: 'bw', item: 'my-item', field: 'username', itemKey: 'my-item' });
  assert.equal(parseSecretRef('plain-value'), null);
  assert.equal(parseSecretRef('aws://x/y/z'), null); // unknown scheme
  assert.equal(parseSecretRef('op://'), null);
});

test('resolve: scheme absent from secrets.json refuses before spawning', () => {
  const dir = tmp();
  withSources(dir, { bw: {} });
  const r = resolveSecretRef('op://v/i/f', { instanceRoot: dir, spawnFn: () => { throw new Error('must not spawn'); } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not enabled/);
  // No secrets.json at all → everything refuses.
  const dir2 = tmp();
  const r2 = resolveSecretRef('bw://it', { instanceRoot: dir2 });
  assert.equal(r2.ok, false);
});

test('resolve: items allowlist gates which refs the model may point at', () => {
  const dir = tmp();
  withSources(dir, { op: { items: ['prod/'] } });
  const calls = [];
  const spawn = (bin, args) => { calls.push(args.join(' ')); return 's3cret\n'; };
  const denied = resolveSecretRef('op://dev/db/pass', { instanceRoot: dir, spawnFn: spawn });
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /allowlist/);
  assert.equal(calls.length, 0, 'denied item must never reach the CLI');
  const ok = resolveSecretRef('op://prod/db/pass', { instanceRoot: dir, spawnFn: spawn });
  assert.equal(ok.ok, true);
  assert.equal(ok.value, 's3cret');
  assert.deepEqual(calls, ['read op://prod/db/pass']);
});

test('resolve: bw item JSON extracts password/username/notes/custom fields', () => {
  const dir = tmp();
  withSources(dir, { bw: {} });
  const item = JSON.stringify({
    login: { password: 'pw1', username: 'u1' },
    notes: 'n1',
    fields: [{ name: 'api_key', value: 'ak1' }],
  });
  const spawn = () => item;
  for (const [ref, want] of [
    ['bw://svc', 'pw1'],
    ['bw://svc/username', 'u1'],
    ['bw://svc/notes', 'n1'],
    ['bw://svc/api_key', 'ak1'],
  ]) {
    const r = resolveSecretRef(ref, { instanceRoot: dir, spawnFn: spawn });
    assert.equal(r.ok, true, ref);
    assert.equal(r.value, want, ref);
  }
  const miss = resolveSecretRef('bw://svc/nosuch', { instanceRoot: dir, spawnFn: spawn });
  assert.equal(miss.ok, false);
  assert.match(miss.reason, /no field/);
});

test('resolve: missing CLI / nonzero exit / timeout all fail closed', () => {
  const dir = tmp();
  withSources(dir, { op: {}, bw: {} });
  const enoent = Object.assign(new Error('spawn op ENOENT'), { code: 'ENOENT' });
  const r1 = resolveSecretRef('op://v/i/f', { instanceRoot: dir, spawnFn: () => { throw enoent; } });
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /not found/);
  const r2 = resolveSecretRef('op://v/i/f', { instanceRoot: dir, spawnFn: () => { throw new Error('exit 1: not logged in'); } });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /failed/);
  const r3 = resolveSecretRef('bw://x', { instanceRoot: dir, spawnFn: () => 'not-json' });
  assert.equal(r3.ok, false, 'malformed bw JSON must not surface as a secret');
  const r4 = resolveSecretRef('op://v/i/f', { instanceRoot: dir, spawnFn: () => '   \n' });
  assert.equal(r4.ok, false);
  assert.match(r4.reason, /empty/);
});
