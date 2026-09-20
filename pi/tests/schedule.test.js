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
