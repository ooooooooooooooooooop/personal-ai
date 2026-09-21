/**
 * schedule_task tool + scheduler pump — the tool writes the store; the pump
 * fires due entries as durable jobs and only consumes successful spawns.
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ScheduleStore } from '../../host/src/core/scheduler.js';
import { scheduleTool, startSchedulerPump } from '../src/adapter/schedule.js';
import { AuditWriter } from '../../host/src/core/audit.js';

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
