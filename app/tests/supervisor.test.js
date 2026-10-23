/**
 * BodySupervisor against REAL fixture channel processes — the body panel and
 * switch path are exercised end-to-end: discovery, eligibility, passthrough,
 * cold swap, and the seven-phase handoff with a real lease baton.
 */
import { mkdtempSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BodySupervisor } from '../server/supervisor.js';
import { HandoffStore } from '../../host/src/core/handoff.js';
import { DomainLeaseStore } from '../../host/src/core/lease.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = join(REPO, 'app', 'tests', 'fixtures', 'fake-channel.js');

const FAKE_CAPS = {
  final_post_extension_guard: 'supported',
  durable_jobs: 'supported',
  provider_request_audit: 'supported',
};
const fakeFacts = (id) => ({
  body_id: id, adapter_version: '0.0.1',
  verified_capabilities: { ...FAKE_CAPS },
  governance_coverage: { audit: 'supported' },
  handoff_capabilities: { quiesce: 'supported', verify: 'supported' },
});

function catalog(msgs = {}, extraEnv = {}) {
  const mk = (id) => ({
    id, label: id,
    facts: () => fakeFacts(id),
    installed: () => true,
    channel: () => ({
      command: process.execPath,
      args: [FIXTURE, '--instance', 'INSTANCE'],
      env: { FAKE_BODY: id, FAKE_MSGS: String(msgs[id] ?? 0), ...extraEnv },
    }),
  });
  return {
    'fake-a': mk('fake-a'),
    'fake-b': mk('fake-b'),
    'fake-nochan': {
      id: 'fake-nochan', facts: () => fakeFacts('fake-nochan'),
      installed: () => true, channel: null, installHint: 'no channel build',
    },
    'fake-gone': {
      id: 'fake-gone', facts: () => fakeFacts('fake-gone'),
      installed: () => false, channel: () => ({}), installHint: 'install it',
    },
  };
}

// channel() args need the per-test instance root — wrap catalog to inject it.
function catalogFor(dir, msgs, extraEnv) {
  const c = catalog(msgs, extraEnv);
  for (const e of Object.values(c)) {
    if (!e.channel) continue;
    const inner = e.channel;
    e.channel = () => {
      const spec = inner();
      spec.args = spec.args.map((a) => (a === 'INSTANCE' ? dir : a));
      return spec;
    };
  }
  return c;
}

async function boot(msgs = { 'fake-a': 1 }, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pai-app-'));
  // Keep every existing test hermetic: unless a test injects its own
  // backupCtl/govCtl, the boot-time ticks see "fresh" and never spawn python.
  const backupCtl = opts.backupCtl ?? { probe: async () => ({ ok: true, overdue: false }), run: async () => 0 };
  const govCtl = opts.govCtl ?? { probe: async () => ({ ok: true, overdue: false, lanes: {} }), run: async () => 0 };
  const cogCtl = opts.cogCtl ?? { run: async () => 0 };
  const sup = await new BodySupervisor({
    instanceRoot: dir, workdir: dir, repoRoot: REPO,
    catalog: catalogFor(dir, msgs, opts.fakeEnv), env: { ...process.env }, ...opts, backupCtl, govCtl, cogCtl,
  }).start();
  return { sup, dir };
}

test('discovery + default selection: eligible channel body boots, facts registered', async () => {
  const { sup } = await boot();
  try {
    const cur = await sup.handle({ type: 'body_current' });
    assert.equal(cur.data.body_id, 'fake-a');
    assert.ok(cur.data.runId);

    const list = await sup.handle({ type: 'body_list' });
    const byId = Object.fromEntries(list.data.map((b) => [b.body_id, b]));
    assert.equal(byId['fake-a'].current, true);
    assert.equal(byId['fake-b'].installed, true);
    assert.equal(byId['fake-nochan'].has_channel, false);
    assert.equal(byId['fake-gone'].installed, false);
    assert.equal(byId['fake-gone'].eligibility.eligible, false);
  } finally { await sup.dispose(); }
});

test('passthrough: prompt reaches the live body and events flow back', async () => {
  const { sup } = await boot();
  const events = [];
  sup.subscribe((m) => events.push(m));
  try {
    const r = await sup.handle({ id: 't1', type: 'prompt', message: 'hello' });
    assert.equal(r.success, true);
    assert.equal(r.data.echoed, 'hello');
    assert.ok(events.some((m) => m.type === 'event' && m.event.type === 'agent_end'));
  } finally { await sup.dispose(); }
});

test('body_select refuses uninstalled / channel-less bodies fail-closed', async () => {
  const { sup } = await boot();
  try {
    const gone = await sup.handle({ type: 'body_select', body_id: 'fake-gone' });
    assert.equal(gone.success, false);
    assert.match(gone.error, /not installed/);

    const noch = await sup.handle({ type: 'body_select', body_id: 'fake-nochan' });
    assert.equal(noch.success, false);
    assert.match(noch.error, /no session channel/);

    const unknown = await sup.handle({ type: 'body_select', body_id: 'nope' });
    assert.equal(unknown.success, false);
  } finally { await sup.dispose(); }
});

test('body_select with a live session runs the real seven-phase handoff', async () => {
  const { sup, dir } = await boot({ 'fake-a': 1, 'fake-b': 0 });
  const events = [];
  sup.subscribe((m) => events.push(m));
  try {
    const r = await sup.handle({ type: 'body_select', body_id: 'fake-b' });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.mode, 'handoff');

    // record persisted through the whole machine
    const status = await sup.handle({ type: 'handoff_status', handoff_id: r.data.handoffId });
    assert.equal(status.data.state, 'verified');

    // the lease baton really passed: new owner holds it, old owner fenced out
    const leases = new DomainLeaseStore({ root: dir });
    const held = leases.heldBy({ scope: 'domain', name: 'session-writer' });
    assert.equal(held.status, 'active');
    assert.match(held.owner, /^fake-b:/);
    leases.close();

    // phases were emitted to subscribers in order
    const phases = events.filter((m) => m.type === 'supervisor' && m.event.kind === 'handoff_phase')
      .map((m) => m.event.phase);
    assert.deepEqual(phases, ['prepared', 'quiesced', 'checkpointed', 'released', 'acquired', 'resumed', 'verified']);

    const cur = await sup.handle({ type: 'body_current' });
    assert.equal(cur.data.body_id, 'fake-b');

    // audit ledger recorded the switch
    const auditFile = join(dir, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`);
    assert.ok(existsSync(auditFile));
    const kinds = readFileSync(auditFile, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l).kind);
    assert.ok(kinds.includes('BODY_SWITCHED'));
  } finally { await sup.dispose(); }
});

test('body_select on an empty session is a cold swap — no handoff record', async () => {
  const { sup, dir } = await boot({ 'fake-a': 0 });
  try {
    const r = await sup.handle({ type: 'body_select', body_id: 'fake-b' });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.mode, 'cold');
    const pending = new HandoffStore({ root: dir, checkpointsDir: join(dir, 'checkpoints') }).pending();
    assert.equal(pending.length, 0);
    const cur = await sup.handle({ type: 'body_current' });
    assert.equal(cur.data.body_id, 'fake-b');
  } finally { await sup.dispose(); }
});

test('set_workdir persists to app-config and respawns the live body', async () => {
  const { sup, dir } = await boot();
  try {
    const before = (await sup.handle({ type: 'body_current' })).data.runId;
    const newDir = mkdtempSync(join(tmpdir(), 'pai-wd-'));
    const r = await sup.handle({ type: 'set_workdir', path: newDir });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(sup.workdir, newDir);
    const cfg = JSON.parse(readFileSync(join(dir, 'app-config.json'), 'utf-8'));
    assert.equal(cfg.workdir, newDir);
    const after = (await sup.handle({ type: 'body_current' })).data.runId;
    assert.notEqual(after, before); // respawned on the new workdir
    const bad = await sup.handle({ type: 'set_workdir', path: join(dir, 'nope-does-not-exist') });
    assert.equal(bad.success, false);
  } finally { await sup.dispose(); }
});

test('handoff_status without id lists pending records', async () => {
  const { sup } = await boot();
  try {
    const r = await sup.handle({ type: 'handoff_status' });
    assert.equal(r.success, true);
    assert.ok(Array.isArray(r.data.pending));
  } finally { await sup.dispose(); }
});

test('files_list walks workdir, skips ignored dirs, filters by prefix', async () => {
  const { sup, dir } = await boot();
  try {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'junk'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.js'), 'x');
    writeFileSync(join(dir, 'src', 'deep', 'b.js'), 'x');
    writeFileSync(join(dir, 'node_modules', 'junk', 'c.js'), 'x');
    writeFileSync(join(dir, 'README.md'), 'x');
    const all = await sup.handle({ type: 'files_list' });
    assert.equal(all.success, true);
    const files = all.data.files;
    assert.ok(files.includes('src/a.js'));
    assert.ok(files.includes('src/deep/b.js'));
    assert.ok(files.includes('README.md'));
    assert.ok(!files.some((f) => f.includes('node_modules')), 'ignored dirs excluded');
    const filtered = await sup.handle({ type: 'files_list', prefix: 'deep' });
    assert.deepEqual(filtered.data.files, ['src/deep/b.js']);
  } finally { await sup.dispose(); }
});

test('file_read returns workdir file content; escapes and missing paths refused', async () => {
  const { sup, dir } = await boot();
  try {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'note.txt'), 'hello attach');
    const ok = await sup.handle({ type: 'file_read', path: 'note.txt' });
    assert.equal(ok.success, true);
    assert.equal(ok.data.content, 'hello attach');
    const esc = await sup.handle({ type: 'file_read', path: '../outside.txt' });
    assert.equal(esc.success, false);
    const missing = await sup.handle({ type: 'file_read', path: 'nope.txt' });
    assert.equal(missing.success, false);
  } finally { await sup.dispose(); }
});

test('macro save/list/delete persists to instance macros.json', async () => {
  const { sup, dir } = await boot();
  try {
    const bad = await sup.handle({ type: 'macro_save', name: '9bad name', text: 'x' });
    assert.equal(bad.success, false);
    const save = await sup.handle({ type: 'macro_save', name: 'fixup', text: '修复所有 lint 错误' });
    assert.equal(save.success, true);
    const list = await sup.handle({ type: 'macro_list' });
    assert.equal(list.data.macros.fixup, '修复所有 lint 错误');
    // durable — a fresh supervisor on the same instance sees it
    // (seams injected: without them the boot ticks would spawn REAL python
    // probes, and an overdue real machine would trigger a real backup/gov run)
    const sup2 = await new BodySupervisor({
      instanceRoot: dir, workdir: dir, repoRoot: REPO,
      catalog: catalogFor(dir, {}), env: { ...process.env },
      backupCtl: { probe: async () => ({ ok: true, overdue: false }), run: async () => 0 },
      govCtl: { probe: async () => ({ ok: true, overdue: false, lanes: {} }), run: async () => 0 },
    }).start();
    try {
      const l2 = await sup2.handle({ type: 'macro_list' });
      assert.equal(l2.data.macros.fixup, '修复所有 lint 错误');
    } finally { await sup2.dispose(); }
    const del = await sup.handle({ type: 'macro_delete', name: 'fixup' });
    assert.equal(del.success, true);
    const gone = await sup.handle({ type: 'macro_delete', name: 'fixup' });
    assert.equal(gone.success, false);
  } finally { await sup.dispose(); }
});

test('file_read: symlink inside workdir pointing outside is refused (P0b)', async (t) => {
  const { sup, dir } = await boot();
  const outside = join(dir, '..', `outside-${Date.now()}.txt`);
  writeFileSync(outside, 'secret');
  try {
    try { symlinkSync(outside, join(dir, 'link.txt')); }
    catch (e) { t.skip(`symlink unavailable: ${e.code}`); return; }
    const r = await sup.handle({ type: 'file_read', path: 'link.txt' });
    assert.equal(r.success, false);
    assert.match(r.error, /escapes workdir/);
  } finally { await sup.dispose(); }
});

test('workspace registry: add/list/remove, set_workdir auto-registers, active protected', async () => {
  const { sup, dir } = await boot();
  try {
    const other = mkdtempSync(join(tmpdir(), 'pai-ws-'));
    // empty at first
    let r = await sup.handle({ type: 'workspace_list' });
    assert.equal(r.success, true);
    // set_workdir auto-registers the new root
    const sw = await sup.handle({ type: 'set_workdir', path: other });
    assert.equal(sw.success, true);
    r = await sup.handle({ type: 'workspace_list' });
    const active = r.data.workspaces.find((w) => w.path === other);
    assert.ok(active, 'switched dir was auto-registered');
    assert.equal(active.active, true);
    assert.equal(r.data.active, other);
    // explicit add
    const third = mkdtempSync(join(tmpdir(), 'pai-ws2-'));
    r = await sup.handle({ type: 'workspace_add', path: third });
    assert.equal(r.success, true);
    r = await sup.handle({ type: 'workspace_list' });
    assert.ok(r.data.workspaces.some((w) => w.path === third));
    // removing the active workspace is refused
    const rmActive = await sup.handle({ type: 'workspace_remove', path: other });
    assert.equal(rmActive.success, false);
    // removing a non-active entry works
    const rm = await sup.handle({ type: 'workspace_remove', path: third });
    assert.equal(rm.success, true);
    r = await sup.handle({ type: 'workspace_list' });
    assert.ok(!r.data.workspaces.some((w) => w.path === third));
    // nonexistent dir refused at add time
    const bad = await sup.handle({ type: 'workspace_add', path: join(dir, 'nope') });
    assert.equal(bad.success, false);
  } finally { await sup.dispose(); }
});

test('session meta: pin/archive persists and decorates session_list', async () => {
  const { sup, dir } = await boot();
  try {
    const path = `${dir}/sessions/s1.jsonl`;
    // undecorated at first
    let r = await sup.handle({ type: 'session_list' });
    assert.equal(r.data[0].pinned, undefined);
    // pin + archive
    r = await sup.handle({ type: 'session_pin', path });
    assert.equal(r.success, true);
    assert.equal(r.data.meta.pinned, true);
    r = await sup.handle({ type: 'session_archive', path });
    assert.equal(r.data.meta.archived, true);
    // list is decorated
    r = await sup.handle({ type: 'session_list' });
    assert.equal(r.data[0].pinned, true);
    assert.equal(r.data[0].archived, true);
    // persisted to instance session-meta.json (survives supervisor restart)
    const meta = JSON.parse(readFileSync(join(dir, 'session-meta.json'), 'utf-8'));
    assert.equal(meta[path].pinned, true);
    // unpin
    r = await sup.handle({ type: 'session_pin', path, pinned: false });
    assert.equal(r.data.meta.pinned, false);
    // missing path refused
    r = await sup.handle({ type: 'session_pin' });
    assert.equal(r.success, false);
  } finally { await sup.dispose(); }
});

test('session sweep: archives idle unpinned sessions; pinned survive', async () => {
  const { sup, dir } = await boot();
  try {
    const path = `${dir}/sessions/s1.jsonl`;
    // fixture session is modified 2026-01-01 — far older than 14d
    let r = await sup.handle({ type: 'session_sweep', days: 14 });
    assert.equal(r.success, true);
    assert.equal(r.data.swept, 1);
    assert.deepEqual(r.data.paths, [path]);
    r = await sup.handle({ type: 'session_list' });
    assert.equal(r.data[0].archived, true);
    // pinned sessions are never swept — unarchive then pin, sweep again
    await sup.handle({ type: 'session_archive', path, archived: false });
    await sup.handle({ type: 'session_pin', path });
    r = await sup.handle({ type: 'session_sweep', days: 14 });
    assert.equal(r.data.swept, 0);
    r = await sup.handle({ type: 'session_list' });
    assert.equal(r.data[0].archived, false);
  } finally { await sup.dispose(); }
});

test('session purge: deletes archived unpinned sessions; pinned and live survive', async () => {
  const { sup, dir } = await boot();
  try {
    const path = `${dir}/sessions/s1.jsonl`;
    // live session → nothing to purge
    let r = await sup.handle({ type: 'session_purge' });
    assert.equal(r.success, true);
    assert.equal(r.data.purged, 0);
    // archive → purge deletes it and clears its meta
    await sup.handle({ type: 'session_archive', path });
    r = await sup.handle({ type: 'session_purge' });
    assert.equal(r.data.purged, 1);
    assert.deepEqual(r.data.paths, [path]);
    r = await sup.handle({ type: 'session_list' });
    assert.equal(r.data.length, 0, 'deleted session gone from list');
    const meta = JSON.parse(readFileSync(join(dir, 'session-meta.json'), 'utf-8'));
    assert.equal(meta[path], undefined, 'meta entry cleared');
  } finally { await sup.dispose(); }
});

test('session delete: non-existent file path succeeds idempotently and clears meta; requires path', async () => {
  const { sup, dir } = await boot();
  try {
    // Missing path argument rejected
    const bad = await sup.handle({ type: 'session_delete' });
    assert.equal(bad.success, false);
    assert.match(bad.error, /requires \{path\}/);

    const nonExistentPath = join(dir, 'sessions', 'unwritten-session.jsonl');
    // Seed metadata for this session to verify cleanup
    await sup.handle({ type: 'session_pin', path: nonExistentPath });
    let meta = JSON.parse(readFileSync(join(dir, 'session-meta.json'), 'utf-8'));
    assert.equal(meta[nonExistentPath].pinned, true);

    // Set lastSessionFile to simulate it was active
    sup.lastSessionFile = nonExistentPath;

    // Idempotent delete of non-existent file
    const r = await sup.handle({ type: 'session_delete', path: nonExistentPath });
    assert.equal(r.success, true);
    assert.equal(r.data.deleted, false);
    assert.equal(r.data.reason, 'file_not_found');
    assert.equal(sup.lastSessionFile, null, 'active pointer cleared');

    meta = JSON.parse(readFileSync(join(dir, 'session-meta.json'), 'utf-8'));
    assert.equal(meta[nonExistentPath], undefined, 'metadata cleared');

    // Existing session deletion: create actual file and test real delete path
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    const realPath = join(dir, 'sessions', 'real-sess.jsonl');
    writeFileSync(realPath, '{"type":"session"}\n');
    await sup.handle({ type: 'session_pin', path: realPath });
    sup.lastSessionFile = realPath;

    const r2 = await sup.handle({ type: 'session_delete', path: realPath });
    assert.equal(r2.success, true);
    meta = JSON.parse(readFileSync(join(dir, 'session-meta.json'), 'utf-8'));
    assert.equal(meta[realPath], undefined, 'meta entry cleared after real delete');
  } finally { await sup.dispose(); }
});

test('body crash auto-respawns the same body (backoff), events emitted', async () => {
  const { sup } = await boot();
  try {
    const events = [];
    sup.subscribe((m) => { if (m.type === 'supervisor') events.push(m.event.kind); });
    const before = sup.active;
    const beforePid = before.child.pid;
    before.child.kill(); // simulate crash — exit handler fires
    // respawn waits 1s on attempt 1; give it room
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (sup.active !== before && !sup.active.dead && sup.active.info) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.notEqual(sup.active, before, 'a new active replaced the crashed body');
    assert.notEqual(sup.active.child.pid, beforePid);
    assert.ok(sup.active.info?.runId, 'respawned body answered body_info');
    assert.ok(events.includes('body_exited'));
    assert.ok(events.includes('body_respawned'));
    // channel serves commands again after respawn
    const r = await sup.handle({ type: 'body_current' });
    assert.equal(r.data.body_id, 'fake-a');
  } finally { await sup.dispose(); }
});

test('deliberate shutdown does NOT respawn', async () => {
  const { sup } = await boot();
  try {
    const before = sup.active;
    await sup.gracefulShutdown();
    await new Promise((r) => setTimeout(r, 1600)); // longer than attempt-1 backoff
    assert.equal(sup.active, null, 'no respawn after graceful shutdown');
  } finally { await sup.dispose(); }
});

test('unexpected crash leaves forensic evidence: crash report file + BODY_EXITED audit', async () => {
  const { sup, dir } = await boot();
  try {
    sup.active.child.kill(); // simulate crash
    const crashDir = join(dir, 'crashes');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !existsSync(crashDir)) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(crashDir), 'crashes/ dir created on unexpected exit');
    const files = readdirSync(crashDir).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1, 'exactly one crash report');
    const report = JSON.parse(readFileSync(join(crashDir, files[0]), 'utf-8'));
    assert.equal(report.body, 'fake-a');
    assert.equal(report.expected, false, 'unexplained exit marked unexpected');
    assert.ok('exitCode' in report && 'signal' in report && 'uptimeMs' in report);
    assert.ok('stderrTail' in report && 'inFlightCommands' in report);
    // audit trail carries the exit as well
    const auditFile = readdirSync(join(dir, 'audit')).find((f) => f.endsWith('.jsonl'));
    const events = readFileSync(join(dir, 'audit', auditFile), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const exited = events.find((e) => e.kind === 'BODY_EXITED');
    assert.ok(exited, 'BODY_EXITED audited');
    assert.equal(exited.data.expected, false);
    assert.equal(exited.data.body, 'fake-a');
  } finally { await sup.dispose(); }
});

test('graceful shutdown is audited as expected — no crash report, no respawn', async () => {
  const { sup, dir } = await boot();
  try {
    await sup.gracefulShutdown();
    await new Promise((r) => setTimeout(r, 1600)); // longer than attempt-1 backoff
    assert.equal(sup.active, null, 'no respawn after graceful shutdown');
    assert.equal(existsSync(join(dir, 'crashes')), false, 'expected exit writes no crash report');
    const auditFile = readdirSync(join(dir, 'audit')).find((f) => f.endsWith('.jsonl'));
    const events = readFileSync(join(dir, 'audit', auditFile), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const exited = events.find((e) => e.kind === 'BODY_EXITED');
    assert.ok(exited, 'expected exit still audited');
    assert.equal(exited.data.expected, true);
  } finally { await sup.dispose(); }
});

test('spawn failure (missing binary) rejects start without crashing the supervisor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-app-'));
  const badCatalog = {
    'fake-missing': {
      id: 'fake-missing', label: 'fake-missing',
      facts: () => fakeFacts('fake-missing'),
      installed: () => true,
      channel: () => ({ command: 'pai-definitely-not-a-real-binary-xyz', args: [] }),
    },
  };
  const sup = new BodySupervisor({
    instanceRoot: dir, workdir: dir, repoRoot: REPO,
    catalog: badCatalog, env: { ...process.env },
    backupCtl: { probe: async () => ({ ok: true, overdue: false }), run: async () => 0 },
    govCtl: { probe: async () => ({ ok: true, overdue: false, lanes: {} }), run: async () => 0 },
  });
  // Without a child 'error' handler this spawn would throw an unhandled
  // EventEmitter error and kill the whole test process.
  await assert.rejects(() => sup.start(), /did not come up/);
  await sup.dispose();
});

test('backup: overdue probe at boot triggers exactly one auto run, audited', async () => {
  const calls = { probe: 0, run: 0 };
  const backupCtl = {
    probe: async () => {
      calls.probe += 1;
      // overdue on first probe (boot), fresh after the run re-probes
      return calls.run > 0
        ? { ok: true, overdue: false, last_ok: 'now', rpo_hours: 26 }
        : { ok: true, overdue: true, last_ok: null, age_hours: null, rpo_hours: 26 };
    },
    run: async () => { calls.run += 1; return 0; },
  };
  const { sup, dir } = await boot({ 'fake-a': 1 }, { backupCtl });
  try {
    await sup.backupBoot; // the fire-and-forget boot tick
    assert.equal(calls.run, 1, 'overdue probe must trigger exactly one backup run');
    const auditFile = readdirSync(join(dir, 'audit')).find((f) => f.endsWith('.jsonl'));
    const kinds = readFileSync(join(dir, 'audit', auditFile), 'utf-8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l).kind);
    assert.ok(kinds.includes('BACKUP_AUTO_STARTED'));
    assert.ok(kinds.includes('BACKUP_AUTO_FINISHED'));
    const st = await sup.handle({ type: 'backup_status' });
    assert.equal(st.success, true);
    assert.equal(st.data.overdue, false, 'status reflects the completed run');
  } finally { await sup.dispose(); }
});

test('backup: fresh probe triggers no run; probe failure audits and never crashes boot', async () => {
  const calls = { run: 0 };
  const fresh = await boot({ 'fake-a': 1 }, {
    backupCtl: { probe: async () => ({ ok: true, overdue: false, last_ok: 'now', rpo_hours: 26 }),
                 run: async () => { calls.run += 1; return 0; } },
  });
  try {
    await fresh.sup.backupBoot;
    assert.equal(calls.run, 0);
    const st = await fresh.sup.handle({ type: 'backup_status' });
    assert.equal(st.data.overdue, false);
    assert.equal(st.data.running, false);
  } finally { await fresh.sup.dispose(); }

  const broken = await boot({ 'fake-a': 1 }, {
    backupCtl: { probe: async () => ({ ok: false, error: 'device config missing' }),
                 run: async () => { calls.run += 1; return 0; } },
  });
  try {
    await broken.sup.backupBoot;
    assert.equal(calls.run, 0, 'failed probe must not trigger a run');
    const auditFile = readdirSync(join(broken.dir, 'audit')).find((f) => f.endsWith('.jsonl'));
    const kinds = readFileSync(join(broken.dir, 'audit', auditFile), 'utf-8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l).kind);
    assert.ok(kinds.includes('BACKUP_PROBE_FAILED'));
  } finally { await broken.sup.dispose(); }
});

test('governance: overdue lanes at boot each trigger exactly one run, audited, cheap first', async () => {
  const calls = { probe: 0, runs: [] };
  const govCtl = {
    probe: async () => {
      calls.probe += 1;
      const lanes = (overdue) => ({
        frequent: { overdue, cadence_hours: 26, last_ok: null, age_hours: null },
        'sync-check': { overdue, cadence_hours: 26, last_ok: null, age_hours: null },
        weekly: { overdue: false, cadence_hours: 170, last_ok: 'now' },
      });
      return calls.runs.length > 0
        ? { ok: true, overdue: false, lanes: lanes(false) }
        : { ok: true, overdue: true, lanes: lanes(true) };
    },
    run: async (lane) => { calls.runs.push(lane); return 0; },
  };
  const { sup, dir } = await boot({ 'fake-a': 1 }, { govCtl });
  try {
    await sup.govBoot; // boot tick chained after backupBoot
    assert.deepEqual(calls.runs, ['sync-check', 'frequent'],
      'each overdue lane runs exactly once, cheap lanes first');
    const auditFile = readdirSync(join(dir, 'audit')).find((f) => f.endsWith('.jsonl'));
    const rows = readFileSync(join(dir, 'audit', auditFile), 'utf-8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.ok(rows.some((r) => r.kind === 'GOV_AUTO_STARTED' && r.data?.lane === 'frequent'));
    assert.ok(rows.some((r) => r.kind === 'GOV_AUTO_FINISHED' && r.data?.lane === 'sync-check'));
    const st = await sup.handle({ type: 'governance_status' });
    assert.equal(st.success, true);
    assert.equal(st.data.overdue, false, 'status reflects the completed runs');
    assert.equal(st.data.running, false);
  } finally { await sup.dispose(); }
});

test('governance: fresh probe triggers no run; probe failure audits and never crashes boot', async () => {
  const calls = { run: 0 };
  const fresh = await boot({ 'fake-a': 1 }, {
    govCtl: { probe: async () => ({ ok: true, overdue: false, lanes: {} }),
              run: async () => { calls.run += 1; return 0; } },
  });
  try {
    await fresh.sup.govBoot;
    assert.equal(calls.run, 0);
    const st = await fresh.sup.handle({ type: 'governance_status' });
    assert.equal(st.data.overdue, false);
  } finally { await fresh.sup.dispose(); }

  const broken = await boot({ 'fake-a': 1 }, {
    govCtl: { probe: async () => ({ ok: false, error: 'device config missing' }),
              run: async () => { calls.run += 1; return 0; } },
  });
  try {
    await broken.sup.govBoot;
    assert.equal(calls.run, 0, 'failed probe must not trigger a run');
    const auditFile = readdirSync(join(broken.dir, 'audit')).find((f) => f.endsWith('.jsonl'));
    const kinds = readFileSync(join(broken.dir, 'audit', auditFile), 'utf-8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l).kind);
    assert.ok(kinds.includes('GOV_PROBE_FAILED'));
  } finally { await broken.sup.dispose(); }
});

test('backup: persistent overdue after a failed run does NOT retry within the same tick', async () => {
  const calls = { run: 0 };
  // probe stays overdue even after the run (simulates a failing backup)
  const backupCtl = {
    probe: async () => ({ ok: true, overdue: true, last_ok: null, age_hours: null, rpo_hours: 26 }),
    run: async () => { calls.run += 1; return 1; },
  };
  const { sup } = await boot({ 'fake-a': 1 }, { backupCtl });
  try {
    await sup.backupBoot;
    assert.equal(calls.run, 1, 'one run per tick; the hourly timer is the retry');
    const st = await sup.handle({ type: 'backup_status', force: true });
    assert.equal(st.data.overdue, true, 'status honestly stays overdue');
    assert.equal(calls.run, 2, 'a forced user tick may retry once — and stops');
  } finally { await sup.dispose(); }
});

test('governance: persistent overdue after failed runs does NOT retry within the same tick', async () => {
  const calls = { runs: [] };
  const lane = { overdue: true, cadence_hours: 26, last_ok: null, age_hours: null };
  const govCtl = {
    probe: async () => ({ ok: true, overdue: true, lanes: { frequent: lane, 'sync-check': { ...lane }, weekly: { overdue: false } } }),
    run: async (l) => { calls.runs.push(l); return 1; },
  };
  const { sup } = await boot({ 'fake-a': 1 }, { govCtl });
  try {
    await sup.govBoot;
    assert.deepEqual(calls.runs, ['sync-check', 'frequent'],
      'each overdue lane runs once; no same-tick retry even though still overdue');
  } finally { await sup.dispose(); }
});

test('T4: world_model_status lists proposals; proposal_decide validates before any spawn', async () => {
  const { sup } = await boot();
  try {
    const pdir = join(sup.paths.canonicalDir, 'proposals');
    mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, '2026-10-13-model-proposal-cand-x.json'), JSON.stringify({
      schema_version: '1.2', kind: 'MODEL_PROPOSAL', timestamp: '2026-10-13T00:00:00Z',
      status: 'proposed',
      payload: { candidate: { proposition: '测试提案', confidence: 'low', abstraction_level: 'L2' } },
    }));
    const r = await sup.handle({ type: 'world_model_status' });
    assert.equal(r.success, true);
    assert.equal(r.data.proposals.length, 1);
    assert.equal(r.data.proposals[0].title, '测试提案');
    assert.equal(r.data.proposals[0].status, 'proposed');
    // validation rails: traversal / unknown decision / missing file are all
    // refused BEFORE python is ever spawned
    const traversal = await sup.handle({ type: 'proposal_decide', file: '../secret.json', decision: 'reject' });
    assert.equal(traversal.success, false);
    const badDec = await sup.handle({ type: 'proposal_decide', file: '2026-10-13-model-proposal-cand-x.json', decision: 'nuke' });
    assert.equal(badDec.success, false);
    const missing = await sup.handle({ type: 'proposal_decide', file: 'missing.json', decision: 'reject' });
    assert.equal(missing.success, false);
    assert.match(missing.error, /not found/);
  } finally { await sup.dispose(); }
});

test('F06 evidence ring: decided proposals carry stage — compiled vs written vs rejected', async () => {
  const { sup } = await boot();
  try {
    const canonDir = sup.paths.canonicalDir;
    mkdirSync(join(canonDir, 'proposals'), { recursive: true });
    const mk = (name, status, decision) => writeFileSync(join(canonDir, 'proposals', name), JSON.stringify({
      schema_version: '1.2', kind: 'MODEL_PROPOSAL', timestamp: '2026-10-13T00:00:00Z', status,
      payload: { candidate: { proposition: `prop-${name}`, candidate_id: `m-${name}` } },
      ...(decision ? { decision } : {}),
    }));
    mk('a-compiled.json', 'accepted', { decision: 'accept', ts: '2026-10-13T00:00:00Z', applied_model: 'm-a' });
    mk('b-written.json', 'accepted', { decision: 'accept', ts: '2026-10-13T02:00:00Z', applied_model: 'm-b' });
    mk('c-rejected.json', 'rejected', { decision: 'reject', ts: '2026-10-13T00:30:00Z' });
    // 编译投影生成于 a 之后、b 之前；简报里只有 m-a
    writeFileSync(join(canonDir, 'briefing.md'), '## 3. Current Best Models\n- **m-a** [0.9] 现行模型\n');
    writeFileSync(join(canonDir, 'runtime-state.json'), JSON.stringify({ compiled_at: '2026-10-13T01:00:00Z' }));
    const r = await sup.handle({ type: 'world_model_status' });
    const byFile = Object.fromEntries(r.data.proposals.map((p) => [p.file, p.stage]));
    assert.equal(byFile['a-compiled.json'], 'compiled', '裁决后编译且简报含模型 → 后续会话生效');
    assert.equal(byFile['b-written.json'], 'written', '编译投影早于裁决 → 待编译');
    assert.equal(byFile['c-rejected.json'], 'rejected');
  } finally { await sup.dispose(); }
});

test('F06 weekly cognition summary + proposal_correct writes a governed proposal', async () => {
  const { sup } = await boot();
  try {
    const canonDir = sup.paths.canonicalDir;
    mkdirSync(join(canonDir, 'proposals'), { recursive: true });
    mkdirSync(join(canonDir, 'history'), { recursive: true });
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 10 * 86400_000).toISOString();
    const prop = (name, status, ts) => writeFileSync(join(canonDir, 'proposals', name), JSON.stringify({
      schema_version: '1.2', kind: 'MODEL_PROPOSAL', timestamp: ts, status,
      payload: { candidate: { proposition: `p-${name}`, candidate_id: `m-${name}` } },
    }));
    prop('w1.json', 'proposed', now);
    prop('w2.json', 'rejected', now);
    prop('w3.json', 'proposed', old); // outside the 7d window
    writeFileSync(join(canonDir, 'history', 'model-updates.jsonl'), [
      JSON.stringify({ ts: old, kind: 'U1_APPLY', model_id: 'm-x' }),
      JSON.stringify({ ts: now, kind: 'U1_APPLY', model_id: 'm-x' }), // 修订：同 id 已有历史
      JSON.stringify({ ts: now, kind: 'U1_APPLY', model_id: 'm-y' }),
      '',
    ].join('\n'));
    const r = await sup.handle({ type: 'world_model_status' });
    assert.equal(r.success, true);
    assert.deepEqual(
      { proposed: r.data.weekly.proposed, rejected: r.data.weekly.rejected,
        applied: r.data.weekly.applied, revised: r.data.weekly.revised },
      { proposed: 1, rejected: 1, applied: 2, revised: 1 },
      '本周分面：候选/否决看提案时间戳，生效/修订看 u1_accept 写入账本',
    );

    // proposal_correct：校验先于写盘
    const bad = await sup.handle({ type: 'proposal_correct', model_id: '../escape', proposition: 'x' });
    assert.equal(bad.success, false);
    const empty = await sup.handle({ type: 'proposal_correct', model_id: 'm-x', proposition: '  ' });
    assert.equal(empty.success, false);
    const ok = await sup.handle({ type: 'proposal_correct', model_id: 'm-x', proposition: '用户其实偏好长回复', falsifier: '连续两周长回复被撤销', reason: '实测纠偏' });
    assert.equal(ok.success, true, JSON.stringify(ok));
    const written = JSON.parse(readFileSync(join(canonDir, 'proposals', ok.data.file), 'utf-8'));
    assert.equal(written.kind, 'MODEL_PROPOSAL');
    assert.equal(written.status, 'proposed');
    assert.equal(written.payload.candidate.candidate_id, 'm-x', '同 candidate_id → 采纳后覆盖式修订');
    assert.equal(written.payload.candidate.proposition, '用户其实偏好长回复');
    // 新提案立即出现在待裁决队列
    const r2 = await sup.handle({ type: 'world_model_status' });
    assert.ok(r2.data.proposals.some((p) => p.file === ok.data.file && p.status === 'proposed'));
    assert.equal(r2.data.weekly.proposed, 2);
  } finally { await sup.dispose(); }
});

test('F06 cognition cycle: cognition_run triggers wm_cycle via seam; interval gates reruns', async () => {
  const calls = { runs: 0 };
  const { sup } = await boot({ 'fake-a': 1 }, { cogCtl: { run: async () => { calls.runs++; return 0; } } });
  try {
    await sup.cogBoot; // boot fires the first cycle
    const afterBoot = calls.runs;
    const r = await sup.handle({ type: 'cognition_run' });
    assert.equal(r.success, true);
    assert.equal(calls.runs, afterBoot + 1, 'manual run triggers exactly one cycle');
    // a second manual run immediately after is force=true → also runs
    await sup.handle({ type: 'cognition_run' });
    assert.equal(calls.runs, afterBoot + 2);
  } finally { await sup.dispose(); }
});

/* ---- PRD F03/A05: prompt idempotency + receipt-loss reconciliation ---- */

test('prompt idempotency: duplicate client_msg_id attaches to the in-flight turn — body executes once', async () => {
  const { sup, dir } = await boot({ 'fake-a': 1 }, {
    fakeEnv: { FAKE_RECORD_HISTORY: '1', FAKE_PROMPT_DELAY_MS: '400' },
  });
  try {
    const p1 = sup.handle({ type: 'prompt', message: 'hello', client_msg_id: 'cm-dup-1' });
    const p2 = sup.handle({ type: 'prompt', message: 'hello', client_msg_id: 'cm-dup-1' });
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.success, true, JSON.stringify(r1));
    assert.equal(r2.success, true, JSON.stringify(r2));
    assert.equal(r2.deduplicated, true, 'second send attaches, never re-executes');
    assert.equal(r2.data.echoed, 'hello');
    const hist = readFileSync(join(dir, 'fake-history.jsonl'), 'utf-8').split('\n').filter(Boolean);
    assert.equal(hist.length, 1, 'the body saw exactly one execution');
    // a third send after completion returns the cached receipt
    const r3 = await sup.handle({ type: 'prompt', message: 'hello', client_msg_id: 'cm-dup-1' });
    assert.equal(r3.deduplicated, true);
    assert.equal(readFileSync(join(dir, 'fake-history.jsonl'), 'utf-8').split('\n').filter(Boolean).length, 1);
  } finally { await sup.dispose(); }
});

test('prompt receipt loss: timeout → uncertain → blind resend refused → reconcile confirms delivered', async () => {
  const { sup, dir } = await boot({ 'fake-a': 1 }, {
    promptTimeoutMs: 400,
    fakeEnv: { FAKE_RECORD_HISTORY: '1', FAKE_SILENT_PROMPT: '1' }, // executes, never answers
  });
  try {
    const r1 = await sup.handle({ type: 'prompt', message: 'do the thing', client_msg_id: 'cm-lost-1' });
    assert.equal(r1.success, false);
    assert.equal(r1.code, 'OUTCOME_UNCERTAIN', JSON.stringify(r1));
    // a blind resend with the same id is REFUSED — not re-executed
    const r2 = await sup.handle({ type: 'prompt', message: 'do the thing', client_msg_id: 'cm-lost-1' });
    assert.equal(r2.success, false);
    assert.equal(r2.code, 'OUTCOME_UNCERTAIN');
    // and the content-twin net catches a NEW id carrying the same text
    const r2b = await sup.handle({ type: 'prompt', message: 'do the thing', client_msg_id: 'cm-lost-2' });
    assert.equal(r2b.code, 'OUTCOME_UNCERTAIN');
    assert.equal(r2b.data.clientMsgId, 'cm-lost-1', 'points at the original id to reconcile');
    const hist1 = readFileSync(join(dir, 'fake-history.jsonl'), 'utf-8').split('\n').filter(Boolean);
    assert.equal(hist1.length, 1, 'two resend attempts executed nothing extra');
    // reconcile: the body remembers the message → delivered, never again executable
    const rc = await sup.handle({ type: 'prompt_reconcile', client_msg_id: 'cm-lost-1' });
    assert.equal(rc.success, true);
    assert.equal(rc.data.status, 'completed');
    assert.equal(rc.data.reconciled, true);
    const r3 = await sup.handle({ type: 'prompt', message: 'do the thing', client_msg_id: 'cm-lost-1' });
    assert.equal(r3.deduplicated, true);
    const hist2 = readFileSync(join(dir, 'fake-history.jsonl'), 'utf-8').split('\n').filter(Boolean);
    assert.equal(hist2.length, 1, 'post-reconcile resend still executes nothing');
  } finally { await sup.dispose(); }
});

test('prompt to a dead body is not_delivered — resend after respawn executes exactly once', async () => {
  const { sup, dir } = await boot({ 'fake-a': 1 }, {
    promptTimeoutMs: 400,
    fakeEnv: { FAKE_RECORD_HISTORY: '1' },
  });
  try {
    await sup.gracefulShutdown(); // deliberate stop: no autorespawn
    const r1 = await sup.handle({ type: 'prompt', message: 'later', client_msg_id: 'cm-dead-1' });
    assert.equal(r1.success, false);
    assert.equal(r1.error, 'no live body');
    const entry = sup.promptLedger.get('cm-dead-1');
    assert.equal(entry.status, 'not_delivered', 'never touched stdin → definitively not executed');
    await sup.spawnBody('fake-a');
    const r2 = await sup.handle({ type: 'prompt', message: 'later', client_msg_id: 'cm-dead-1' });
    assert.equal(r2.success, true, JSON.stringify(r2));
    assert.equal(r2.data.echoed, 'later');
    const hist = readFileSync(join(dir, 'fake-history.jsonl'), 'utf-8').split('\n').filter(Boolean);
    assert.equal(hist.length, 1, 'exactly one execution across the body restart');
  } finally { await sup.dispose(); }
});

test('prompt ledger restart surface: pending lists uncertain; session switch makes reconcile unverifiable', async () => {
  const { sup } = await boot({ 'fake-a': 1 }, {
    promptTimeoutMs: 400,
    fakeEnv: { FAKE_RECORD_HISTORY: '1', FAKE_SILENT_PROMPT: '1' },
  });
  try {
    // get_state first — the supervisor learns the live session file, which the
    // prompt entry stamps for the session-switch guard
    await sup.handle({ type: 'get_state' });
    const r1 = await sup.handle({ type: 'prompt', message: ' stranded turn ', client_msg_id: 'cm-strand-1' });
    assert.equal(r1.code, 'OUTCOME_UNCERTAIN');
    const pend = await sup.handle({ type: 'prompt_ledger_pending' });
    assert.equal(pend.data.pending.length, 1);
    assert.equal(pend.data.pending[0].clientMsgId, 'cm-strand-1');
    assert.ok(pend.data.pending[0].preview !== undefined);
    // 核对在同一会话里成立
    const ok = await sup.handle({ type: 'prompt_reconcile', client_msg_id: 'cm-strand-1' });
    assert.equal(ok.data.status, 'completed');
    // 再来一条，然后切换会话——核对必须诚实地说"无法核对"，而不是假报未送达
    await sup.handle({ type: 'prompt', message: 'stranded two', client_msg_id: 'cm-strand-2' });
    await sup.handle({ type: 'session_switch', path: `${sup.instanceRoot}/sessions/s2.jsonl` });
    const sw = await sup.handle({ type: 'prompt_reconcile', client_msg_id: 'cm-strand-2' });
    assert.equal(sw.data.status, 'unverifiable', JSON.stringify(sw.data));
    assert.match(sw.data.reason, /会话已切换/);
  } finally { await sup.dispose(); }
});

test('prompt reconcile not_delivered returns the stored message for a safe resend', async () => {
  // 不记录历史的身体 + 静默 prompt：核对查不到 → 未送达，且原文随响应交还
  const { sup } = await boot({ 'fake-a': 1 }, {
    promptTimeoutMs: 400,
    fakeEnv: { FAKE_SILENT_PROMPT: '1' }, // no FAKE_RECORD_HISTORY — history stays empty
  });
  try {
    await sup.handle({ type: 'get_state' });
    const r1 = await sup.handle({ type: 'prompt', message: 'never landed', client_msg_id: 'cm-lost-9' });
    assert.equal(r1.code, 'OUTCOME_UNCERTAIN');
    const rc = await sup.handle({ type: 'prompt_reconcile', client_msg_id: 'cm-lost-9' });
    assert.equal(rc.data.status, 'not_delivered');
    assert.equal(rc.data.message, 'never landed', '留存原文随核对结果交还，UI 可安全重发');
  } finally { await sup.dispose(); }
});

test('prompt ledger survives a supervisor restart — completed id dedups without touching the body', async () => {
  const { sup, dir } = await boot({ 'fake-a': 1 }, { fakeEnv: { FAKE_RECORD_HISTORY: '1' } });
  try {
    const r1 = await sup.handle({ type: 'prompt', message: 'persist me', client_msg_id: 'cm-persist-1' });
    assert.equal(r1.success, true);
    assert.ok(existsSync(join(dir, 'prompt-ledger.json')), 'ledger persisted to the instance');
  } finally { await sup.dispose(); }
  // A fresh supervisor over the same instance (seams injected, same pattern as
  // the macro-durability test) must dedup from the ON-DISK ledger alone.
  const sup2 = await new BodySupervisor({
    instanceRoot: dir, workdir: dir, repoRoot: REPO,
    catalog: catalogFor(dir, { 'fake-a': 1 }, { FAKE_RECORD_HISTORY: '1' }), env: { ...process.env },
    backupCtl: { probe: async () => ({ ok: true, overdue: false }), run: async () => 0 },
    govCtl: { probe: async () => ({ ok: true, overdue: false, lanes: {} }), run: async () => 0 },
    cogCtl: { run: async () => 0 },
  }).start();
  try {
    const r2 = await sup2.handle({ type: 'prompt', message: 'persist me', client_msg_id: 'cm-persist-1' });
    assert.equal(r2.success, true);
    assert.equal(r2.deduplicated, true);
    const hist = readFileSync(join(dir, 'fake-history.jsonl'), 'utf-8').split('\n').filter(Boolean);
    assert.equal(hist.length, 1, 'the restarted body never saw a duplicate');
  } finally { await sup2.dispose(); }
});
