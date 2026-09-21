/**
 * MemoryStore (G-family) — secret gate, dedupe, FTS5 recall, pin/archive,
 * deterministic distill.
 */
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/core/memory.js';

const mk = () => new MemoryStore(':memory:');

test('remember/recall: FTS5 finds the fact; LIKE fallback survives odd input', () => {
  const s = mk();
  s.remember('用户偏好用中文回答', { kind: 'preference', source: 'operator' });
  s.remember('deploy pipeline uses GitHub Actions', { kind: 'fact' });
  const hits = s.recall('GitHub');
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /GitHub/);
  // FTS-hostile input falls back to LIKE instead of throwing
  const odd = s.recall('*** "');
  assert.ok(Array.isArray(odd));
  s.close();
});

test('secret-looking text is refused; exact duplicates merge in place', () => {
  const s = mk();
  const bad = s.remember('my key is sk-abcdefghijklmnopqrstuvwxyz1234');
  assert.match(bad.refused, /secret/);
  const a = s.remember('same fact', { confidence: 0.6 });
  const b = s.remember('same fact', { confidence: 0.9 });
  assert.equal(b.deduped, true);
  assert.equal(b.id, a.id);
  assert.equal(s.stats().total, 1);
  s.close();
});

test('pin → injection payload; forget → archived out of recall', () => {
  const s = mk();
  const { id } = s.remember('deploy target is prod-eu', { kind: 'decision' });
  s.pin(id);
  const inj = s.injection();
  assert.equal(inj.length, 1);
  assert.equal(inj[0].text, 'deploy target is prod-eu');
  s.forget(id);
  assert.equal(s.recall('prod-eu').length, 0);
  assert.equal(s.stats().archived, 1);
  s.close();
});

test('distill demotes stale rows and archives ancient low-confidence ones', () => {
  const s = mk();
  const { id: old } = s.remember('ancient note', { confidence: 0.4 });
  const { id: fresh } = s.remember('fresh fact', { confidence: 0.9 });
  // age the row — created past the archive horizon, updated past stale
  const old_ts = new Date(Date.now() - 200 * 864e5).toISOString();
  s.db.prepare('UPDATE memory SET created = ?, updated = ? WHERE id = ?')
    .run(old_ts, old_ts, old);
  const r = s.distill({ staleDays: 30, archiveDays: 120 });
  assert.equal(r.archived, 1);
  // fresh row untouched
  assert.ok(s.recall('fresh fact').length === 1);
  s.close();
});

test('channel contract: memory_* commands dispatch and fail closed', async () => {
  const { HostChannel } = await import('../src/core/channel.js');
  const session = {
    subscribe: () => () => {},
    getState: async () => ({}),
  };
  const s = mk();
  const ch = new HostChannel({ session, memory: s });
  const save = await ch.handle({ type: 'memory_save', text: 'deadline is Friday' });
  assert.equal(save.success, true);
  const list = await ch.handle({ type: 'memory_list' });
  assert.equal(list.data[0].text, 'deadline is Friday');
  const id = list.data[0].id;
  assert.equal((await ch.handle({ type: 'memory_pin', id })).success, true);
  assert.equal((await ch.handle({ type: 'memory_forget', id })).success, true);
  // no store → fail closed
  const bare = new HostChannel({ session });
  assert.equal((await bare.handle({ type: 'memory_list' })).success, false);
  s.close();
});

test('injection: pinned rows plus per-turn relevance hits, deduped and capped', () => {
  const s = mk();
  s.remember('deploy pipeline uses GitHub Actions', { kind: 'fact' });
  s.remember('database is postgres 16', { kind: 'fact' });
  const pinnedId = s.remember('user prefers Chinese replies', { kind: 'preference' }).id;
  s.pin(pinnedId, true);
  // no hint → pinned only
  assert.deepEqual(s.injection(12).map((m) => m.id), [pinnedId]);
  // hint pulls the relevant unpinned row; pinned stays first, no dupes
  const withHint = s.injection(12, 'how does the GitHub Actions deploy work?');
  assert.equal(withHint[0].id, pinnedId);
  assert.ok(withHint.some((m) => /GitHub Actions/.test(m.text)));
  assert.ok(!withHint.some((m) => /postgres/.test(m.text)));
  s.close();
});
