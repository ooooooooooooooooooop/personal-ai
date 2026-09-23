/**
 * C1: sessions.list() marks a session claimed by a non-terminal task as
 * `live` so the UI can paint an honest 进行中 dot. Terminal tasks, and
 * sessions no task claims, must not report live.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHost } from '../src/bootstrap/host.js';

const stubModel = {
  id: 'stub', name: 'stub', api: 'openai-completions', provider: 'openai',
  baseUrl: 'http://127.0.0.1:9', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000, maxTokens: 4096,
};

const writeTask = (dir, meta) => {
  const td = join(dir, 'tasks', meta.task_id);
  mkdirSync(td, { recursive: true });
  writeFileSync(join(td, 'task.json'), JSON.stringify({ acks: {}, ...meta }));
};

const writeSession = (dir, sid) => {
  const sd = join(dir, 'sessions');
  mkdirSync(sd, { recursive: true });
  const file = join(sd, `2026-09-23T00-00-00-000Z_${sid}.jsonl`);
  writeFileSync(file,
    `${JSON.stringify({ type: 'session', version: 3, id: sid, timestamp: '2026-09-23T00:00:00Z', cwd: dir })}\n`
    + '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}\n'
    + '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"yo"}]}}\n');
  return file;
};

test('sessions.list: task-bound open session is live; terminal-bound and unbound are not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-live-'));
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  const liveSid = '11111111-2222-3333-4444-555555555555';
  const doneSid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const freeSid = '99999999-8888-7777-6666-555555555555';
  writeSession(dir, liveSid);
  writeSession(dir, doneSid);
  writeSession(dir, freeSid);
  const host = await startHost({
    instanceRoot: dir, workdir: dir, sessionOptions: { model: stubModel },
  });
  try {
    writeTask(dir, {
      task_id: 't-live', state: 'open', kind: 'delegation',
      run_scope: liveSid, created: new Date().toISOString(),
    });
    writeTask(dir, {
      task_id: 't-done', state: 'COMPLETED', kind: 'teammate',
      run_scope: doneSid, created: new Date().toISOString(),
    });

    const rows = await host.channel.sessions.list();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const liveRow = byId.get(liveSid);
    assert.ok(liveRow, 'live session row must exist');
    assert.equal(liveRow.live, true, 'session claimed by an open task is live');
    assert.equal(liveRow.type, 'subagent', 'delegation-bound session keeps the subagent facet');

    const doneRow = byId.get(doneSid);
    assert.ok(doneRow, 'terminal-bound session row must exist');
    assert.equal(doneRow.type, 'teammate');
    assert.notEqual(doneRow.live, true, 'COMPLETED task does not mark its session live');

    const freeRow = byId.get(freeSid);
    assert.ok(freeRow, 'unbound session row must exist');
    assert.equal(freeRow.live, undefined);
    assert.equal(freeRow.type, undefined);
  } finally {
    host.dispose();
  }
});
