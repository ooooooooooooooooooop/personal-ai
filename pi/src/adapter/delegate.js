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
import { fileURLToPath } from 'node:url';

/** The real usage producer every delegation rides through. */
export const DELEGATE_BRIDGE = fileURLToPath(new URL('../../bin/delegate-bridge.js', import.meta.url));

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
 * @param {TaskStore} [opts.taskStore]  F-family mailbox — when present every
 *        delegation creates a task record and the bridge binds --task-dir,
 *        upgrading the one-shot job to a bidirectional AgentTask.
 */
export function delegateTool(executor, { commandFor, workdir, bridgePath = DELEGATE_BRIDGE, getScope = null, budget = null, profiles = null, taskStore = null }) {
  return {
    name: 'delegate_task',
    label: 'Delegate Task',
    description:
      'Delegate a task to another agent via the switchboard RPC bridge. ' +
      'Pass a subagent `profile` name (project .pai/agents or instance agents/) ' +
      'to delegate with that persona, or a raw `target` agent id. ' +
      'Returns immediately with a durable job id; the delegated work survives ' +
      'restarts and its usage is attributed to this run.' +
      (profiles?.size ? ` Available profiles: ${[...profiles.values()].map((p) => `${p.name}→${p.target}${p.description ? ` (${p.description})` : ''}`).join(', ')}` : ''),
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'target agent id (e.g. codex, claude, gemini)' },
        profile: { type: 'string', description: 'named subagent profile — resolves target and prepends its preamble' },
        task: { type: 'string', description: 'task description for the delegate' },
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
      }
      if (!target) {
        return {
          content: [{ type: 'text', text: 'delegate_task requires a `target` agent id or a `profile` name' }],
          isError: true,
        };
      }
      const inner = commandFor(target, task);
      const scope = getScope?.() ?? null;
      let budgetFlags = '';
      let committedSlice = null;
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
        if (!/pai-channel\.js/.test(inner)) {
          return {
            content: [{
              type: 'text',
              text: 'delegation refused: target cannot enforce a hard request-level budget — ' +
                'finite-budget sessions may only delegate to budget-gated bodies (pai-channel)',
            }],
            details: { refused: true, reason: 'unenforceable_child_budget', rule: 'budget' },
          };
        }
        // 2. atomic bounded subdivision — charge the child's WHOLE slice to
        //    the parent ledger now (commit-on-issue, never refunded on use):
        //    without this, concurrent delegates and the parent itself could
        //    each spend the same remaining headroom. A cross-process race is
        //    caught by tryCommit's post-append breach check + refund rollback.
        const rem = budget.remaining(scope);
        // any configured dimension already at zero leaves the child no
        // headroom at all — refuse rather than spawn a dead-on-arrival worker
        const configuredDims = [rem.tokens, rem.calls, rem.costUsd].filter((v) => v != null);
        if (configuredDims.length && configuredDims.some((v) => v <= 0)) {
          return {
            content: [{ type: 'text', text: 'delegation refused: budget gate: no remaining headroom in parent scope' }],
            details: { refused: true, reason: 'budget exhausted: parent scope has no remaining headroom', rule: 'budget' },
          };
        }
        const slice = { total: rem.tokens ?? 0, cost: rem.costUsd ?? 0, calls: rem.calls ?? 0 };
        const commit = budget.tryCommit(scope, slice, `delegate_commit:${target}`);
        if (!commit.ok) {
          return {
            content: [{ type: 'text', text: `delegation refused: budget gate: ${commit.reason}` }],
            details: { refused: true, reason: commit.reason, rule: 'budget' },
          };
        }
        committedSlice = slice;
        if (rem.tokens != null) budgetFlags += ` --budget-tokens ${Math.floor(rem.tokens)}`;
        if (rem.calls != null) budgetFlags += ` --budget-calls ${Math.floor(rem.calls)}`;
        if (rem.costUsd != null) budgetFlags += ` --budget-cost ${rem.costUsd}`;
      }
      // F-family: a task record upgrades the delegation to a mailbox-backed
      // AgentTask — the bridge watches inbox→stdin and captures child
      // markers→outbox/events. v1 is strictly parent↔child.
      const agentTask = taskStore
        ? taskStore.create({ label: task.slice(0, 80), parent: scope, kind: 'delegation' })
        : null;
      const command = `"${process.execPath}" "${bridgePath}" --target ${target}${budgetFlags}${agentTask ? ` --task-dir "${taskStore.taskDir(agentTask.task_id)}"` : ''} -- ${inner}`;
      const r = await executor.spawnCommandJob({
        command,
        workdir,
        jobType: 'delegation',
        authorizedRoot: workdir,
        budgetScope: scope,
        // committed charge covers the child's whole slice — its usage
        // envelope must NOT bill the parent again at exit (double-count)
        budgetCommitted: committedSlice != null,
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
      return {
        content: [{
          type: 'text',
          text: `delegated to ${target} as durable job ${job_id} (attempt ${attempt_id})` +
            (agentTask ? ` — AgentTask ${agentTask.task_id}: use task_send/task_wait/task_yield/task_interrupt/task_close for two-way coordination. ` : '. ') +
            'Poll job_status for completion; the result envelope lands in the jobs directory.',
        }],
        details: {
          job_id, attempt_id, target, profile: params.profile ?? null,
          ...(agentTask ? { task_id: agentTask.task_id } : {}),
          ...(budgetFlags ? { child_budget: budgetFlags.trim() } : {}),
        },
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
