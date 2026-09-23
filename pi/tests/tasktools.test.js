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

// dedup-h #91: teammate idle awareness — presence derives from the bound
// job's real state; task_status answers by id or name.
test('M91-presence: task_list/task_status report idle/busy/offline from job state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-tasktools-'));
  const store = new TaskStore(dir);
  const jobs = { 'job-run': 'RUNNING', 'job-done': 'COMPLETED', 'job-queued': 'QUEUED' };
  const tools = taskTools(store, { jobState: (id) => jobs[id] ?? null });
  const busy = store.create({ label: 'busy', name: 'busy-bee', jobId: 'job-run' });
  const queued = store.create({ label: 'queued', jobId: 'job-queued' });
  const idle = store.create({ label: 'idle', jobId: 'job-done' });
  const unbound = store.create({ label: 'unbound' });
  const off = store.create({ label: 'off', jobId: 'job-run' });
  store.setState(off.task_id, 'closed');

  const rows = JSON.parse(body(await call(tools, 'task_list', {})));
  const by = (l) => rows.find((t) => t.label === l);
  assert.equal(by('busy').presence, 'busy');
  assert.equal(by('queued').presence, 'busy');   // queued job is still live
  assert.equal(by('idle').presence, 'idle');     // terminal job
  assert.equal(by('unbound').presence, 'idle');  // open, no job
  assert.equal(by('off').presence, 'offline');   // closed trumps live job
  assert.equal(by('busy').job_state, 'RUNNING');

  // task_status by name + by id
  const s = JSON.parse(body(await call(tools, 'task_status', { name: 'busy-bee' })));
  assert.equal(s.presence, 'busy');
  assert.equal(s.task_id, busy.task_id);
  const s2 = JSON.parse(body(await call(tools, 'task_status', { task_id: off.task_id })));
  assert.equal(s2.presence, 'offline');
  const miss = await call(tools, 'task_status', { task_id: 'task-nope' });
  assert.equal(miss.isError, true);

  // last_activity reflects the newest outbox/event row the child emitted
  store.postOutbox(idle.task_id, { kind: 'result', body: 'done' });
  const s3 = JSON.parse(body(await call(tools, 'task_status', { task_id: idle.task_id })));
  assert.ok(s3.last_activity, 'activity stamp present after child output');
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

// dedup-h #258: workflow tool — whole-plan validation, then per-step
// admission through the real delegate path with dep ids → job ids.
test('workflow: plan validation + topo admission + honest stop on refusal', async () => {
  const { workflowTool } = await import('../src/adapter/delegate.js');
  const calls = [];
  let n = 0;
  const delegate = {
    execute: async (_id, p) => {
      calls.push(p);
      if (p.task === 'BOOM') return { isError: true, content: [{ type: 'text', text: 'delegation refused: budget gate' }], details: { refused: true } };
      return { content: [{ type: 'text', text: 'ok' }], details: { job_id: `job-${++n}`, task_id: `t-${n}` } };
    },
  };
  const wf = workflowTool(delegate);

  // bad plans refuse BEFORE any admission
  for (const [steps, reason] of [
    [[{ id: 'a', task: 'x', depends_on: ['ghost'] }], 'unknown_dependency'],
    [[{ id: 'a', task: 'x', depends_on: ['a'] }], 'self_dependency'],
    [[{ id: 'a', task: 'x' }, { id: 'a', task: 'y' }], 'duplicate_step_id'],
    [[{ id: 'a', task: 'x', depends_on: ['b'] }, { id: 'b', task: 'y', depends_on: ['a'] }], 'cyclic_plan'],
    [[{ id: 'a', task: '  ' }], 'empty_task'],
  ]) {
    const r = await wf.execute('tc', { steps });
    assert.equal(r.details.reason, reason, JSON.stringify(steps));
    assert.equal(calls.length, 0, `no admission on ${reason}`);
  }

  // linear chain: dep id rewritten to admitted job id, team shared
  const ok = await wf.execute('tc', {
    name: 'build',
    steps: [
      { id: 'design', task: 'design it', profile: 'p1' },
      { id: 'impl', task: 'implement', depends_on: ['design'] },
      { id: 'verify', task: 'verify', depends_on: ['impl'], worktree: true },
    ],
  });
  assert.equal(ok.details.workflow.slice(0, 3), 'wf-');
  assert.match(ok.details.team, /^wf-\w+-build$/);
  assert.deepEqual(calls.map((c) => c.task), ['design it', 'implement', 'verify']);
  assert.deepEqual(calls[1].depends_on, ['job-1'], 'dep id → job id');
  assert.deepEqual(calls[2].depends_on, ['job-2']);
  assert.ok(calls.every((c) => c.team === ok.details.team), 'shared wf team');
  assert.equal(calls[2].worktree, true);

  // refusal mid-plan stops submission and names admitted jobs
  calls.length = 0; n = 0;
  const stop = await wf.execute('tc', { steps: [{ id: 'one', task: 'go' }, { id: 'two', task: 'BOOM' }, { id: 'three', task: 'never' }] });
  assert.equal(stop.details.reason, 'step_refused');
  assert.equal(stop.details.step, 'two');
  assert.equal(calls.length, 2, 'third step never submitted');
  assert.match(stop.content[0].text, /one → job-1/);
});
