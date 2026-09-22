/**
 * MonitorRegistry — fire-rate ceiling + durable specs.
 * The two hardening properties over the naive watcher:
 *  - a chatty watched path cannot mint a model turn every debounce window
 *    forever (sliding-window per-monitor cap, audited once per cap-entry)
 *  - a restart re-arms the operator's watches instead of silently wiping them
 */
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorRegistry } from '../src/adapter/monitor.js';

const dir = () => mkdtempSync(join(tmpdir(), 'pai-mon-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 6000, step = 40) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await sleep(step);
  }
}

test('rate ceiling: fires past the hourly cap are dropped, audited once; window recovery resumes', async () => {
  const d = dir();
  const watched = join(d, 'watched.txt');
  writeFileSync(watched, 'v0');
  const sinkCalls = [];
  const auditKinds = [];
  let clock = 1_000_000;
  const reg = new MonitorRegistry({
    promptSink: async (m) => { sinkCalls.push(m); return { ok: true }; },
    audit: { write: (e) => auditKinds.push(e.kind) },
    now: () => clock,
    debounceMs: 5,
  });
  const { id } = reg.add({ path: watched, prompt: 'check it', maxPerHour: 3 });
  // five distinct change bursts inside the same window — only 3 may fire
  for (let i = 1; i <= 5; i++) {
    appendFileSync(watched, `v${i}`);
    await waitFor(() => sinkCalls.length >= Math.min(i, 3), 3000).catch(() => {});
    await sleep(30); // let the debounce fire before the next burst
  }
  assert.equal(sinkCalls.length, 3, 'cap 3 held under 5 bursts');
  assert.equal(auditKinds.filter((k) => k === 'MONITOR_RATE_CAPPED').length, 1, 'capped audited ONCE per cap-entry');
  assert.equal(auditKinds.filter((k) => k === 'MONITOR_FIRED').length, 3);
  // the watcher is still armed: a new window lets the next burst through
  clock += 3_600_001;
  appendFileSync(watched, 'v6');
  await waitFor(() => sinkCalls.length === 4);
  reg.dispose();
});

test('default cap is 12; max_per_hour clamps to the 120 hard ceiling', () => {
  const d = dir();
  writeFileSync(join(d, 'a.txt'), 'x');
  const reg = new MonitorRegistry({ promptSink: async () => ({ ok: true }) });
  const a = reg.add({ path: join(d, 'a.txt'), prompt: 'p' });
  assert.equal(reg.monitors.get(a.id).maxPerHour, 12);
  const b = reg.add({ path: join(d, 'a.txt'), prompt: 'p', maxPerHour: 99999 });
  assert.equal(reg.monitors.get(b.id).maxPerHour, 120);
  const c = reg.add({ path: join(d, 'a.txt'), prompt: 'p', maxPerHour: -5 });
  assert.equal(reg.monitors.get(c.id).maxPerHour, 12, 'garbage falls back to default');
  reg.dispose();
});

test('durability: specs persist, restore re-arms with the same id, remove deletes the record', () => {
  const d = dir();
  const watched = join(d, 'watched.txt');
  writeFileSync(watched, 'v0');
  const store = join(d, 'monitors.json');
  const r1 = new MonitorRegistry({ promptSink: async () => ({ ok: true }), storePath: store });
  const { id } = r1.add({ path: watched, prompt: 'watch this', maxPerHour: 7 });
  assert.ok(existsSync(store));
  r1.dispose(); // shutdown posture — store survives
  assert.ok(existsSync(store), 'dispose must not wipe the store');

  const r2 = new MonitorRegistry({ promptSink: async () => ({ ok: true }), storePath: store });
  const res = r2.restore();
  assert.deepEqual(res, { restored: 1, skipped: 0 });
  const live = r2.list();
  assert.equal(live.length, 1);
  assert.equal(live[0].id, id, 'audit continuity: same monitor id after restart');
  assert.equal(live[0].maxPerHour, 7);
  r2.remove(id);
  const doc = JSON.parse(readFileSync(store, 'utf-8'));
  assert.equal(doc.monitors.length, 0, 'operator remove deletes the record');
  r2.dispose();
});

test('restore skips missing paths but KEEPS them in the store (unmounted drive ≠ delete)', () => {
  const d = dir();
  const store = join(d, 'monitors.json');
  const ghost = join(d, 'not-mounted-yet.txt');
  writeFileSync(store, JSON.stringify({ version: 1, monitors: [
    { id: 'mon-ghost', path: ghost, prompt: 'p', maxPerHour: 12, createdAt: 1 },
  ] }));
  const reg = new MonitorRegistry({ promptSink: async () => ({ ok: true }), storePath: store });
  const res = reg.restore();
  assert.deepEqual(res, { restored: 0, skipped: 1 });
  assert.equal(reg.list().length, 0);
  const doc = JSON.parse(readFileSync(store, 'utf-8'));
  assert.equal(doc.monitors.length, 1, 'skipped entry survives for the next boot');
  reg.dispose();
});
