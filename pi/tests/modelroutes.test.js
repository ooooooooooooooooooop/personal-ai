/**
 * Model routing — operator-declared model-routes.json: loader validation,
 * first-match resolution, and delegate_task integration (precedence
 * profile > route > default; routed_via transparency in the result).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModelRoutes, resolveRoute } from '../src/adapter/modelroutes.js';

const dir = () => mkdtempSync(join(tmpdir(), 'pai-routes-'));

test('loader: absent/invalid file → no routing; invalid rules drop individually', () => {
  assert.equal(loadModelRoutes(dir()), null); // no file
  const bad = dir();
  writeFileSync(join(bad, 'model-routes.json'), '{not json');
  assert.equal(loadModelRoutes(bad), null);

  const d = dir();
  writeFileSync(join(d, 'model-routes.json'), JSON.stringify({
    default: { model: 'claude-sonnet-5', effort: 'medium' },
    routes: [
      { name: 'ok', task: 'review', model: 'claude-opus-5' },
      { name: 'bad-regex', task: '([', model: 'x' },        // dropped
      { name: 'sets-nothing', task: 'y' },                   // dropped
      'not-an-object',                                       // dropped
      { task: 'fetch|抓取', effort: 'LOW' },                  // unnamed → route-N; effort normalized
    ],
  }));
  const cfg = loadModelRoutes(d);
  assert.equal(cfg.routes.length, 2);
  assert.equal(cfg.routes[1].name, 'route-4'); // name falls back to the raw array index
  assert.equal(cfg.routes[1].effort, 'low');
  assert.deepEqual(cfg.default, { model: 'claude-sonnet-5', effort: 'medium' });
});

test('resolveRoute: first match wins; conditions are conjunctive; default is the floor', () => {
  const cfg = {
    default: { model: 'def-model', effort: null },
    routes: [
      { name: 'needs-profile', profile: 'auditor', target: null, taskRe: null, model: 'p-model', effort: null },
      { name: 'deep-review', profile: null, target: null, taskRe: /review|审查/i, model: 'r-model', effort: 'high' },
      { name: 'any', profile: null, target: null, taskRe: null, model: 'any-model', effort: null },
    ],
  };
  // profile-conditioned rule misses when no profile was used; task regex hits
  assert.deepEqual(resolveRoute(cfg, { task: '请审查这段代码' }),
    { model: 'r-model', effort: 'high', via: 'deep-review' });
  // with the profile, the FIRST rule wins even though later rules also match
  assert.equal(resolveRoute(cfg, { profile: 'auditor', task: '审查' }).via, 'needs-profile');
  // conjunctive: target condition fails → falls through to the catch-all
  assert.equal(resolveRoute(cfg, { profile: 'auditor', target: 'codex', task: 'x' }).via, 'needs-profile');
  assert.equal(resolveRoute(cfg, { profile: 'auditor', target: 'pai', task: 'x' }).via, 'needs-profile');
  const miss = { ...cfg, routes: [{ name: 'tp', profile: null, target: 'other', taskRe: null, model: 'm', effort: null }] };
  assert.equal(resolveRoute(miss, { profile: 'auditor', target: 'pai' }).via, 'default');
  // no rule matches and no default → nothing
  assert.equal(resolveRoute({ default: null, routes: miss.routes }, { target: 'pai' }), null);
});

test('delegate integration: routes fill profile-open slots; precedence profile > route > default', async () => {
  const { delegateTool } = await import('../src/adapter/delegate.js');
  const spawned = [];
  const executor = { spawnCommandJob: async (spec) => { spawned.push(spec.command); return { job_id: 'j1', attempt_id: 'a1' }; } };
  const seen = [];
  const commandFor = (t, task, { model, effort } = {}) => {
    seen.push({ model, effort });
    return { command: `node pai-channel.js --serve --model ${model ?? 'none'} --effort ${effort ?? 'none'}`, enforceable: true };
  };
  const routes = {
    default: { model: 'claude-sonnet-5', effort: null },
    routes: [{ name: 'deep-review', profile: null, target: null, taskRe: /审查|review/i, model: 'claude-opus-5', effort: 'high' }],
  };
  const profiles = new Map([
    ['pinned', { name: 'pinned', target: 'pai', preamble: '', model: 'profile-model' }],
    ['open', { name: 'open', target: 'pai', preamble: '' }],
  ]);
  const tool = delegateTool(executor, { commandFor, workdir: dir(), profiles, routes });

  // 1. bare target + task matching the rule → route supplies model AND effort
  const r1 = await tool.execute('c1', { target: 'pai', task: '审查这个改动' });
  assert.ok(!r1.isError, JSON.stringify(r1));
  assert.deepEqual(seen.at(-1), { model: 'claude-opus-5', effort: 'high' });
  assert.equal(r1.details.routed_via, 'deep-review');

  // 2. profile with its own model: route supplies ONLY the open effort slot
  const r2 = await tool.execute('c2', { profile: 'pinned', task: '审查这个' });
  assert.deepEqual(seen.at(-1), { model: 'profile-model', effort: 'high' });
  assert.equal(r2.details.routed_via, 'deep-review');

  // 3. nothing matches → the default block fills model
  const r3 = await tool.execute('c3', { profile: 'open', task: 'unrelated work' });
  assert.deepEqual(seen.at(-1), { model: 'claude-sonnet-5', effort: null });
  assert.equal(r3.details.routed_via, 'default');

  // 4. no routes configured at all → no model slots, no routed_via key
  const plain = delegateTool(executor, { commandFor, workdir: dir(), profiles });
  const r4 = await plain.execute('c4', { profile: 'open', task: '审查这个' });
  assert.deepEqual(seen.at(-1), { model: null, effort: null });
  assert.equal(r4.details.routed_via, undefined);
});

test('#2118 adaptive flag: loadModelRoutes surfaces {adaptive:true}, absent/false stays off', () => {
  const d = mkdtempSync(join(tmpdir(), 'pai-routes-ad-'));
  writeFileSync(join(d, 'model-routes.json'), JSON.stringify({
    adaptive: true,
    default: { model: 'claude-sonnet-5' },
    routes: [{ name: 'r', task: 'x', model: 'm' }],
  }));
  const cfg = loadModelRoutes(d);
  assert.equal(cfg.adaptive, true);

  writeFileSync(join(d, 'model-routes.json'), JSON.stringify({ default: { model: 'm' } }));
  assert.equal(loadModelRoutes(d).adaptive, false, 'flag absent = adaptive off');
});
