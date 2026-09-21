/**
 * ScheduleStore — durable schedule truth: due computation, one-shot disable,
 * interval catch-up-once, atomic persistence, caps.
 */
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ScheduleStore, MIN_INTERVAL_SECONDS, MAX_SCHEDULES } from '../src/core/scheduler.js';

const rig = () => mkdtempSync(join(tmpdir(), 'pai-sched-'));

test('one-shot schedule: due at run_at, disables itself after firing', () => {
  let now = 1_000_000;
  const s = new ScheduleStore(rig(), () => now);
  const rec = s.add({ command: 'echo hi', run_at: now + 5000 });
  assert.equal(s.due().length, 0);
  now += 6000;
  assert.deepEqual(s.due().map((x) => x.id), [rec.id]);
  s.markFired(rec.id, 'job-1');
  assert.equal(s.due().length, 0);
  const stored = s.list().find((x) => x.id === rec.id);
  assert.equal(stored.enabled, false);
  assert.equal(stored.lastJobId, 'job-1');
  assert.ok(stored.lastFiredAt);
});

test('interval schedule advances nextRunAt past now; missed slots collapse to one fire', () => {
  let now = 1_000_000;
  const s = new ScheduleStore(rig(), () => now);
  const rec = s.add({ command: 'tick', every_seconds: MIN_INTERVAL_SECONDS });
  now += MIN_INTERVAL_SECONDS * 1000 * 5; // 5 intervals of downtime
  assert.equal(s.due().length, 1); // one due entry, not five
  s.markFired(rec.id, 'j');
  const stored = s.list().find((x) => x.id === rec.id);
  assert.ok(stored.nextRunAt > now); // next slot is in the FUTURE, not replaying
  assert.equal(stored.enabled, true);
});

test('validation: interval floor, bad timestamps, empty command, cap', () => {
  const s = new ScheduleStore(rig());
  assert.throws(() => s.add({ command: 'x', every_seconds: 30 }), /≥ 60/);
  assert.throws(() => s.add({ command: 'x', run_at: 'not a date' }), /timestamp/);
  assert.throws(() => s.add({ command: '  ', run_at: Date.now() }), /non-empty/);
  for (let i = 0; i < MAX_SCHEDULES; i++) s.add({ command: `c${i}`, every_seconds: 60 });
  assert.throws(() => s.add({ command: 'over', every_seconds: 60 }), /cap/);
});

test('remove deletes; unknown id is a polite error', () => {
  const s = new ScheduleStore(rig());
  const rec = s.add({ command: 'x', every_seconds: 60 });
  assert.equal(s.remove('sch-nope').ok, false);
  assert.equal(s.remove(rec.id).ok, true);
  assert.equal(s.list().length, 0);
});

test('persistence: a new store instance sees the same schedules; corrupt file reads empty', async () => {
  const dir = rig();
  const s1 = new ScheduleStore(dir);
  s1.add({ command: 'persist me', every_seconds: 120, label: 'L' });
  const s2 = new ScheduleStore(dir);
  assert.equal(s2.list().length, 1);
  assert.equal(s2.list()[0].label, 'L');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, 'schedules.json'), '{corrupt');
  assert.deepEqual(new ScheduleStore(dir).list(), []);
});

test('prompt-target schedules: validation, goal_id, once/interval timing', () => {
  let now = 1_000_000;
  const s = new ScheduleStore(rig(), () => now);
  assert.throws(() => s.add({}), /command or prompt/);
  assert.throws(() => s.add({ command: 'x', prompt: 'y', run_at: now }), /not both/);
  const rec = s.add({ prompt: 'tick', goal_id: 'goal-1', every_seconds: 120 });
  assert.equal(rec.target, 'prompt');
  assert.equal(rec.command, null);
  assert.equal(rec.goal_id, 'goal-1');
  now += 121_000;
  assert.deepEqual(s.due().map((x) => x.id), [rec.id]);
  s.markFired(rec.id, null);
  assert.equal(s.due().length, 0); // interval advanced past now
});

test('pause/resume: paused entries never go due; resume re-arms intervals', () => {
  let now = 1_000_000;
  const s = new ScheduleStore(rig(), () => now);
  const rec = s.add({ command: 'echo hi', every_seconds: 60 });
  assert.equal(s.setEnabled(rec.id, false).ok, true);
  now += 120_000;
  assert.equal(s.due().length, 0, 'paused schedule is not due');
  assert.equal(s.setEnabled('nope', true).ok, false);
  assert.equal(s.setEnabled(rec.id, true).ok, true);
  assert.equal(s.due().length, 0, 'resume re-anchors from now, no storm-fire');
  now += 61_000;
  assert.deepEqual(s.due().map((x) => x.id), [rec.id]);
});

test('edit: patches command/interval/run_at with validation, identity preserved', () => {
  let now = 1_000_000;
  const s = new ScheduleStore(rig(), () => now);
  const rec = s.add({ command: 'echo hi', every_seconds: 60 });
  assert.match(s.edit(rec.id, { every_seconds: 5 }).error, /60/);
  assert.equal(s.edit('nope', { command: 'x' }).ok, false);
  assert.equal(s.edit(rec.id, { command: 'echo bye', label: 'renamed' }).ok, true);
  const after = s.list().find((x) => x.id === rec.id);
  assert.equal(after.command, 'echo bye');
  assert.equal(after.label, 'renamed');
  assert.equal(after.kind, 'interval');
  // interval→once conversion
  assert.equal(s.edit(rec.id, { run_at: now + 5000 }).ok, true);
  const once = s.list().find((x) => x.id === rec.id);
  assert.equal(once.kind, 'once');
  now += 6000;
  assert.deepEqual(s.due().map((x) => x.id), [rec.id]);
});

test('markSkipped: overdue entry advances without firing (skipMissedJobs)', () => {
  let now = 1_000_000;
  const s = new ScheduleStore(rig(), () => now);
  const rec = s.add({ command: 'echo hi', every_seconds: 60 });
  // three days pass with the machine off — entry is massively overdue
  now += 3 * 24 * 60 * 60 * 1000;
  assert.deepEqual(s.due().map((x) => x.id), [rec.id]);
  const r = s.markSkipped(rec.id);
  assert.equal(r.ok, true);
  const after = s.list().find((x) => x.id === rec.id);
  assert.equal(after.lastFiredAt, null, 'skipped ≠ fired');
  assert.ok(after.lastSkippedAt, 'skip is stamped');
  assert.equal(s.due().length, 0, 'no longer due');
  assert.ok(after.nextRunAt > now, 'advanced to the next slot');
});

test('M135 adaptive rate: quiet ticks stretch interval toward max, real fire resets to base', () => {
  let now = 1_000_000;
  const s = new ScheduleStore(rig(), () => now);
  // base 120s, adaptive bounds 60–960s
  const rec = s.add({ prompt: 'tick', goal_id: 'g1', every_seconds: 120, min_seconds: 60, max_seconds: 960 });
  assert.equal(rec.current_seconds, null);
  assert.equal(rec.quietStreak, 0);
  const get = () => s.list().find((x) => x.id === rec.id);
  // quiet tick 1: effective = min(120*2, 960) = 240
  s.markQuiet(rec.id);
  assert.equal(get().quietStreak, 1);
  assert.equal(get().current_seconds, 240);
  assert.equal(get().nextRunAt, now + 240_000);
  // quiet ticks 2-3: 480 then 960 (capped at max)
  now += 240_000; s.markQuiet(rec.id);
  assert.equal(get().current_seconds, 480);
  now += 480_000; s.markQuiet(rec.id);
  assert.equal(get().current_seconds, 960);
  // quiet tick 4: stays at the cap, does not blow through
  now += 960_000; s.markQuiet(rec.id);
  assert.equal(get().current_seconds, 960);
  assert.equal(get().quietStreak, 4);
  // real fire (world changed) resets to base rate
  now += 960_000; s.markFired(rec.id, null);
  assert.equal(get().current_seconds, null);
  assert.equal(get().quietStreak, 0);
  assert.equal(get().nextRunAt, now + 120_000);
});

test('M135 adaptive validation: partial bounds, non-interval, out-of-range all refused', () => {
  const s = new ScheduleStore(rig());
  assert.throws(() => s.add({ command: 'x', every_seconds: 120, min_seconds: 60 }), /min_seconds ≤ every_seconds ≤ max_seconds/);
  assert.throws(() => s.add({ command: 'x', every_seconds: 120, max_seconds: 600 }), /min_seconds ≤ every_seconds ≤ max_seconds/);
  assert.throws(() => s.add({ command: 'x', run_at: Date.now() + 5000, min_seconds: 60, max_seconds: 600 }), /requires every_seconds/);
  assert.throws(() => s.add({ command: 'x', every_seconds: 120, min_seconds: 30, max_seconds: 600 }), /min_seconds ≤ every_seconds ≤ max_seconds/);
  assert.throws(() => s.add({ command: 'x', every_seconds: 120, min_seconds: 200, max_seconds: 600 }), /min_seconds ≤ every_seconds ≤ max_seconds/);
  assert.throws(() => s.add({ command: 'x', every_seconds: 120, min_seconds: 60, max_seconds: 90 }), /min_seconds ≤ every_seconds ≤ max_seconds/);
});

test('M135: static entries ignore markQuiet (no adaptive bounds configured)', () => {
  let now = 1_000_000;
  const s = new ScheduleStore(rig(), () => now);
  const rec = s.add({ command: 'x', every_seconds: 120 });
  s.markQuiet(rec.id);
  const stored = s.list().find((x) => x.id === rec.id);
  assert.equal(stored.quietStreak, 1, 'streak still tracked for audit');
  assert.equal(stored.current_seconds, null, 'no stretch without min/max');
  assert.equal(stored.nextRunAt, now + 120_000, 'static rate preserved');
});
