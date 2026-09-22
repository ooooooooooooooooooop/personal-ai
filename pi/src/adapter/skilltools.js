/**
 * Agent-authored project surfaces (OpenClaw skill-creator / WorkBuddy
 * describe-to-skill / Hermes skill_manage / Devin plans analogues):
 *
 *   skill_save  — write a triggered-knowledge file .pai/microagents/<name>.md;
 *                 the body's microagent loader activates it on trigger match
 *                 (self-authored reusable knowledge, not just prompt text)
 *   plan_save   — persist a plan document to .pai/plans/<name>.md (Devin's
 *                 plans library analogue: plans survive the session)
 *   plan_list   — enumerate saved plans so the model/UI can reload them
 *
 * All three are ordinary governed tools: the decide chain admits/denies them
 * like any other call; they never bypass FileOpsGuard territory because
 * .pai/** is agent config surface, not user work files.
 */
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { curateLibrary } from '../../../host/src/core/curator.js';
import { loadMicroagents, matchMicroagents } from '../../../host/src/core/microagents.js';

const ok = (text) => ({ content: [{ type: 'text', text }] });
const err = (text) => ({ content: [{ type: 'text', text }], isError: true });
const SLUG = /^[a-z0-9][a-z0-9_-]{0,60}$/i;
const BODY_CAP = 32 * 1024;

export function skillTools({ workdir, audit, getAsks = null, requestMode = null }) {
  const dir = (kind) => join(workdir, '.pai', kind);
  const write = (kind, name, content) => {
    mkdirSync(dir(kind), { recursive: true });
    const file = join(dir(kind), `${name}.md`);
    writeFileSync(file, content);
    return file;
  };

  return [
    {
      name: 'skill_save',
      label: 'Save Skill',
      description:
        'Create or update a triggered-knowledge skill (.pai/microagents/<name>.md). ' +
        'The skill auto-injects as a <knowledge> block into future prompts that match ' +
        'its triggers. Use to固化 reusable procedures/facts the project will need again.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'kebab-case skill name (a-z0-9_-)' },
          triggers: {
            description: 'words or regex that activate this knowledge',
            anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }],
          },
          body: { type: 'string', description: 'knowledge text injected on trigger match' },
        },
        required: ['name', 'triggers', 'body'],
      },
      async execute(_id, p) {
        const name = String(p?.name ?? '').trim();
        if (!SLUG.test(name)) return err('skill_save: name must be kebab-case (a-z, 0-9, _ or -)');
        const triggers = (Array.isArray(p?.triggers) ? p.triggers : String(p?.triggers ?? '').split(','))
          .map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
        const body = String(p?.body ?? '').trim();
        if (!triggers.length) return err('skill_save: at least one trigger is required');
        if (!body) return err('skill_save: body is required');
        if (body.length > BODY_CAP) return err(`skill_save: body exceeds ${BODY_CAP} chars`);
        const file = write('microagents', name, `---\ntriggers: ${triggers.join(', ')}\n---\n\n${body}\n`);
        audit?.write({ kind: 'SKILL_SAVED', data: { name, triggers: triggers.length } });
        return ok(`skill '${name}' saved to ${file} — activates on: ${triggers.join(', ')}`);
      },
    },
    {
      name: 'skill_delete',
      label: 'Delete Skill',
      description:
        'Remove an agent-authored skill (.pai/microagents/<name>.md). Update is ' +
        'skill_save with the same name; this removes the file entirely.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'skill name to delete' } },
        required: ['name'],
      },
      async execute(_id, p) {
        const name = String(p?.name ?? '').trim();
        if (!SLUG.test(name)) return err('skill_delete: name must be kebab-case (a-z, 0-9, _ or -)');
        const file = join(dir('microagents'), `${name}.md`);
        if (!existsSync(file)) return err(`skill '${name}' not found`);
        rmSync(file);
        audit?.write({ kind: 'SKILL_DELETED', data: { name } });
        return ok(`skill '${name}' deleted`);
      },
    },
    {
      // M110 workshop surface: inspect + dry-run before a save goes live.
      // skill_test runs the SAME matchMicroagents predicate the prompt
      // pipeline uses, so a green test means the trigger really fires.
      name: 'skill_list',
      label: 'List Skills',
      description: 'List agent-authored skills (.pai/microagents/): name, triggers, first line.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const agents = loadMicroagents(workdir);
        if (!agents.length) return ok('no skills (.pai/microagents/ is empty)');
        return ok(agents.map((a) => `- ${a.name}  [${a.triggers.join(', ')}]  ${a.body.split('\n')[0].slice(0, 80)}`).join('\n'));
      },
    },
    {
      name: 'skill_read',
      label: 'Read Skill',
      description: 'Read one skill file in full (.pai/microagents/<name>.md).',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'skill name' } },
        required: ['name'],
      },
      async execute(_id, p) {
        const name = String(p?.name ?? '').trim();
        if (!SLUG.test(name)) return err('skill_read: name must be kebab-case');
        const file = join(dir('microagents'), `${name}.md`);
        if (!existsSync(file)) return err(`skill '${name}' not found`);
        return ok(readFileSync(file, 'utf-8'));
      },
    },
    {
      name: 'skill_test',
      label: 'Test Skill Trigger',
      description:
        'Dry-run a skill trigger set against sample prompt text — reports which ' +
        'trigger fires (or none) using the same matcher the live prompt path ' +
        'uses. Pass `name` to test a saved skill, or `triggers` to test a draft ' +
        'before saving it.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'saved skill name' },
          triggers: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }], description: 'draft trigger set' },
          sample: { type: 'string', description: 'sample prompt text to test against' },
        },
        required: ['sample'],
      },
      async execute(_id, p) {
        const sample = String(p?.sample ?? '');
        if (!sample.trim()) return err('skill_test: sample text is required');
        let triggers = null;
        const name = String(p?.name ?? '').trim();
        if (name) {
          const agent = loadMicroagents(workdir).find((a) => a.name === name);
          if (!agent) return err(`skill '${name}' not found`);
          triggers = agent.triggers;
        } else {
          triggers = (Array.isArray(p?.triggers) ? p.triggers : String(p?.triggers ?? '').split(','))
            .map((t) => String(t).trim()).filter(Boolean);
          if (!triggers.length) return err('skill_test: pass name or triggers');
        }
        const matched = matchMicroagents([{ name: name || '(draft)', triggers, body: 'x' }], sample).length > 0;
        const hits = triggers.filter((t) => {
          try { return new RegExp(t, 'i').test(sample.toLowerCase()); }
          catch { return sample.toLowerCase().includes(t.toLowerCase()); }
        });
        return ok(matched
          ? `MATCH — fires on: ${hits.join(', ')}`
          : `NO MATCH — none of [${triggers.join(', ')}] fire on the sample`);
      },
    },
    {
      name: 'curator_scan',
      label: 'Curate Library',
      description:
        'M136 autonomous curator: score .pai/microagents + .pai/plans and get ' +
        'merge/prune proposals. Advisory only — it never deletes; a prune or ' +
        'merge you agree with still goes through skill_delete (governed, ' +
        'operator-visible) so a curator report cannot self-apply.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const { entries, proposals } = curateLibrary(workdir);
        if (!entries.length) return ok('curator: library empty (.pai/microagents, .pai/plans)');
        const lines = proposals.map((p) => {
          if (p.kind === 'merge') return `merge  ${p.drop} → ${p.keep}  (${p.reason})`;
          if (p.kind === 'prune') return `prune  ${p.target}  (score ${p.score}: ${p.reason})`;
          return `keep   ${p.target}  (score ${p.score})`;
        });
        const act = proposals.filter((p) => p.kind !== 'keep').length;
        return ok(
          `curator: ${entries.length} entries scanned — ${act} proposal(s)\n${lines.join('\n')}` +
          (act ? '\n\nproposals are advisory: apply via skill_delete / skill_save — each rides the governed ask path' : ''),
          // details rides the untrusted-result wrapper like every tool result
        );
      },
    },
    {
      name: 'plan_save',
      label: 'Save Plan',
      description:
        'Persist a plan document to .pai/plans/<name>.md so it survives the session ' +
        'and can be reloaded later (plan library). Use for multi-step work the ' +
        'operator may resume.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'kebab-case plan name' },
          plan: { type: 'string', description: 'the plan document body (markdown)' },
        },
        required: ['name', 'plan'],
      },
      async execute(_id, p) {
        const name = String(p?.name ?? '').trim();
        if (!SLUG.test(name)) return err('plan_save: name must be kebab-case (a-z, 0-9, _ or -)');
        const plan = String(p?.plan ?? '').trim();
        if (!plan) return err('plan_save: plan body is required');
        if (plan.length > BODY_CAP) return err(`plan_save: plan exceeds ${BODY_CAP} chars`);
        const file = write('plans', name, `${plan}\n`);
        audit?.write({ kind: 'PLAN_SAVED', data: { name, chars: plan.length } });
        return ok(`plan '${name}' saved to ${file}`);
      },
    },
    {
      name: 'plan_list',
      label: 'List Plans',
      description: 'List saved plans in .pai/plans/ (name + first line preview).',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const d = dir('plans');
        if (!existsSync(d)) return ok('no saved plans (.pai/plans/ is empty)');
        let rows = [];
        try {
          rows = readdirSync(d).filter((f) => f.endsWith('.md')).map((f) => {
            let first = '';
            try { first = readFileSync(join(d, f), 'utf-8').split('\n').find((l) => l.trim()) ?? ''; }
            catch { /* unreadable file still lists by name */ }
            return `- ${f.replace(/\.md$/, '')}: ${first.slice(0, 100)}`;
          });
        } catch { return ok('no saved plans'); }
        return ok(rows.length ? `saved plans:\n${rows.join('\n')}` : 'no saved plans');
      },
    },
    {
      name: 'recipe_run',
      label: 'Run Recipe',
      description:
        'Expand a parameterised task package (.pai/recipes/<name>.md) and receive ' +
        'its instructions to execute (Roo run_slash_command analogue). Pass ' +
        'args as {k: v}; {{k}} placeholders in the recipe body are substituted. ' +
        'Frontmatter fields: `params:` (required/(default=)) and `mode:` — a ' +
        'mode value requests an operator-approved mode switch when the recipe runs.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'recipe name (file stem under .pai/recipes/)' },
          args: { type: 'object', description: 'parameter values keyed by name' },
        },
        required: ['name'],
      },
      async execute(_id, p) {
        const name = String(p?.name ?? '').trim();
        if (!SLUG.test(name)) return err('recipe_run: name must be kebab-case (a-z, 0-9, _ or -)');
        const file = join(dir('recipes'), `${name}.md`);
        let raw = '';
        try { raw = readFileSync(file, 'utf-8'); } catch { return err(`recipe '${name}' not found in .pai/recipes/`); }
        const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
        const meta = m?.[1] ?? '';
        const body = (m ? m[2] : raw).trim();
        const params = (meta.match(/^params:\s*(.+)$/m)?.[1] ?? '')
          .split(',').map((s) => s.trim()).filter(Boolean).map((spec) => {
            const req = spec.match(/^(\w+)\(required\)$/);
            if (req) return { name: req[1], required: true };
            const d = spec.match(/^(\w+)=(.*)$/);
            return d ? { name: d[1], default: d[2] } : { name: spec, required: true };
          });
        const args = p?.args && typeof p.args === 'object' ? { ...p.args } : {};
        const missing = params.filter((x) => x.required && args[x.name] == null).map((x) => x.name);
        // M91 structured form (Automation Blueprints analogue): a recipe
        // invoked without required params asks the operator one card per
        // param instead of refusing outright. No ask channel → same refusal
        // as before; denied/timeout params abort the expansion honestly.
        if (missing.length) {
          const asks = getAsks?.();
          if (!asks) return err(`recipe '${name}' missing required params: ${missing.join(', ')}`);
          for (const pname of missing) {
            const answer = await asks.ask({
              kind: 'question',
              toolName: 'recipe_run',
              toolCallId: _id,
              rule: 'recipe_param',
              summary: `recipe '${name}' 需要参数 ${pname}`,
              options: [],
            });
            if (answer === 'deny' || answer === 'timeout' || answer === 'aborted') {
              return err(`recipe '${name}' aborted: param '${pname}' unanswered (${answer})`);
            }
            args[pname] = answer;
          }
        }
        const values = Object.fromEntries(params.map((x) => [x.name, String(args[x.name] ?? x.default ?? '')]));
        const expanded = body.replace(/\{\{(\w+)\}\}/g, (all, k) => values[k] ?? all);
        audit?.write({ kind: 'RECIPE_RUN', data: { name, params: Object.keys(values).length } });
        // M131: frontmatter `mode: <name>` requests a governed mode switch on
        // trigger (Claude command frontmatter analogue). The switch goes
        // through the operator ask card — a recipe file can never force a
        // posture change; refusal is reported honestly alongside the recipe.
        const wantedMode = (meta.match(/^mode:\s*(\S+)\s*$/m)?.[1] ?? '').trim();
        let modeNote = '';
        if (wantedMode) {
          if (!requestMode) {
            modeNote = `\n[recipe requested mode '${wantedMode}' — no mode channel on this body]`;
          } else {
            const r = await requestMode(wantedMode, _id);
            audit?.write({ kind: 'RECIPE_MODE', data: { name, mode: wantedMode, ok: r.ok } });
            modeNote = `\n[mode '${wantedMode}': ${r.text}]`;
          }
        }
        // instructions arrive as untrusted recipe content — the model follows
        // them inside the normal governance chain like any microagent body
        return ok(`<recipe name="${name}">\n${expanded}\n</recipe>${modeNote}`);
      },
    },
  ];
}
