/**
 * schedule_task tool + scheduler pump — the tool writes the store; the pump
 * fires due entries as durable jobs and only consumes successful spawns.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ScheduleStore } from '../../host/src/core/scheduler.js';
import { schedulePromptSink, scheduleTool, startSchedulerPump } from '../src/adapter/schedule.js';
import { AuditWriter } from '../../host/src/core/audit.js';
import { makeDecide } from '../src/bootstrap/decide.js';
import { FileOpsGuard } from '../src/adapter/fileops.js';

const rig = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-sched-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  return { dir, audit: new AuditWriter({ auditDir: join(dir, 'audit') }) };
};

test('schedule_task create/list/cancel round-trips the store', async () => {
  const { dir } = rig();
  const store = new ScheduleStore(dir);
  const tool = scheduleTool(store);

  const bad = await tool.execute('c', { action: 'create', command: 'x' });
  assert.equal(bad.isError, true); // neither run_at nor every_seconds

  const r = await tool.execute('c', { action: 'create', command: 'echo hi', every_seconds: 120, label: 'demo' });
  assert.match(r.content[0].text, /scheduled sch-/);
  const id = r.details.id;

  const list = await tool.execute('c', { action: 'list' });
  assert.match(list.content[0].text, new RegExp(`${id}.*demo`));

  const cancel = await tool.execute('c', { action: 'cancel', id });
  assert.match(cancel.content[0].text, /cancelled/);
  assert.equal(store.list().length, 0);
});

test('pump fires due entries as durable jobs; once-entries disable', async () => {
  const { dir, audit } = rig();
  let now = 1_000_000;
  const store = new ScheduleStore(dir, () => now);
  const spawned = [];
  const executor = { spawnCommandJob: async (spec) => { spawned.push(spec); return { job_id: `job-${spawned.length}`, attempt_id: 'a1' }; } };
  store.add({ command: 'past due', run_at: now - 1000 });
  const pump = startSchedulerPump({ store, executor, workdir: dir, audit, intervalMs: 60_000 });
  try {
    await pump.tick();
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].jobType, 'scheduled');
    assert.equal(store.due().length, 0); // once-entry consumed
  } finally {
    pump.dispose();
  }
});

test('refused spawn does not consume the fire — retried next tick', async () => {
  const { dir, audit } = rig();
  let now = 1_000_000;
  const store = new ScheduleStore(dir, () => now);
  let calls = 0;
  const executor = {
    spawnCommandJob: async () => (++calls === 1 ? { refused: true, reason: 'lease held' } : { job_id: 'job-ok', attempt_id: 'a1' }),
  };
  store.add({ command: 'x', run_at: now - 1000 });
  const pump = startSchedulerPump({ store, executor, workdir: dir, audit, intervalMs: 60_000 });
  try {
    await pump.tick();
    assert.equal(store.due().length, 1); // refused → still due
    await pump.tick();
    assert.equal(calls, 2);
    assert.equal(store.due().length, 0); // second attempt consumed
  } finally {
    pump.dispose();
  }
});

test('fire-time policy gate (M90-R2 parity): a command denied by CURRENT policy is consumed + audited, never spawned', async () => {
  const { dir, audit } = rig();
  let now = 1_000_000;
  const store = new ScheduleStore(dir, () => now);
  const spawned = [];
  const executor = {
    preflightCommand: async (spec) => {
      assert.equal(spec.command, 'old-command');
      assert.equal(spec.job_type, 'scheduled');
      return { block: true, rule: 'risk_dangerous', reason: 'policy tightened since create' };
    },
    spawnCommandJob: async (spec) => { spawned.push(spec); return { job_id: 'never' }; },
  };
  store.add({ command: 'old-command', run_at: now - 1000 });
  const auditRows = [];
  const pump = startSchedulerPump({
    store, executor, workdir: dir, intervalMs: 60_000,
    audit: { write: (e) => auditRows.push(e) },
  });
  try {
    await pump.tick();
    assert.equal(spawned.length, 0, 'denied command never reaches the executor');
    assert.equal(store.due().length, 0, 'policy refusal consumes the fire — no infinite retry storm');
    assert.ok(auditRows.some((e) => e.kind === 'SCHEDULE_REFUSED_POLICY' && e.data.rule === 'risk_dangerous'));
    // and the next tick does NOT retry it (stable denial, not a storm)
    await pump.tick();
    assert.equal(spawned.length, 0);
  } finally {
    pump.dispose();
  }
});

test('prompt schedules fire through the governed sink with goal context', async () => {
  const { dir, audit } = rig();
  let now = 1_000_000;
  const { GoalStore } = await import('../../host/src/core/goals.js');
  const { TaskStore } = await import('../../host/src/core/tasks.js');
  const goals = new GoalStore(dir, () => now);
  const tasks = new TaskStore(dir);
  const store = new ScheduleStore(dir, () => now);
  const goal = goals.create({ statement: 'fix the flaky suite' });
  goals.note(goal.goal_id, 'attempt 1: retry loop');
  store.add({ prompt: goal.statement, goal_id: goal.goal_id, run_at: now - 1000 });
  const sent = [];
  const promptSink = async (msg) => { sent.push(msg); return { ok: true }; };
  const pump = startSchedulerPump({
    store, executor: { spawnCommandJob: async () => ({ job_id: 'never' }) },
    workdir: dir, audit, intervalMs: 60_000, promptSink, goals, tasks,
  });
  try {
    await pump.tick();
    assert.equal(sent.length, 1);
    assert.match(sent[0], /fix the flaky suite/);
    assert.match(sent[0], /attempt 1: retry loop/, 'scratchpad tail injected');
    assert.equal(store.due().length, 0);
    const g = goals.get(goal.goal_id);
    assert.ok(g.last_tick_at);
    assert.ok(g.fingerprint, 'fingerprint recorded for monitor-skip');
  } finally { pump.dispose(); }
});

test('monitor-skip: unchanged world consumes the fire without an LLM call', async () => {
  const { dir, audit } = rig();
  let now = 1_000_000;
  const { GoalStore } = await import('../../host/src/core/goals.js');
  const { TaskStore } = await import('../../host/src/core/tasks.js');
  const goals = new GoalStore(dir, () => now);
  const tasks = new TaskStore(dir);
  const store = new ScheduleStore(dir, () => now);
  const goal = goals.create({ statement: 'watch thing' });
  store.add({ prompt: goal.statement, goal_id: goal.goal_id, every_seconds: 60 });
  let calls = 0;
  const promptSink = async () => (++calls, { ok: true });
  const pump = startSchedulerPump({
    store, executor: { spawnCommandJob: async () => ({ job_id: 'never' }) },
    workdir: dir, audit, intervalMs: 60_000, promptSink, goals, tasks,
  });
  try {
    // the boot tick keeps `inflight` occupied for one microtask — drain it
    // so subsequent tick() calls don't await a stale promise
    await new Promise((r) => setImmediate(r));
    now += 61_000;               // first slot comes due
    await pump.tick();           // first tick fires (no prior fingerprint)
    assert.equal(calls, 1);
    now += 61_000;
    await pump.tick();           // nothing changed → monitor-skip
    assert.equal(calls, 1, 'unchanged world skipped the prompt');
    goals.note(goal.goal_id, 'something moved'); // scratchpad changes fingerprint
    now += 61_000;
    await pump.tick();
    assert.equal(calls, 2, 'changed world fires again');
  } finally { pump.dispose(); }
});

test('M135: adaptive entry slows on quiet ticks, re-hastens when the world moves', async () => {
  const { dir, audit } = rig();
  let now = 1_000_000;
  const { GoalStore } = await import('../../host/src/core/goals.js');
  const { TaskStore } = await import('../../host/src/core/tasks.js');
  const goals = new GoalStore(dir, () => now);
  const tasks = new TaskStore(dir);
  const store = new ScheduleStore(dir, () => now);
  const goal = goals.create({ statement: 'watch thing' });
  const rec = store.add({ prompt: goal.statement, goal_id: goal.goal_id, every_seconds: 60, min_seconds: 60, max_seconds: 240 });
  let calls = 0;
  const promptSink = async () => (++calls, { ok: true });
  const pump = startSchedulerPump({
    store, executor: { spawnCommandJob: async () => ({ job_id: 'never' }) },
    workdir: dir, audit, intervalMs: 60_000, promptSink, goals, tasks,
  });
  const get = () => store.list().find((x) => x.id === rec.id);
  try {
    await new Promise((r) => setImmediate(r));
    now += 61_000;
    await pump.tick();           // first fire — establishes the fingerprint
    assert.equal(calls, 1);
    now += 61_000;
    await pump.tick();           // unchanged → quiet, interval stretches to 120
    assert.equal(calls, 1);
    assert.equal(get().quietStreak, 1);
    assert.equal(get().current_seconds, 120);
    assert.equal(get().nextRunAt, now + 120_000);
    now += 61_000;
    assert.equal(store.due().length, 0, 'stretched slot not yet due — no hot-loop billing');
    now += 60_000;
    await pump.tick();           // quiet again → 240 (cap)
    assert.equal(get().current_seconds, 240);
    goals.note(goal.goal_id, 'moved');
    now += 240_000;
    await pump.tick();           // world changed → real fire resets to base
    assert.equal(calls, 2);
    assert.equal(get().quietStreak, 0);
    assert.equal(get().current_seconds, null);
    assert.equal(get().nextRunAt, now + 60_000);
  } finally { pump.dispose(); }
});

test('paused/done goals skip their tick; busy sink leaves the entry due', async () => {
  const { dir, audit } = rig();
  let now = 1_000_000;
  const { GoalStore } = await import('../../host/src/core/goals.js');
  const goals = new GoalStore(dir, () => now);
  const store = new ScheduleStore(dir, () => now);
  const g1 = goals.create({ statement: 'paused goal' });
  const g2 = goals.create({ statement: 'busy goal' });
  goals.setState(g1.goal_id, 'paused');
  store.add({ prompt: g1.statement, goal_id: g1.goal_id, run_at: now - 1000 });
  store.add({ prompt: g2.statement, goal_id: g2.goal_id, run_at: now - 1000 });
  let calls = 0;
  const promptSink = async () => (++calls, { refused: 'busy' });
  const pump = startSchedulerPump({
    store, executor: { spawnCommandJob: async () => ({ job_id: 'never' }) },
    workdir: dir, audit, intervalMs: 60_000, promptSink, goals,
  });
  try {
    await pump.tick();
    assert.equal(calls, 1, 'only the open goal reached the sink');
    // paused consumed (skipped); busy stays due for next tick
    assert.equal(store.due().length, 1);
    assert.equal(store.due()[0].goal_id, g2.goal_id);
  } finally { pump.dispose(); }
});

test('monitor registry: fs.watch fires governed promptSink, debounced, removable', async () => {
  const { MonitorRegistry } = await import('../src/adapter/monitor.js');
  const dir = mkdtempSync(join(tmpdir(), 'pai-mon-'));
  const target = join(dir, 'watched.txt');
  writeFileSync(target, 'v1');
  const fired = [];
  const reg = new MonitorRegistry({ promptSink: async (msg) => { fired.push(msg); return { ok: true }; } });
  const r = reg.add({ path: target, prompt: 'check the change' });
  assert.ok(r.id);
  writeFileSync(target, 'v2');
  writeFileSync(target, 'v3'); // debounce collapses the burst
  await new Promise((res) => setTimeout(res, 2200));
  assert.equal(fired.length, 1);
  assert.match(fired[0], /watched\.txt/);
  assert.match(fired[0], /check the change/);
  assert.equal(reg.list()[0].fires, 1);
  reg.remove(r.id);
  assert.equal(reg.list().length, 0);
  reg.dispose();
});

// G1: a scheduled command fires unattended — the create call is the ONLY
// approval moment, so schedule_task's `command` arg must face the same
// classification a bash call gets. Two sentinels: the kernel wiring in
// host.js, and the project denyPrefix list reaching schedule_task in
// the decide chain.
test('wiring: kernel commandArgs classifies schedule_task.command', () => {
  const src = readFileSync(new URL('../src/bootstrap/host.js', import.meta.url), 'utf-8');
  const m = src.match(/commandArgs:\s*\{([^}]*)\}/);
  assert.ok(m, 'commandArgs map found in host.js');
  assert.match(m[1], /schedule_task:\s*'command'/, 'schedule_task is a classified command carrier');
});

test('decide: .pai/commands.json denyPrefix gates schedule_task.command at create', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-sched-deny-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  mkdirSync(join(dir, '.pai'), { recursive: true });
  writeFileSync(join(dir, '.pai', 'commands.json'), JSON.stringify({ denyPrefixes: ['rm -rf'] }));
  const audit = new AuditWriter({ auditDir: join(dir, 'audit') });
  const decide = makeDecide({
    core: { audit, kernel: { decideToolCall: async () => null } },
    executor: null, fileOps: new FileOpsGuard(dir), getSurface: () => null,
    workdir: dir, asks: null,
  });
  const r = await decide({ toolCall: { name: 'schedule_task', id: 't1' }, args: { action: 'create', command: 'rm -rf /', every_seconds: 3600 } });
  assert.equal(r?.block, true);
  assert.equal(r?.rule, 'command_denylist');
});

// ── dedup-h #410: outbound finished-run webhook ────────────────────────

test('finished scheduled run POSTs webhook with bearer token — durable + idempotent', async () => {
  const { createServer } = await import('node:http');
  const posts = [];
  const srv = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => b += c);
    req.on('end', () => {
      posts.push({ auth: req.headers.authorization, ct: req.headers['content-type'], body: JSON.parse(b) });
      res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/hook`;
  const { dir, audit } = rig();
  let now = 1_000_000;
  const store = new ScheduleStore(dir, () => now);
  process.env.PAI_TEST_WH_TOK = 's3cr3t-token';
  store.add({ command: 'x', run_at: now - 1000, webhook: { url, token_env: 'PAI_TEST_WH_TOK' } });
  const jobs = { 'job-9': { job_state: 'COMPLETED' } };
  const jobStore = {
    getJob: (id) => jobs[id] ?? null,
    getAttempts: () => [{ attempt_id: 'a1', exit_code: 0, started_at: '2026-09-23T00:00:00Z', ended_at: '2026-09-23T00:00:05Z' }],
  };
  const executor = { spawnCommandJob: async () => ({ job_id: 'job-9', attempt_id: 'a1' }) };
  const pump = startSchedulerPump({ store, executor, workdir: dir, audit, intervalMs: 60_000, jobStore });
  try {
    await pump.tick(); // fires job-9 + sweeps (already terminal)
    assert.equal(posts.length, 1);
    assert.equal(posts[0].auth, 'Bearer s3cr3t-token');
    assert.equal(posts[0].body.event, 'schedule.run.finished');
    assert.equal(posts[0].body.job_id, 'job-9');
    assert.equal(posts[0].body.job_state, 'COMPLETED');
    assert.equal(posts[0].body.exit_code, 0);
    await pump.tick(); // idempotent — delivered set persisted, no re-POST
    assert.equal(posts.length, 1);
    // delivery truth survived in the state file
    const st = JSON.parse(readFileSync(join(dir, 'schedule-webhooks.json'), 'utf-8'));
    assert.deepEqual(st.delivered, ['job-9']);
  } finally {
    pump.dispose();
    srv.close();
    delete process.env.PAI_TEST_WH_TOK;
  }
});

test('webhook waits for terminal state; unresolved token env fails loudly, retries bounded', async () => {
  const { createServer } = await import('node:http');
  let hits = 0;
  const srv = createServer((_req, res) => { hits++; res.end('{}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/hook`;
  const { dir, audit } = rig();
  let now = 1_000_000;
  const store = new ScheduleStore(dir, () => now);
  // token_env points at a var that is NOT set → attempt fails, never silently unauthenticated
  store.add({ command: 'x', run_at: now - 1000, webhook: { url, token_env: 'PAI_TEST_WH_MISSING' } });
  const job = { job_state: 'RUNNING' };
  const jobStore = { getJob: () => job, getAttempts: () => [] };
  const executor = { spawnCommandJob: async () => ({ job_id: 'job-1', attempt_id: 'a1' }) };
  const pump = startSchedulerPump({ store, executor, workdir: dir, audit, intervalMs: 60_000, jobStore });
  try {
    await pump.tick(); // job RUNNING → no delivery attempt yet
    assert.equal(hits, 0);
    job.job_state = 'FAILED';
    for (let i = 0; i < 5; i++) await pump.tick(); // 5 failed attempts (token unset) → gave up
    assert.equal(hits, 0); // endpoint never saw an unauthenticated POST
    const st = JSON.parse(readFileSync(join(dir, 'schedule-webhooks.json'), 'utf-8'));
    assert.deepEqual(st.delivered, ['job-1']); // gave up — marked done, not retried forever
    await pump.tick(); // no further attempts
    const st2 = JSON.parse(readFileSync(join(dir, 'schedule-webhooks.json'), 'utf-8'));
    assert.equal(st2.attempts['job-1'], undefined);
  } finally {
    pump.dispose();
    srv.close();
  }
});

test('schedule_task tool: webhook_url + token_env params wire the spec; malformed refused', async () => {
  const { dir } = rig();
  const store = new ScheduleStore(dir);
  const tool = scheduleTool(store);
  const noTok = await tool.execute('c', { action: 'create', command: 'x', every_seconds: 120, webhook_token_env: 'TOK' });
  assert.equal(noTok.isError, true); // token_env without url
  const badUrl = await tool.execute('c', { action: 'create', command: 'x', every_seconds: 120, webhook_url: 'ftp://x' });
  assert.equal(badUrl.isError, true); // non-http(s) refused at write time
  const r = await tool.execute('c', {
    action: 'create', command: 'x', every_seconds: 120,
    webhook_url: 'https://ops.example.com/hook', webhook_token_env: 'WH_TOK',
  });
  assert.match(r.content[0].text, /scheduled sch-/);
  const rec = store.list().find((s) => s.id === r.details.id);
  assert.equal(rec.webhook.url, 'https://ops.example.com/hook');
  assert.equal(rec.webhook.token_env, 'WH_TOK');
  const list = await tool.execute('c', { action: 'list' });
  assert.match(list.content[0].text, /→webhook/);
  // edit: clear then re-set
  const clr = await tool.execute('c', { action: 'edit', id: rec.id, webhook_clear: true });
  assert.match(clr.content[0].text, /edited/);
  assert.equal(store.list()[0].webhook, null);
  const conflict = await tool.execute('c', { action: 'edit', id: rec.id, webhook_clear: true, webhook_url: 'https://x' });
  assert.equal(conflict.isError, true);
});

test('#1754: model pin persists on prompt schedules; command target refused', async () => {
  const { dir } = rig();
  const store = new ScheduleStore(dir);
  const tool = scheduleTool(store);

  // prompt target accepts and persists the pin
  const r = await tool.execute('c', { action: 'create', prompt: 'nightly digest', every_seconds: 120, model: 'openai/gpt-x' });
  assert.match(r.content[0].text, /scheduled sch-/);
  const rec = store.list().find((s) => s.id === r.details.id);
  assert.equal(rec.model, 'openai/gpt-x');
  const list = await tool.execute('c', { action: 'list' });
  assert.match(list.content[0].text, /→openai\/gpt-x/);

  // command target + model = honest refusal, nothing persisted
  const refused = await tool.execute('c', { action: 'create', command: 'echo hi', every_seconds: 120, model: 'openai/gpt-x' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /model pin requires a prompt target/);
  assert.equal(store.list().length, 1);

  // edit: set on a bare entry, then clear with empty string
  const r2 = await tool.execute('c', { action: 'create', prompt: 'tick', every_seconds: 120 });
  const e = await tool.execute('c', { action: 'edit', id: r2.details.id, model: 'anthropic/claude-y' });
  assert.match(e.content[0].text, /edited/);
  assert.equal(store.list().find((s) => s.id === r2.details.id).model, 'anthropic/claude-y');
  const clr = await tool.execute('c', { action: 'edit', id: r2.details.id, model: '' });
  assert.match(clr.content[0].text, /edited/);
  assert.equal(store.list().find((s) => s.id === r2.details.id).model, null);

  // editing a command entry to pin a model refuses (final-target check)
  const r3 = await tool.execute('c', { action: 'create', command: 'ls', every_seconds: 120 });
  const bad = await tool.execute('c', { action: 'edit', id: r3.details.id, model: 'openai/gpt-x' });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /model pin requires a prompt target/);
});

test('#1754: pump carries the model pin + schedule id into the sink meta', async () => {
  const { dir, audit } = rig();
  let now = 1_000_000;
  const store = new ScheduleStore(dir, () => now);
  const metas = [];
  const promptSink = async (msg, meta) => { metas.push({ msg, meta }); return { ok: true }; };
  store.add({ prompt: 'digest me', run_at: now - 1000, model: 'openai/gpt-x' });
  const pump = startSchedulerPump({
    store, executor: { spawnCommandJob: async () => { throw new Error('no command fires expected'); } },
    workdir: dir, audit, intervalMs: 60_000, promptSink,
  });
  try {
    await pump.tick();
    assert.equal(metas.length, 1);
    assert.equal(metas[0].msg, 'digest me');
    assert.equal(metas[0].meta.model, 'openai/gpt-x');
    assert.match(metas[0].meta.scheduleId, /^sch-/);
  } finally { pump.dispose(); }
});

test('#1754: sink pins the model for the fired turn, restores after, audits', async () => {
  const audit = { lines: [], write(e) { this.lines.push(e); } };
  const gptx = { provider: 'openai', id: 'gpt-x' };
  const prior = { provider: 'openai', id: 'prior' };
  const seen = [];
  const session = {
    isStreaming: false,
    model: prior,
    modelRuntime: { getModel: (p, m) => (p === 'openai' && m === 'gpt-x' ? gptx : null) },
    setModel: async (m) => { seen.push(m.id); session.model = m; },
  };
  let modelDuringPrompt = null;
  const channelHandle = { channel: { handle: async (ev) => {
    modelDuringPrompt = session.model.id;
    return { success: true };
  } } };
  const sink = schedulePromptSink({ getChannel: () => channelHandle, getSession: () => session, audit });

  const r = await sink('digest', { model: 'openai/gpt-x', scheduleId: 'sch-1' });
  assert.equal(r.ok, true);
  assert.equal(modelDuringPrompt, 'gpt-x', 'turn ran under the pinned model');
  assert.equal(session.model.id, 'prior', 'session model restored after the fire');
  assert.deepEqual(seen, ['gpt-x', 'prior']);
  const pin = audit.lines.find((l) => l.kind === 'SCHEDULE_MODEL_PIN');
  assert.deepEqual(pin.data, { scheduleId: 'sch-1', model: 'openai/gpt-x' });

  // restore still happens when the prompt itself is refused
  session.model = prior; seen.length = 0;
  const fail = { channel: { handle: async () => ({ success: false, error: 'boom' }) } };
  const r2 = await schedulePromptSink({ getChannel: () => fail, getSession: () => session, audit })('x', { model: 'openai/gpt-x', scheduleId: 'sch-2' });
  assert.equal(r2.refused, 'boom');
  assert.equal(session.model.id, 'prior', 'model restored even on refused prompt');
});

test('#1754: sink refuses honestly — unregistered model and busy session stay due', async () => {
  const audit = { write() {} };
  const channelHandle = { channel: { handle: async () => ({ success: true }) } };
  const session = {
    isStreaming: false, model: { provider: 'openai', id: 'cur' },
    modelRuntime: { getModel: () => null },
    setModel: async () => { throw new Error('never called'); },
  };
  const sink = schedulePromptSink({ getChannel: () => channelHandle, getSession: () => session, audit });
  const r = await sink('x', { model: 'openai/nope', scheduleId: 'sch-9' });
  assert.match(r.refused, /not registered/);

  const busy = schedulePromptSink({ getChannel: () => channelHandle, getSession: () => ({ ...session, isStreaming: true }), audit });
  assert.equal((await busy('x', { model: 'openai/gpt-x' })).refused, 'busy');

  // no model pin → straight governed prompt, no setModel calls
  let calls = 0;
  const s2 = { isStreaming: false, model: { id: 'cur' }, modelRuntime: { getModel: () => { throw new Error('unused'); } }, setModel: async () => { calls++; } };
  const r3 = await schedulePromptSink({ getChannel: () => channelHandle, getSession: () => s2, audit })('x', { model: null });
  assert.equal(r3.ok, true);
  assert.equal(calls, 0);
});
