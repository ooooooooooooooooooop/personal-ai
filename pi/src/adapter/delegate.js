/**
 * Delegation bridge — Pi has no native MCP, so cross-model delegation is
 * packaged as a customTool backed by a durable job that spawns the configured
 * RPC command (agent-switchboard CLI or any RPC executable).
 *
 * Governance properties:
 *  - the delegate_task tool call itself travels tool_call → composite guard
 *    like every other tool — subagent invocation is NEVER an unguarded path
 *  - the spawned worker is a durable job: survives host restarts, gets the
 *    same lease/checkpoint/recovery treatment as any long command
 *  - usage/cost attribution: the result envelope carries parent_run_id —
 *    delegated work bills to the parent run identity (Hermes pattern)
 */
import { JobExecutor } from './jobs.js';
import { resolveRoute } from './modelroutes.js';
import { scanForSecrets } from './secrets.js';
import { fileURLToPath } from 'node:url';

/** The real usage producer every delegation rides through. */
export const DELEGATE_BRIDGE = fileURLToPath(new URL('../../bin/delegate-bridge.js', import.meta.url));

/**
 * M76/M94-R3: production commandFor builder for `--delegate-command`
 * templates. `{target}/{task}/{model}/{effort}` slots interpolate.
 * `enforceable` is asserted per RESOLVED target, never sniffed from the
 * interpolated command ({task} is model-controlled — `task="inspect
 * pai-channel.js"` must not mint capability on a foreign body):
 *
 *   - template WITH a {target} slot can branch between bodies
 *     (`if [ "{target}" = pai ]; then node pai-channel.js; else codex …`),
 *     so a template-global regex is not evidence — the operator must name
 *     the enforceable resolved targets (`enforceableTargets` set).
 *   - template WITHOUT the slot runs the same body every call, so the
 *     operator-controlled template text itself decides.
 */
export function makeDelegationCommand(template, { enforceableTargets = new Set() } = {}) {
  const tpl = String(template);
  const branches = tpl.includes('{target}');
  return (target, task, opts = {}) => ({
    command: tpl
      .replaceAll('{target}', target)
      .replaceAll('{task}', String(task).replaceAll('"', '\\"'))
      .replaceAll('{model}', opts.model ?? '')
      .replaceAll('{effort}', opts.effort ?? ''),
    enforceable: branches ? enforceableTargets.has(target) : /pai-channel\.js/.test(tpl),
  });
}

/**
 * Build the delegate_task customTool.
 * @param {JobExecutor} executor
 * @param {object} opts
 * @param {(target:string,task:string)=>string} opts.commandFor
 *        maps (target, task) → the delegated shell command the bridge spawns
 *        (e.g. `python -m agent_switchboard send --to ${target} --task ...`)
 * @param {string} opts.workdir
 * @param {string} [opts.bridgePath] override the bridge executable (tests)
 * @param {() => string} [opts.getScope]   session budget scope — delegated
 *        worker usage bills into the parent's budget, never evades the cap
 *        without provable enforcement is refused BEFORE spawn — post-hoc
 *        usage accounting alone cannot bound a child's spend. The child
 *        slice is charged to the parent ledger ATOMICALLY at admission
 *        (commit-on-issue, never auto-refunded) so concurrent delegates
 *        and the parent itself cannot spend the same headroom twice.
 * @param {Map} [opts.profiles]  frontmatter subagent profiles (.pai/agents,
 *        <instance>/agents) — `profile` param resolves target + prepends the
 *        profile preamble to the task
 * @param {{default, routes: Array}} [opts.routes]  operator-declared model
 *        routing (model-routes.json) — fills model/effort slots the profile
 *        left open; precedence profile > route > default
 * @param {TaskStore} [opts.taskStore]  F-family mailbox — when present every
 *        delegation creates a task record and the bridge binds --task-dir,
 *        upgrading the one-shot job to a bidirectional AgentTask.
 */
export function delegateTool(executor, { commandFor, workdir, bridgePath = DELEGATE_BRIDGE, getScope = null, budget = null, profiles = null, routes = null, taskStore = null, envOverlay = null }) {
  return {
    name: 'delegate_task',
    label: 'Delegate Task',
    description:
      'Delegate a task to another agent via the switchboard RPC bridge. ' +
      'Pass a subagent `profile` name (project .pai/agents or instance agents/) ' +
      'to delegate with that persona, or a raw `target` agent id. ' +
      'Omit both for FORK mode — a background subagent inheriting the parent ' +
      'body (target "pai"). ' +
      'Returns immediately with a durable job id; the delegated work survives ' +
      'restarts and its usage is attributed to this run.' +
      (profiles?.size ? ` Available profiles: ${[...profiles.values()].map((p) => `${p.name}→${p.target}${p.description ? ` (${p.description})` : ''}`).join(', ')}` : ''),
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'target agent id (e.g. codex, claude, gemini)' },
        profile: { type: 'string', description: 'named subagent profile — resolves target and prepends its preamble' },
        task: { type: 'string', description: 'task description for the delegate' },
        name: { type: 'string', description: 'optional teammate name — makes the task a named, persistent member of the teammate pool (addressable via teammate_msg)' },
        team: { type: 'string', description: 'optional team name — groups the task under a shared roster (task_list filters by it; team_msg broadcasts to every open member)' },
        max_minutes: { type: 'number', description: 'optional wall-clock ceiling in minutes — the job is killed at the deadline and reported as timed out' },
        worktree: { type: 'boolean', description: 'run inside a detached git worktree — parallel delegates cannot collide on the real checkout; dirty worktrees are kept and reported' },
        depends_on: {
          type: 'array', items: { type: 'string' },
          description: 'job ids that must ALL reach COMPLETED before this delegation starts — the job queues durably and is cancelled if a dependency fails. NOTE: a profile budget slice is charged at admission even while queued.',
        },
      },
      required: ['task'],
    },
    promptSnippet: 'delegate_task(profile|target, task): run a task on another agent as a durable job',
    async execute(_toolCallId, params) {
      // Every delegation goes through the bridge: it spawns the real worker,
      // measures wall time/output, forwards child-reported usage, and emits
      // the single authoritative PAI_USAGE line the executor attributes to
      // parent_run_id. Usage attribution is produced, not hoped for.
      // profile resolution: a named persona maps to its target and prepends
      // its preamble — the delegated worker receives persona + task as one
      let target = params.target;
      let task = String(params.task ?? '');
      let profileEnv = null; // {set, deny} → --env-json on the bridge
      let profileBudget = null; // M94 {tokens,calls,costUsd} → --budget-* flags
      let maxMin = null;
      // CC subagent knobs analogue: profile-declared model/effort fill the
      // operator template's {model}/{effort} slots; isolate_steering blinds
      // the child to workdir steering files via a dedicated bridge flag.
      let profileModel = null; let profileEffort = null; let steeringOff = false;
      let toolsDeny = null; // M76 — dedicated bridge flag, never --env-json
      let mcpDeny = null;   // C3 — same dedicated-flag channel
      if (params.profile != null && params.profile !== '') {
        const p = profiles?.get(String(params.profile).toLowerCase());
        if (!p) {
          const known = profiles?.size ? [...profiles.keys()].join(', ') : 'none';
          return {
            content: [{ type: 'text', text: `unknown subagent profile '${params.profile}' — available: ${known}` }],
            isError: true,
          };
        }
        target = p.target;
        if (p.preamble) task = `${p.preamble}\n\n---\n\n${task}`;
        // OpenHands profile-scoped secrets analogue, inverted for a local
        // single-user harness: the profile narrows/annotates the child env.
        if (p.env || p.envDeny) profileEnv = { set: p.env ?? {}, deny: p.envDeny ?? [] };
        if (p.maxMinutes) maxMin = p.maxMinutes;
        if (p.model) profileModel = p.model;
        if (p.effort) profileEffort = p.effort;
        if (p.isolateSteering) steeringOff = true;
        if (p.toolsDeny?.length) toolsDeny = p.toolsDeny.join(',');
        if (p.mcpDeny?.length) mcpDeny = p.mcpDeny.join(',');
        if (p.budget) profileBudget = p.budget;
      }
      // M43/dedup-h-#43: omitting target AND profile is FORK mode — a
      // background subagent on the same body ('pai' resolves to the
      // pai-channel branch of the operator's delegate template). Fork
      // inherits the parent agent config, not its transcript.
      const forked = !target;
      if (forked) target = 'pai';
      // Operator-declared model routing (model-routes.json): fill the
      // model/effort slots the profile left open — profile frontmatter is
      // more specific than a route, a route more specific than the default
      // block. Deterministic table match, never an LLM judgment; `routedVia`
      // rides into the result details so the spend attribution is visible.
      let routedVia = null;
      if (routes && (!profileModel || !profileEffort)) {
        const route = resolveRoute(routes, {
          profile: params.profile != null && params.profile !== '' ? String(params.profile).toLowerCase() : null,
          target,
          task,
        });
        if (route) {
          profileModel = profileModel ?? route.model;
          profileEffort = profileEffort ?? route.effort;
          routedVia = route.via;
        }
      }
      // Secret scan on the task text BEFORE interpolation — model-authored
      // task text lands verbatim in the child process argv AND the durable
      // job checkpoint; a credential embedded here leaks to both the foreign
      // body's logs and our own persisted records. Same posture as the
      // memory write path: refuse outright, don't launder it onward.
      const secretHit = scanForSecrets(task);
      if (secretHit) {
        return {
          content: [{
            type: 'text',
            text: `delegation refused: task text matches credential pattern '${secretHit}' — ` +
              'a secret in the task lands in the child argv and the durable checkpoint; remove it and reference the secret by name instead',
          }],
          details: { refused: true, reason: 'secret_in_task_text', rule: 'secret_scan' },
          isError: true,
        };
      }
      const innerSpec = commandFor(target, task, { model: profileModel, effort: profileEffort });
      const inner = typeof innerSpec === 'string' ? innerSpec : String(innerSpec?.command ?? '');
      // M76/M94-R2: enforceability is ASSERTED by the command builder, never
      // sniffed from the final shell string — `inner` interpolates the
      // model-controlled task text, so `task="inspect pai-channel.js"` would
      // spoof capability on a foreign target. A builder returning a plain
      // string asserts nothing → the child is unenforceable (fail-closed);
      // an object return must explicitly set `enforceable: true`.
      const childEnforceable = typeof innerSpec === 'object' && innerSpec !== null && innerSpec.enforceable === true;
      // M94: a profile-declared budget is only meaningful when the child can
      // actually enforce it — pai-channel bodies gate provider requests on
      // PAI_BUDGET_MAX_*; any other target makes the declared cap a lie.
      if (profileBudget && !childEnforceable) {
        return {
          content: [{
            type: 'text',
            text: `delegation refused: profile '${params.profile}' declares a budget, but target '${target}' cannot enforce ` +
              'request-level caps — remove the budget fields or point the profile at a pai-channel body',
          }],
          details: { refused: true, reason: 'unenforceable_profile_budget', rule: 'budget' },
        };
      }
      // M76: same fail-closed rule for tools_deny — a pai-channel body reads
      // PAI_TOOLS_DENY at bootstrap and prunes its tool surface; any other
      // target silently ignores the constraint, so the declared deny would be
      // a lie. Refuse pre-spawn instead of shipping an unenforced hint.
      if (toolsDeny && !childEnforceable) {
        return {
          content: [{
            type: 'text',
            text: `delegation refused: profile '${params.profile}' declares tools_deny, but target '${target}' cannot enforce ` +
              'a child tool surface — remove tools_deny or point the profile at a pai-channel body',
          }],
          details: { refused: true, reason: 'unenforceable_tools_deny', rule: 'tools_deny' },
        };
      }
      // C3: identical fail-closed rule for mcp_deny — the mcp extension drops
      // denied servers at connect time inside a pai-channel child; a foreign
      // body ignores the stamp, so refuse pre-spawn rather than lie.
      if (mcpDeny && !childEnforceable) {
        return {
          content: [{
            type: 'text',
            text: `delegation refused: profile '${params.profile}' declares mcp_deny, but target '${target}' cannot enforce ` +
              'a child MCP subset — remove mcp_deny or point the profile at a pai-channel body',
          }],
          details: { refused: true, reason: 'unenforceable_mcp_deny', rule: 'mcp_deny' },
        };
      }
      const scope = getScope?.() ?? null;
      // Codex thread-tree depth cap: PAI_SPAWN_DEPTH counts how many nested
      // delegations produced this process (0 = operator's session). A child
      // at the cap cannot delegate further — fail-closed, and the refusal is
      // a tool result the model can route around (shallower sibling, do it
      // inline) rather than a crashed job.
      const depth = Number(process.env.PAI_SPAWN_DEPTH || 0);
      const maxDepth = Number(process.env.PAI_MAX_SPAWN_DEPTH || 3);
      if (depth >= maxDepth) {
        return {
          content: [{ type: 'text', text: `delegation refused: spawn depth ${depth} is at the cap (${maxDepth}) — nested delegation would hide work the operator cannot see; do this step inline or return it to the parent` }],
          details: { refused: true, reason: 'spawn_depth_cap', depth, maxDepth, rule: 'spawn_depth' },
        };
      }
      let budgetFlags = '';
      let committedSlice = null;
      let parentRem = null; // pre-commit remaining — captured once, reused for min()
      if (budget?.configured && scope) {
        // 0. parent admission — an already-breached scope may not spawn spend
        const gate = budget.admit(scope);
        if (!gate.ok) {
          return {
            content: [{ type: 'text', text: `delegation refused: budget gate: ${gate.reason}` }],
            details: { refused: true, reason: gate.reason, rule: 'budget' },
          };
        }
        // 1. enforceability — the child must carry a REAL hard gate, not a
        //    promise: our own pai-channel body reads PAI_BUDGET_MAX_* env at
        //    bootstrap and gates every provider request. Any other target is
        //    post-hoc accounting only — refused before spawn under a finite
        //    budget (bounded-autonomy requirement, not a courtesy).
        if (!childEnforceable) {
          return {
            content: [{
              type: 'text',
              text: 'delegation refused: target cannot enforce a hard request-level budget — ' +
                'finite-budget sessions may only delegate to budget-gated bodies (pai-channel)',
            }],
            details: { refused: true, reason: 'unenforceable_child_budget', rule: 'budget' },
          };
        }
        // 2. atomic bounded subdivision — charge the child's EFFECTIVE slice
        //    (min per-dim of parent-remaining and the profile cap) to the
        //    parent ledger now (commit-on-issue, never refunded on use):
        //    without this, concurrent delegates and the parent itself could
        //    each spend the same remaining headroom. Charging the whole
        //    remaining budget regardless of the profile cap would starve
        //    later delegates — reserve only what the child may spend.
        const rem = (parentRem = budget.remaining(scope));
        // any configured dimension already at zero leaves the child no
        // headroom at all — refuse rather than spawn a dead-on-arrival worker
        const configuredDims = [rem.tokens, rem.calls, rem.costUsd].filter((v) => v != null);
        if (configuredDims.length && configuredDims.some((v) => v <= 0)) {
          return {
            content: [{ type: 'text', text: 'delegation refused: budget gate: no remaining headroom in parent scope' }],
            details: { refused: true, reason: 'budget exhausted: parent scope has no remaining headroom', rule: 'budget' },
          };
        }
        const effCap = (parent, prof) => (parent != null && prof != null ? Math.min(parent, prof) : parent ?? prof);
        const slice = {
          total: rem.tokens != null ? (effCap(rem.tokens, profileBudget?.tokens) ?? 0) : 0,
          cost: rem.costUsd != null ? (effCap(rem.costUsd, profileBudget?.costUsd) ?? 0) : 0,
          calls: rem.calls != null ? (effCap(rem.calls, profileBudget?.calls) ?? 0) : 0,
        };
        const commit = budget.tryCommit(scope, slice, `delegate_commit:${target}`);
        if (!commit.ok) {
          return {
            content: [{ type: 'text', text: `delegation refused: budget gate: ${commit.reason}` }],
            details: { refused: true, reason: commit.reason, rule: 'budget' },
          };
        }
        committedSlice = slice;
      }
      // M94: effective child cap = min(parent-remaining slice, profile cap)
      // per dimension — each flag is emitted ONCE (bridge flagVal reads the
      // first occurrence), so the strictest value wins by construction.
      const eff = (parent, prof) => (parent != null && prof != null ? Math.min(parent, prof) : parent ?? prof);
      const effTokens = eff(parentRem?.tokens ?? null, profileBudget?.tokens ?? null);
      const effCalls = eff(parentRem?.calls ?? null, profileBudget?.calls ?? null);
      const effCost = eff(parentRem?.costUsd ?? null, profileBudget?.costUsd ?? null);
      if (effTokens != null) budgetFlags += ` --budget-tokens ${Math.floor(effTokens)}`;
      if (effCalls != null) budgetFlags += ` --budget-calls ${Math.floor(effCalls)}`;
      if (effCost != null) budgetFlags += ` --budget-cost ${effCost}`;
      // F-family: a task record upgrades the delegation to a mailbox-backed
      // AgentTask — the bridge watches inbox→stdin and captures child
      // markers→outbox/events. v1 is strictly parent↔child.
      const tname = params.name ? String(params.name).trim() : null;
      const tteam = params.team ? String(params.team).trim() : null;
      const agentTask = taskStore
        ? taskStore.create({
            label: tname ? `@${tname} ${task.slice(0, 60)}` : task.slice(0, 80),
            parent: scope,
            kind: tname ? 'teammate' : 'delegation',
            name: tname,
            team: tteam,
            spawnSpec: tname ? { target, profile: params.profile ?? null, task, depth: depth + 1 } : null,
          })
        : null;
      // depth propagates through the bridge into the child's env so a nested
      // delegate_task sees its own depth, not the parent's
      // caller-level max_minutes wins over the profile's declared ceiling;
      // the profile's is the default, the tool call's is the override
      const maxMinParam = Number(params.max_minutes);
      if (Number.isFinite(maxMinParam) && maxMinParam > 0) maxMin = Math.min(maxMinParam, 24 * 60);
      // M121 session env overlay rides the delegate bridge into the child.
      // Operator-authored profile env wins on conflict; envDeny strips
      // downstream as before. Injection-vector keys never got this far —
      // SessionEnv.set refused them.
      const sessionOverlay = envOverlay?.() ?? {};
      if (Object.keys(sessionOverlay).length || profileEnv) {
        profileEnv = { set: { ...sessionOverlay, ...(profileEnv?.set ?? {}) }, deny: profileEnv?.deny ?? [] };
      }
      const envFlag = profileEnv
        ? ` --env-json "${Buffer.from(JSON.stringify(profileEnv)).toString('base64')}"`
        : '';
      const command = `"${process.execPath}" "${bridgePath}" --target ${target}${budgetFlags}${envFlag}${steeringOff ? ' --steering-off' : ''}${toolsDeny ? ` --tools-deny "${toolsDeny}"` : ''}${mcpDeny ? ` --mcp-deny "${mcpDeny}"` : ''}${agentTask ? ` --task-dir "${taskStore.taskDir(agentTask.task_id)}"` : ''} --task-depth ${depth + 1} -- ${inner}`;
      const r = await executor.spawnCommandJob({
        command,
        workdir,
        jobType: 'delegation',
        authorizedRoot: workdir,
        budgetScope: scope,
        // committed charge covers the child's whole slice — its usage
        // envelope must NOT bill the parent again at exit (double-count)
        budgetCommitted: committedSlice != null,
        timeoutMs: maxMin != null ? Math.round(maxMin * 60_000) : null,
        worktree: params.worktree === true,
        dependsOn: Array.isArray(params.depends_on) ? params.depends_on : null,
      });
      if (r.refused) {
        // spawn never happened — roll the committed slice back out
        if (committedSlice && scope) {
          try { budget.refund(scope, committedSlice, `delegate_refund:${target}`); } catch { /* ledger fail — stays over-accounted, safe side */ }
        }
        return {
          content: [{ type: 'text', text: `delegation refused: ${r.reason}` }],
          details: { refused: true, reason: r.reason },
        };
      }
      const { job_id, attempt_id } = r;
      if (agentTask) taskStore.bindJob(agentTask.task_id, job_id);
      if (r.queued) {
        return {
          content: [{
            type: 'text',
            text: `delegation QUEUED as durable job ${job_id} — waiting on ${r.waiting_on.join(', ')} to COMPLETE. ` +
              'It starts itself when the chain clears and is cancelled if a dependency fails.' +
              (agentTask ? ` AgentTask ${agentTask.task_id} is bound already.` : ''),
          }],
          details: {
            job_id, queued: true, waiting_on: r.waiting_on, target, profile: params.profile ?? null,
            mode: forked ? 'fork' : 'delegate',
            ...(routedVia ? { routed_via: routedVia } : {}),
            ...(agentTask ? { task_id: agentTask.task_id } : {}),
          },
        };
      }
      return {
        content: [{
          type: 'text',
          text: `delegated to ${target}${forked ? ' (fork)' : ''} as durable job ${job_id} (attempt ${attempt_id})` +
            (agentTask ? ` — AgentTask ${agentTask.task_id}: use task_send/task_wait/task_yield/task_interrupt/task_close for two-way coordination. ` : '. ') +
            'Poll job_status for completion; the result envelope lands in the jobs directory.',
        }],
        details: {
          job_id, attempt_id, target, profile: params.profile ?? null,
          mode: forked ? 'fork' : 'delegate',
          ...(routedVia ? { routed_via: routedVia } : {}),
          ...(agentTask ? { task_id: agentTask.task_id } : {}),
          ...(budgetFlags ? { child_budget: budgetFlags.trim() } : {}),
        },
      };
    },
  };
}

// dedup-h #258 — Workflow tool (CC analogue): one call submits a bounded
// multi-step plan of sub-agent delegations. The plan is validated WHOLE
// (unique slug ids, resolvable depends_on, acyclic, ≤12 steps) before any
// admission; each step then travels the real delegate_task path — profile
// resolution, secret scan, enforceability, depth cap, budget commit — so a
// workflow can never smuggle a delegation the single tool would refuse.
// Steps run under a shared `wf-<id>` team (task_list filter / team_msg
// broadcast) and inter-step depends_on is rewritten from step ids to the
// durable job ids admission returns. First refusal stops submission; the
// report names admitted job ids honestly so the operator can cancel them.
const STEP_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_WORKFLOW_STEPS = 12;

export function workflowTool(delegate) {
  return {
    name: 'workflow',
    label: 'Workflow',
    description:
      'Orchestrate multiple sub-agents on a large multi-step task in one call (CC Workflow analogue). ' +
      `Pass steps:[{id, task, profile?|target?, depends_on?, worktree?, max_minutes?}] — ≤${MAX_WORKFLOW_STEPS} steps, ` +
      'unique kebab-case ids, depends_on lists step ids that must COMPLETE first. The whole plan is validated ' +
      'before anything is admitted; each step is then delegated through the same governed path as delegate_task ' +
      'and queued behind its dependencies. Returns a workflow id, the wf-team name, and the step→job mapping. ' +
      'Poll job_status / task_list per step; team_msg broadcasts to the whole workflow roster.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'optional workflow label — becomes the wf-<id> team suffix' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'unique kebab-case step id' },
              task: { type: 'string', description: 'task description for this step' },
              target: { type: 'string', description: 'target agent id (omit with profile for fork mode)' },
              profile: { type: 'string', description: 'named subagent profile' },
              depends_on: { type: 'array', items: { type: 'string' }, description: 'step ids that must COMPLETE first' },
              worktree: { type: 'boolean', description: 'run this step in a detached git worktree' },
              max_minutes: { type: 'number', description: 'wall-clock ceiling for this step' },
            },
            required: ['id', 'task'],
          },
          description: `ordered plan — ≤${MAX_WORKFLOW_STEPS} steps`,
        },
      },
      required: ['steps'],
    },
    promptSnippet: 'workflow(steps): orchestrate a multi-step plan across sub-agents in one governed call',
    async execute(toolCallId, params) {
      const fail = (text, reason) => ({
        content: [{ type: 'text', text }],
        details: { refused: true, reason },
        isError: true,
      });
      const steps = params?.steps;
      if (!Array.isArray(steps) || !steps.length) return fail('workflow: steps must be a non-empty array', 'empty_plan');
      if (steps.length > MAX_WORKFLOW_STEPS) return fail(`workflow: plan has ${steps.length} steps — the cap is ${MAX_WORKFLOW_STEPS}`, 'plan_too_large');
      const ids = new Set();
      for (const s of steps) {
        const id = String(s?.id ?? '');
        if (!STEP_ID.test(id)) return fail(`workflow: step id '${id}' must be kebab-case (a-z, 0-9, _ or -, ≤32)`, 'bad_step_id');
        if (ids.has(id)) return fail(`workflow: duplicate step id '${id}'`, 'duplicate_step_id');
        ids.add(id);
        if (!String(s?.task ?? '').trim()) return fail(`workflow: step '${id}' has no task`, 'empty_task');
        if (s?.depends_on != null && !Array.isArray(s.depends_on)) {
          return fail(`workflow: step '${id}' depends_on must be an array of step ids`, 'bad_depends_on');
        }
        for (const dep of s?.depends_on ?? []) {
          if (!steps.some((x) => x?.id === dep)) {
            return fail(`workflow: step '${id}' depends on unknown step '${dep}'`, 'unknown_dependency');
          }
          if (dep === id) return fail(`workflow: step '${id}' cannot depend on itself`, 'self_dependency');
        }
      }
      // topo order — Kahn; a cycle leaves unemitted steps → refuse the plan
      const indeg = new Map(steps.map((s) => [s.id, 0]));
      const edges = new Map(steps.map((s) => [s.id, []]));
      for (const s of steps) for (const dep of s.depends_on ?? []) {
        indeg.set(s.id, indeg.get(s.id) + 1);
        edges.get(dep)?.push(s.id);
      }
      const queue = steps.filter((s) => indeg.get(s.id) === 0).map((s) => s.id);
      const order = [];
      while (queue.length) {
        const id = queue.shift();
        order.push(id);
        for (const next of edges.get(id) ?? []) {
          indeg.set(next, indeg.get(next) - 1);
          if (indeg.get(next) === 0) queue.push(next);
        }
      }
      if (order.length !== steps.length) {
        return fail('workflow: depends_on contains a cycle — no execution order exists', 'cyclic_plan');
      }
      const wfId = `wf-${Math.random().toString(36).slice(2, 8)}`;
      const label = String(params?.name ?? '').trim();
      const team = label ? `${wfId}-${label.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)}` : wfId;
      const byId = new Map(steps.map((s) => [s.id, s]));
      const jobOf = new Map();
      const admitted = [];
      for (const id of order) {
        const s = byId.get(id);
        const depJobs = (s.depends_on ?? []).map((d) => jobOf.get(d)).filter(Boolean);
        const r = await delegate.execute(toolCallId, {
          task: s.task,
          ...(s.target ? { target: s.target } : {}),
          ...(s.profile ? { profile: s.profile } : {}),
          ...(depJobs.length ? { depends_on: depJobs } : {}),
          ...(s.worktree === true ? { worktree: true } : {}),
          ...(s.max_minutes != null ? { max_minutes: s.max_minutes } : {}),
          team,
        });
        const jobId = r?.details?.job_id;
        if (r?.isError || !jobId) {
          const reason = r?.content?.[0]?.text ?? 'admission refused';
          return {
            content: [{
              type: 'text',
              text: `workflow ${wfId} STOPPED at step '${id}': ${reason}\n` +
                (admitted.length
                  ? `already admitted (still live — cancel via task_close/job interrupt if unwanted):\n${admitted.map((a) => `  ${a.id} → ${a.job}`).join('\n')}`
                  : 'no steps were admitted'),
            }],
            details: { refused: true, reason: 'step_refused', step: id, workflow: wfId, team, admitted },
            isError: true,
          };
        }
        jobOf.set(id, jobId);
        admitted.push({ id, job: jobId, task: r.details?.task_id ?? null, queued: r.details?.queued === true });
      }
      return {
        content: [{
          type: 'text',
          text: `workflow ${wfId} admitted ${admitted.length} steps on team '${team}':\n` +
            admitted.map((a) => `  ${a.id} → job ${a.job}${a.queued ? ' (queued on deps)' : ''}`).join('\n') +
            '\nPoll job_status per job, task_list filter team, or team_msg to broadcast.',
        }],
        details: { workflow: wfId, team, steps: admitted },
      };
    },
  };
}

/** job_status customTool — lets the model poll a durable job's position. */
export function jobStatusTool(store) {
  return {
    name: 'job_status',
    label: 'Job Status',
    description: 'Read a durable job record: state, current attempt, lease, validation.',
    parameters: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
    },
    async execute(_toolCallId, params) {
      const job = store.getJob(params.job_id);
      if (!job) {
        return { content: [{ type: 'text', text: `job '${params.job_id}' not found` }], isError: true };
      }
      const attempts = store.getAttempts(params.job_id);
      const lease = store.getLease(params.job_id);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            job_id: job.job_id,
            job_state: job.job_state,
            orchestration_state: job.orchestration_state,
            validation_state: job.validation_state,
            current_attempt_id: job.current_attempt_id,
            attempts: attempts.length,
            lease_held_by: lease?.writer_id ?? null,
            checkpoint_ref: job.checkpoint_ref,
          }),
        }],
      };
    },
  };
}
