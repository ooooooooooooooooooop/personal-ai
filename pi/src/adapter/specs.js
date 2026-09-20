/**
 * spec pipeline (G11 thin SDD) — Kiro/CodeArts-style artifact flow:
 * .pai/specs/<name>/{spec.md, design.md, tasks.md} with phase discipline.
 *
 * Thin by design: the MODEL writes the docs through the ordinary governed
 * write/edit tools (so every artifact is backed up, secret-scanned, and
 * policy-gated for free). These two tools only do what the model can't
 * do safely by itself: scaffold the triple consistently and report
 * machine-derived phase/task status so progress is auditable state, not
 * claimed prose. Phase confirmation gates ride the existing operator-ask
 * surface when policy requires it — no parallel approval channel.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SPEC_MD = (name) => `# ${name} — requirements

> Write requirements as verifiable statements. EARS style preferred:
> "When <trigger>, the system shall <response>" / "The system shall <invariant>".

## Requirements

- [ ] R1:

## Acceptance criteria

- [ ] AC1:
`;

const DESIGN_MD = `# design

## Approach

## Interfaces

## Risks / decisions
`;

const TASKS_MD = `# tasks

> Ordered checklist — the executor marks [x] as items land.
> Group by dependency wave when ordering matters.

- [ ] T1:
`;

const ok = (text, details) => ({ content: [{ type: 'text', text }], details });
const err = (text) => ({ content: [{ type: 'text', text }], isError: true });

function specDir(workdir, name) {
  return join(workdir, '.pai', 'specs', name);
}

function validName(name) {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name ?? '');
}

function statusOf(dir) {
  const name = dir.split(/[\\/]/).pop();
  const scaffold = { 'spec.md': SPEC_MD(name), 'design.md': DESIGN_MD, 'tasks.md': TASKS_MD };
  const files = { 'spec.md': null, 'design.md': null, 'tasks.md': null };
  for (const f of Object.keys(files)) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf-8');
    // "written" means content beyond the scaffold — comparing to the
    // template, not a size heuristic: an untouched scaffold is phase-not-done.
    files[f] = { bytes: text.length, nonempty: text.trim() !== scaffold[f].trim() };
  }
  let tasks = null;
  const tp = join(dir, 'tasks.md');
  if (existsSync(tp)) {
    const text = readFileSync(tp, 'utf-8');
    const total = (text.match(/- \[[ x]\]/g) ?? []).length;
    const done = (text.match(/- \[x\]/gi) ?? []).length;
    tasks = { total, done };
  }
  // phase derivation: requirements written → design written → tasks tracked
  const phase = !files['spec.md']?.nonempty ? 'requirements'
    : !files['design.md']?.nonempty ? 'design'
    : !files['tasks.md'] ? 'tasks'
    : tasks && tasks.total > 0 && tasks.done === tasks.total ? 'complete' : 'executing';
  return { files, tasks, phase };
}

export function specTools({ getWorkdir }) {
  const specInit = {
    name: 'spec_init',
    label: 'Init Spec',
    description:
      'Start a spec-driven task: scaffold .pai/specs/<name>/ with spec.md ' +
      '(requirements), design.md, tasks.md. Use for multi-step work that ' +
      'needs agreed requirements before implementation. After init, write ' +
      'requirements into spec.md, then confirm with the operator before ' +
      'moving to design.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'kebab-case spec name' } },
      required: ['name'],
    },
    async execute(id, params) {
      const name = String(params.name ?? '');
      if (!validName(name)) return err('spec_init: name must be 1-64 chars of [a-zA-Z0-9_.-], starting alphanumeric');
      const dir = specDir(getWorkdir(), name);
      if (existsSync(dir)) return err(`spec '${name}' already exists at ${dir}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'spec.md'), SPEC_MD(name));
      writeFileSync(join(dir, 'design.md'), DESIGN_MD);
      writeFileSync(join(dir, 'tasks.md'), TASKS_MD);
      return ok(`spec '${name}' initialized at ${dir}\nnext: fill spec.md requirements → operator confirm → design.md → tasks.md`);
    },
  };

  const specStatus = {
    name: 'spec_status',
    label: 'Spec Status',
    description:
      'Report spec pipeline state: which phase each spec is in ' +
      '(requirements → design → tasks → executing → complete) and task ' +
      'checkbox counts. Call with no name to list all specs.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'spec name; omit to list all' } },
    },
    async execute(id, params) {
      const root = join(getWorkdir(), '.pai', 'specs');
      const name = params.name ? String(params.name) : null;
      if (name) {
        if (!validName(name)) return err(`spec_status: invalid name '${name}'`);
        const dir = specDir(getWorkdir(), name);
        if (!existsSync(dir)) return err(`no spec '${name}' — spec_init first`);
        const s = statusOf(dir);
        return ok([
          `spec '${name}' — phase: ${s.phase}`,
          `  spec.md:   ${s.files['spec.md'] ? (s.files['spec.md'].nonempty ? 'written' : 'scaffold only') : 'missing'}`,
          `  design.md: ${s.files['design.md'] ? (s.files['design.md'].nonempty ? 'written' : 'scaffold only') : 'missing'}`,
          `  tasks.md:  ${s.tasks ? `${s.tasks.done}/${s.tasks.total} done` : 'missing'}`,
        ].join('\n'), { name, ...s });
      }
      if (!existsSync(root)) return ok('no specs yet — spec_init <name> to start a spec-driven task');
      const rows = readdirSync(root)
        .filter((e) => statSync(join(root, e)).isDirectory())
        .map((e) => {
          const s = statusOf(join(root, e));
          const t = s.tasks ? ` ${s.tasks.done}/${s.tasks.total} tasks` : '';
          return `${e}: ${s.phase}${t}`;
        });
      return ok(rows.length ? rows.join('\n') : 'no specs yet');
    },
  };

  return [specInit, specStatus];
}
