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
 */
export function delegateTool(executor, { commandFor, workdir, bridgePath = DELEGATE_BRIDGE }) {
  return {
    name: 'delegate_task',
    label: 'Delegate Task',
    description:
      'Delegate a task to another agent via the switchboard RPC bridge. ' +
      'Returns immediately with a durable job id; the delegated work survives ' +
      'restarts and its usage is attributed to this run.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'target agent id (e.g. codex, claude, gemini)' },
        task: { type: 'string', description: 'task description for the delegate' },
      },
      required: ['target', 'task'],
    },
    promptSnippet: 'delegate_task(target, task): run a task on another agent as a durable job',
    async execute(_toolCallId, params) {
      // Every delegation goes through the bridge: it spawns the real worker,
      // measures wall time/output, forwards child-reported usage, and emits
      // the single authoritative PAI_USAGE line the executor attributes to
      // parent_run_id. Usage attribution is produced, not hoped for.
      const inner = commandFor(params.target, params.task);
      const command = `"${process.execPath}" "${bridgePath}" --target ${params.target} -- ${inner}`;
      const { job_id, attempt_id } = executor.spawnCommandJob({
        command,
        workdir,
        jobType: 'delegation',
        authorizedRoot: workdir,
      });
      return {
        content: [{
          type: 'text',
          text: `delegated to ${params.target} as durable job ${job_id} (attempt ${attempt_id}). ` +
            'Poll job_status for completion; the result envelope lands in the jobs directory.',
        }],
        details: { job_id, attempt_id, target: params.target },
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
