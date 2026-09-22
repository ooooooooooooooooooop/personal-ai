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

test('M131: recipe frontmatter mode: requests a governed switch on trigger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-recipe-mode-'));
  mkdirSync(join(dir, '.pai', 'recipes'), { recursive: true });
  writeFileSync(join(dir, '.pai', 'recipes', 'review-first.md'),
    '---\nmode: review\n---\nReview the diff before touching anything.');
  const calls = [];
  const tools = skillTools({
    workdir: dir, audit: { write: (e) => calls.push(e) },
    // host.js wires this to requestModeSwitch — the ask→applyMode chain.
    requestMode: async (name) => name === 'review'
      ? { ok: true, text: `mode switched to 'review'` }
      : { ok: false, text: `unknown mode '${name}'` },
  });
  const recipe = tools.find((t) => t.name === 'recipe_run');
  const r = await recipe.execute('t1', { name: 'review-first' });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /<recipe name="review-first">/);
  assert.match(r.content[0].text, /mode 'review': mode switched to 'review'/);
  assert.ok(calls.some((e) => e.kind === 'RECIPE_MODE' && e.data.mode === 'review' && e.data.ok === true));

  // refusal is reported honestly — the recipe still expands
  const toolsDeny = skillTools({
    workdir: dir, audit: null,
    requestMode: async () => ({ ok: false, text: "mode 'plan' refused (deny) — continue under the current mode" }),
  });
  writeFileSync(join(dir, '.pai', 'recipes', 'plan-mode.md'), '---\nmode: plan\n---\nPlan only.');
  const r2 = await toolsDeny.find((t) => t.name === 'recipe_run').execute('t2', { name: 'plan-mode' });
  assert.equal(r2.isError, undefined);
  assert.match(r2.content[0].text, /refused \(deny\)/);

  // no mode channel → honest note, never silent
  const bare = skillTools({ workdir: dir, audit: null });
  const r3 = await bare.find((t) => t.name === 'recipe_run').execute('t3', { name: 'plan-mode' });
  assert.match(r3.content[0].text, /no mode channel/);

  // recipes without mode: unchanged output shape
  writeFileSync(join(dir, '.pai', 'recipes', 'plain.md'), 'Just do it.');
  const r4 = await bare.find((t) => t.name === 'recipe_run').execute('t4', { name: 'plain' });
  assert.doesNotMatch(r4.content[0].text, /mode/);
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

test('M110 workshop: skill_test dry-runs triggers via the live matcher before save; list/read inspect the library', async () => {
  const audits = [];
  const workdir = mkdtempSync(join(tmpdir(), 'pai-skill-'));
  const tools = skillTools({ workdir, audit: { write: (e) => audits.push(e) } });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  // draft trigger validation — same predicate as the live prompt path
  const hit = await byName.skill_test.execute('t', { triggers: ['deploy', 'release'], sample: 'please deploy the service' });
  assert.match(hit.content[0].text, /MATCH.*deploy/);
  const miss = await byName.skill_test.execute('t', { triggers: ['k8s'], sample: 'run the tests' });
  assert.match(miss.content[0].text, /NO MATCH/);
  const bad = await byName.skill_test.execute('t', { sample: 'x' });
  assert.equal(bad.isError, true, 'no name and no triggers refuses');

  // save → list/read → test by name — the full workshop loop
  await byName.skill_save.execute('t', { name: 'deploy-proc', triggers: ['deploy'], body: 'deploy steps body' });
  const list = await byName.skill_list.execute('t', {});
  assert.match(list.content[0].text, /deploy-proc.*\[deploy\]/);
  const read = await byName.skill_read.execute('t', { name: 'deploy-proc' });
  assert.match(read.content[0].text, /triggers: deploy/);
  const named = await byName.skill_test.execute('t', { name: 'deploy-proc', sample: 'deploy now' });
  assert.match(named.content[0].text, /MATCH/);
  const missing = await byName.skill_test.execute('t', { name: 'ghost', sample: 'x' });
  assert.equal(missing.isError, true);
});
