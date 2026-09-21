import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { skillTools } from '../src/adapter/skilltools.js';
import { loadMicroagents, matchMicroagents } from '../../host/src/core/microagents.js';

const fixture = () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pai-skill-'));
  const audits = [];
  const tools = skillTools({ workdir, audit: { write: (e) => audits.push(e) } });
  return { workdir, audits, byName: Object.fromEntries(tools.map((t) => [t.name, t])) };
};

test('skill_save writes a loadable microagent file with trigger frontmatter', async () => {
  const { workdir, audits, byName } = fixture();
  const r = await byName.skill_save.execute('t1', {
    name: 'deploy-checks',
    triggers: ['deploy', '发布'],
    body: '发布前必须跑全量测试并核对迁移清单。',
  });
  assert.equal(r.isError, undefined);
  const file = join(workdir, '.pai', 'microagents', 'deploy-checks.md');
  assert.ok(existsSync(file));
  const raw = readFileSync(file, 'utf-8');
  assert.match(raw, /^---\ntriggers: deploy, 发布\n---/);
  // and the loader actually activates it
  const agents = loadMicroagents(workdir);
  assert.equal(agents.length, 1);
  assert.equal(matchMicroagents(agents, '准备 deploy 了').length, 1);
  assert.equal(matchMicroagents(agents, ' unrelated topic').length, 0);
  assert.equal(audits[0].kind, 'SKILL_SAVED');
});

test('skill_save rejects bad names and empty payloads', async () => {
  const { byName } = fixture();
  assert.equal((await byName.skill_save.execute('t', { name: '../evil', triggers: ['x'], body: 'b' })).isError, true);
  assert.equal((await byName.skill_save.execute('t', { name: 'ok', triggers: [], body: 'b' })).isError, true);
  assert.equal((await byName.skill_save.execute('t', { name: 'ok', triggers: ['x'], body: '  ' })).isError, true);
});

test('plan_save + plan_list round-trip the plans library', async () => {
  const { workdir, audits, byName } = fixture();
  assert.match((await byName.plan_list.execute('t', {})).content[0].text, /no saved plans/);
  await byName.plan_save.execute('t', { name: 'migrate-db', plan: '# DB 迁移\n1. 备份\n2. 跑迁移' });
  assert.ok(existsSync(join(workdir, '.pai', 'plans', 'migrate-db.md')));
  const list = await byName.plan_list.execute('t', {});
  assert.match(list.content[0].text, /migrate-db: # DB 迁移/);
  assert.equal(audits[0].kind, 'PLAN_SAVED');
});

test('recipe_run expands {{param}} placeholders; missing required refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-recipe-'));
  mkdirSync(join(dir, '.pai', 'recipes'), { recursive: true });
  writeFileSync(join(dir, '.pai', 'recipes', 'deploy.md'),
    '---\ndescription: ship it\nparams: env(required), tag=v1\n---\nDeploy {{env}} with tag {{tag}} now.');
  const tools = skillTools({ workdir: dir, audit: null });
  const recipe = tools.find((t) => t.name === 'recipe_run');
  // missing required param → error naming it
  const bad = await recipe.execute('t1', { name: 'deploy', args: {} });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /env/);
  // defaults fill; explicit args win; body wrapped in <recipe>
  const good = await recipe.execute('t2', { name: 'deploy', args: { env: 'prod' } });
  assert.match(good.content[0].text, /<recipe name="deploy">/);
  assert.match(good.content[0].text, /Deploy prod with tag v1 now/);
  // unknown recipe → error
  const miss = await recipe.execute('t3', { name: 'nope' });
  assert.equal(miss.isError, true);
});

test('skill_delete removes only .pai/microagents files, audited', async () => {
  const { workdir, audits, byName } = fixture();
  await byName.skill_save.execute('t', { name: 'deploy-notes', triggers: ['deploy'], body: 'ship it' });
  assert.equal(existsSync(join(workdir, '.pai', 'microagents', 'deploy-notes.md')), true);
  const r = await byName.skill_delete.execute('t', { name: 'deploy-notes' });
  assert.equal(r.isError, undefined);
  assert.equal(existsSync(join(workdir, '.pai', 'microagents', 'deploy-notes.md')), false);
  assert.equal(audits.at(-1).kind, 'SKILL_DELETED');
  // unknown + bad names refuse; plans/ files untouchable
  assert.equal((await byName.skill_delete.execute('t', { name: 'nope' })).isError, true);
  assert.equal((await byName.skill_delete.execute('t', { name: '../x' })).isError, true);
});

test('M91: missing required params ask the operator per-param; denial aborts honestly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-recipe-'));
  mkdirSync(join(dir, '.pai', 'recipes'), { recursive: true });
  writeFileSync(join(dir, '.pai', 'recipes', 'deploy.md'),
    '---\nparams: env(required), tag=latest\n---\nDeploy {{env}} with tag {{tag}}');
  const asked = [];
  const asks = { ask: async (p) => { asked.push(p.summary); return p.summary?.includes('env') ? 'prod' : 'deny'; } };
  const tools = skillTools({ workdir: dir, audit: null, getAsks: () => asks });
  const recipe = tools.find((t) => t.name === 'recipe_run');
  // answered param fills the placeholder
  const r = await recipe.execute('c1', { name: 'deploy' });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /Deploy prod with tag latest/);
  assert.equal(asked.length, 1);
  // denied answer aborts the expansion — no partial recipe text
  const denied = { ask: async () => 'deny' };
  const tools2 = skillTools({ workdir: dir, audit: null, getAsks: () => denied });
  const r2 = await tools2.find((t) => t.name === 'recipe_run').execute('c2', { name: 'deploy' });
  assert.equal(r2.isError, true);
  assert.match(r2.content[0].text, /unanswered/);
  // no ask channel → plain refusal, unchanged behavior
  const tools3 = skillTools({ workdir: dir, audit: null });
  const r3 = await tools3.find((t) => t.name === 'recipe_run').execute('c3', { name: 'deploy' });
  assert.equal(r3.isError, true);
  assert.match(r3.content[0].text, /missing required params/);
});
