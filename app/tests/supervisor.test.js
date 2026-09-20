/**
 * BodySupervisor against REAL fixture channel processes — the body panel and
 * switch path are exercised end-to-end: discovery, eligibility, passthrough,
 * cold swap, and the seven-phase handoff with a real lease baton.
 */
import { mkdtempSync, existsSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
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

function catalog(msgs = {}) {
  const mk = (id) => ({
    id, label: id,
    facts: () => fakeFacts(id),
    installed: () => true,
    channel: () => ({
      command: process.execPath,
      args: [FIXTURE, '--instance', 'INSTANCE'],
      env: { FAKE_BODY: id, FAKE_MSGS: String(msgs[id] ?? 0) },
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
function catalogFor(dir, msgs) {
  const c = catalog(msgs);
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

async function boot(msgs = { 'fake-a': 1 }) {
  const dir = mkdtempSync(join(tmpdir(), 'pai-app-'));
  const sup = await new BodySupervisor({
    instanceRoot: dir, workdir: dir, repoRoot: REPO,
    catalog: catalogFor(dir, msgs), env: { ...process.env },
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
    const sup2 = await new BodySupervisor({
      instanceRoot: dir, workdir: dir, repoRoot: REPO,
      catalog: catalogFor(dir, {}), env: { ...process.env },
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
