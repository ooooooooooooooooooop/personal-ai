/**
 * GoalStore — durable long-horizon goal records: create/list/state, task
 * and schedule binding, scratchpad continuity, tick fingerprinting.
 */
import { mkdtempSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { GoalStore } from '../src/core/goals.js';

const rig = () => mkdtempSync(join(tmpdir(), 'pai-goals-'));

test('create/list/get round-trips; scratchpad file is seeded', () => {
  const dir = rig();
  const g = new GoalStore(dir);
  const goal = g.create({ statement: 'raise coverage to 80%' });
  assert.equal(goal.state, 'open');
  assert.equal(goal.task_ids.length, 0);
  assert.ok(existsSync(join(dir, 'goals', goal.goal_id, 'scratchpad.md')));
  const list = g.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].statement, 'raise coverage to 80%');
  const got = g.get(goal.goal_id);
  assert.match(got.scratchpad, /raise coverage/);
  assert.throws(() => g.create({ statement: '' }), /non-empty/);
});

test('bindTask accumulates without duplicates; bindSchedule links the tick', () => {
  const g = new GoalStore(rig());
  const goal = g.create({ statement: 'x' });
  g.bindTask(goal.goal_id, 'task-1');
  g.bindTask(goal.goal_id, 'task-2');
  g.bindTask(goal.goal_id, 'task-1');
  assert.deepEqual(g.get(goal.goal_id).task_ids, ['task-1', 'task-2']);
  g.bindSchedule(goal.goal_id, 'sch-9');
  assert.equal(g.get(goal.goal_id).schedule_id, 'sch-9');
});

test('note appends to scratchpad; tail is bounded; stat feeds fingerprint', () => {
  const g = new GoalStore(rig());
  const goal = g.create({ statement: 'x' });
  g.note(goal.goal_id, 'tried A — flaky');
  g.note(goal.goal_id, 'next: try B');
  const tail = g.scratchpadTail(goal.goal_id, 60);
  assert.match(tail, /try B/);
  assert.ok(tail.length <= 60);
  const stat1 = g.scratchpadStat(goal.goal_id);
  g.note(goal.goal_id, 'more');
  assert.notEqual(g.scratchpadStat(goal.goal_id), stat1);
});

test('setState transitions; touchTick stores fingerprint + timestamp', () => {
  let now = 5_000;
  const g = new GoalStore(rig(), () => now);
  const goal = g.create({ statement: 'x' });
  assert.equal(g.setState(goal.goal_id, 'paused').state, 'paused');
  assert.equal(g.setState(goal.goal_id, 'done').state, 'done');
  assert.equal(g.setState(goal.goal_id, 'weird').error, "bad state 'weird'");
  g.touchTick(goal.goal_id, 'fp-1');
  const meta = g.get(goal.goal_id);
  assert.equal(meta.fingerprint, 'fp-1');
  assert.equal(meta.last_tick_at, new Date(5000).toISOString());
  assert.equal(g.setState('goal-nope', 'done'), null);
});
