/**
 * WorkspaceWriteLease — the foreground×background workspace mutex.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceWriteLease } from '../src/adapter/writelease.js';

const rig = (opts) => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-lease-'));
  return new WorkspaceWriteLease(join(dir, 'lease.json'), opts);
};

test('acquire → held → second holder refused → release frees it', () => {
  const l = rig();
  assert.equal(l.held(), null);
  assert.equal(l.acquire('job:a').ok, true);
  assert.equal(l.held().holder, 'job:a');
  const denied = l.acquire('job:b');
  assert.equal(denied.ok, false);
  assert.equal(denied.heldBy.holder, 'job:a');
  assert.equal(l.release('job:a'), true);
  assert.equal(l.acquire('job:b').ok, true);
});

test('same holder re-acquires (renew path via acquire)', () => {
  const l = rig();
  l.acquire('job:a');
  assert.equal(l.acquire('job:a').ok, true);
  assert.equal(l.renew('job:a'), true);
  assert.equal(l.renew('job:other'), false);
});

test('expired lease is dead — a new holder takes over', async () => {
  const l = rig({ ttlMs: 40 });
  l.acquire('job:a');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(l.held(), null);
  assert.equal(l.acquire('job:b').ok, true);
});

test('dead-pid lease is dead — crash recovery without waiting for expiry', () => {
  const l = rig({ isAlive: () => false }); // everything is dead
  l.acquire('job:a', {});
  // acquire stores pid=process.pid by default; isAlive says it's dead
  assert.equal(l.held(), null);
});

test('corrupt lease file → held() null, never throws', async () => {
  const l = rig();
  const { writeFileSync } = await import('node:fs');
  writeFileSync(l.file, '{not json');
  assert.equal(l.held(), null);
  assert.equal(l.acquire('job:a').ok, true);
});

test('acquire/renew/release are atomic — no tmp or claim debris beside the lease file', async () => {
  const l = rig({ ttlMs: 30 });
  l.acquire('job:a');
  l.renew('job:a');
  await new Promise((r) => setTimeout(r, 50)); // expire -> stale-claim path (unlink+link)
  assert.equal(l.acquire('job:b').ok, true);
  l.release('job:b');
  const { readdirSync } = await import('node:fs');
  const dir = l.file.slice(0, -'lease.json'.length);
  const debris = readdirSync(dir).filter((f) => f.includes('.tmp') || f.includes('.claim-'));
  assert.deepEqual(debris, []);
});
