/**
 * BodySupervisor against REAL fixture channel processes — the body panel and
 * switch path are exercised end-to-end: discovery, eligibility, passthrough,
 * cold swap, and the seven-phase handoff with a real lease baton.
 */
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
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

test('handoff_status without id lists pending records', async () => {
  const { sup } = await boot();
  try {
    const r = await sup.handle({ type: 'handoff_status' });
    assert.equal(r.success, true);
    assert.ok(Array.isArray(r.data.pending));
  } finally { await sup.dispose(); }
});
