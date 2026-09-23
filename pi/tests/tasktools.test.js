import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore } from '../../host/src/core/tasks.js';
import { taskTools } from '../src/adapter/tasktools.js';

const mk = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-tasktools-'));
  return { store: new TaskStore(dir), tools: taskTools(new TaskStore(dir)) };
};
const call = (tools, name, p) => tools.find((t) => t.name === name).execute('c1', p);
const body = (r) => r.content[0].text;

// candidates-open dedup-h #6: team roster + broadcast — the Team feature's
// assignment/message-passing core over the existing mailbox primitive.
test('team_msg broadcasts to every open roster member; closed members skipped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-tasktools-'));
  const store = new TaskStore(dir);
  const tools = taskTools(store);
  const a = store.create({ label: 'a', name: 'alpha', team: 'core' });
  const b = store.create({ label: 'b', name: 'beta', team: 'core' });
  const c = store.create({ label: 'c', team: 'other' });
  const d = store.create({ label: 'd', team: 'core' });
  store.setState(d.task_id, 'closed');

  const r = await call(tools, 'team_msg', { team: 'core', message: 'standup in 5' });
  assert.match(body(r), /2\/2 members/, 'fanout reports delivered/roster');
  // each open member got its own inbox row tagged with the team
  for (const t of [a, b]) {
    const inbox = store.read(t.task_id, 'inbox');
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].body, 'standup in 5');
    assert.equal(inbox[0].team, 'core');
  }
  assert.equal(store.read(c.task_id, 'inbox').length, 0, 'other team untouched');
  assert.equal(store.read(d.task_id, 'inbox').length, 0, 'closed member skipped');
  // each member records the broadcast event
  assert.ok(store.read(a.task_id, 'events').some((e) => e.kind === 'team_msg'));

  const empty = await call(tools, 'team_msg', { team: 'ghost', message: 'x' });
  assert.equal(empty.isError, true);
  assert.match(body(empty), /no open tasks/);
});

test('task_list filters by team and exposes roster fields', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-tasktools-'));
  const store = new TaskStore(dir);
  const tools = taskTools(store);
  store.create({ label: 'a', name: 'alpha', team: 'core' });
  store.create({ label: 'b', team: 'ops' });
  store.create({ label: 'c' });

  const all = JSON.parse(body(await call(tools, 'task_list', {})));
  assert.equal(all.length, 3);
  assert.equal(all.find((t) => t.label === 'a').team, 'core');
  assert.equal(all.find((t) => t.label === 'a').name, 'alpha');

  const core = JSON.parse(body(await call(tools, 'task_list', { team: 'Core' })));
  assert.equal(core.length, 1, 'team filter is case-insensitive');
  assert.equal(core[0].label, 'a');

  const none = await call(tools, 'task_list', { team: 'ghost' });
  assert.match(body(none), /no tasks in team 'ghost'/);
});
