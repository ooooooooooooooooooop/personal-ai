/**
 * AgentTask mailbox (F-family) — seq/ack streams, state machine, wait.
 */
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore } from '../src/core/tasks.js';

const mk = () => {
  const root = mkdtempSync(join(tmpdir(), 'pai-tasks-'));
  return { store: new TaskStore(root), root };
};

test('create/get/list: meta + stream counts; bindJob links the durable job', () => {
  const { store: s, root } = mk();
  const t = s.create({ label: 'research x', parent: 'sess-1' });
  assert.equal(t.state, 'open');
  assert.equal(t.kind, 'delegation');
  s.bindJob(t.task_id, 'job-abc');
  const g = s.get(t.task_id);
  assert.equal(g.job_id, 'job-abc');
  assert.equal(g.events_count, 2); // task_created + job_bound
  const list = s.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].label, 'research x');
});

test('inbox/outbox seq increments; ack cursor persists in task.json', () => {
  const { store: s, root } = mk();
  const t = s.create({ label: 'x' });
  const r1 = s.postInbox(t.task_id, { body: 'first' });
  const r2 = s.postInbox(t.task_id, { body: 'second' });
  assert.equal(r1.seq, 1);
  assert.equal(r2.seq, 2);
  const rows = s.read(t.task_id, 'inbox', 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, 'second');
  s.ack(t.task_id, 'inbox', 2);
  // a fresh store instance sees the same ack (durable cursor)
  const s2 = new TaskStore(s.dir.replace(/\\tasks$/, ''));
  assert.equal(s2.get(t.task_id).acks.inbox, 2);
  // outbox is the child→parent direction
  s.postOutbox(t.task_id, { from: 'child', body: 'done: 42' });
  assert.equal(s.read(t.task_id, 'outbox')[0].body, 'done: 42');
});

test('closed task refuses inbox posts; streams stay readable', () => {
  const { store: s, root } = mk();
  const t = s.create({ label: 'x' });
  s.setState(t.task_id, 'closed');
  const r = s.postInbox(t.task_id, { body: 'too late' });
  assert.match(r.refused, /closed/);
  assert.ok(existsSync(join(s.dir, t.task_id, 'events.jsonl')));
});

test('waitOutbox: resolves early on new row; times out cleanly', async () => {
  const { store: s, root } = mk();
  const t = s.create({ label: 'x' });
  // early resolve — a row lands mid-wait
  const p = s.waitOutbox(t.task_id, { since: 0, timeoutMs: 3000, intervalMs: 20 });
  await new Promise((r) => setTimeout(r, 50));
  s.postOutbox(t.task_id, { body: 'hello parent' });
  const r = await p;
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].body, 'hello parent');
  // timeout on a quiet task
  const slow = await s.waitOutbox(t.task_id, { since: 99, timeoutMs: 100, intervalMs: 20 });
  assert.equal(slow.timedOut, true);
  assert.deepEqual(slow.rows, []);
});

test('missing task reads empty, never throws', () => {
  const { store: s, root } = mk();
  assert.equal(s.get('task-nope'), null);
  assert.deepEqual(s.read('task-nope', 'inbox'), []);
  assert.equal(s.postInbox('task-nope', { body: 'x' }), null);
});

test('list resolves parent scope → task_id once the child claims its mailbox', () => {
  const { store: s, root } = mk();
  const parent = s.create({ label: 'outer' });
  const child = s.create({ label: 'inner', parent: 'sess-child-42' });
  // unclaimed: parent field stays the raw scope — no false nesting
  let list = s.list();
  assert.equal(list.find((t) => t.task_id === child.task_id).parent_task_id, 'sess-child-42');
  // the child claims: writes run_scope into its own task.json
  const meta = JSON.parse(readFileSync(join(s.dir, child.task_id, 'task.json'), 'utf-8'));
  meta.run_scope = 'sess-child-42';
  writeFileSync(join(s.dir, child.task_id, 'task.json'), JSON.stringify(meta, null, 2));
  // now a grandchild spawned BY that child resolves to it as a real task
  const grand = s.create({ label: 'leaf', parent: 'sess-child-42' });
  list = s.list();
  const g = list.find((t) => t.task_id === grand.task_id);
  assert.equal(g.parent_task_id, child.task_id);
  assert.equal(g.parent_scope, 'sess-child-42'); // raw scope preserved
});
