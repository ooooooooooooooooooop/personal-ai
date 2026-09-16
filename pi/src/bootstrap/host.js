import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHostCore } from '../../../host/src/app/host.js';
import { createPiSession } from '../adapter/index.js';
import { parseShellCommand } from '../adapter/command-parse.js';
import { ContinuationGovernor } from '../../../host/src/core/continuation.js';
import { JobStore } from '../../../host/src/core/jobs.js';
import { JobExecutor, isLongRunningCommand } from '../adapter/jobs.js';
import { delegateTool, jobStatusTool } from '../adapter/delegate.js';
import { createChannelHost } from '../adapter/channel.js';
import { resolveManagedExtensions } from '../extensions/loader.js';
import { randomUUID } from 'node:crypto';

const PI_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HOST_ROOT = fileURLToPath(new URL('../../../host/', import.meta.url));

/** Pi body's declared capability coverage — facts, not status. */
const PI_CAPABILITIES = {
  final_post_extension_guard: 'supported',
  canonical_prediction_binding: 'supported', // M2: kernel binds mutations to open predictions
  loop_observability: 'supported',
  provider_request_audit: 'supported',
  compaction_governance: 'partial', // lands M3
  durable_jobs: 'partial', // lands M4
  mcp_native: 'unsupported', // bridged via RPC/customTools at M4
};

/**
 * Concrete composition root for the Pi body.
 *
 * Direction is pi → host: this file knows BOTH sides. host/ never imports pi/.
 * Swapping bodies means writing another package like this one; host/ stays
 * byte-identical.
 */
export async function startHost({
  instanceRoot,
  workdir = process.cwd(),
  sessionOptions = {},
  taskRequirements = [],
  delegationCommand = null, // (target, task) => shell cmd — delegate_task stays unregistered without it
} = {}) {
  const runId = randomUUID();
  const core = createHostCore({
    instanceRoot,
    manifestPath: join(PI_ROOT, 'extensions', 'managed-manifest.json'),
    governance: {
      // pi body supplies the real shell parser; host never imports pi code
      commandClassifier: parseShellCommand,
      commandArgs: { powershell: 'command', bash: 'command', shell: 'command' },
    },
    runtime: {
      hostVersion: '0.0.1',
      adapter: { id: 'pi', version: '0.85.1' },
      lockfiles: {
        host: join(HOST_ROOT, 'package-lock.json'),
        pi: join(PI_ROOT, 'package-lock.json'),
      },
      runId,
    },
  });

  core.registry.register({
    body_id: 'pi',
    adapter_version: '0.85.1',
    capabilities: PI_CAPABILITIES,
    supported_effect_domains: ['tools', 'filesystem', 'shell', 'network'],
    known_limitations: { mcp: 'no native MCP; bridged at M4' },
  });

  const managedExtensions = resolveManagedExtensions(core.manifest, {
    baseDir: PI_ROOT,
  });

  // M4: durable jobs — state machine in host, executor in the body.
  const jobStore = new JobStore(join(core.paths.root, 'jobs', 'durable_jobs.db'));
  const executor = new JobExecutor(jobStore, join(core.paths.root, 'jobs'), {
    audit: core.audit,
    runId,
  });
  // cold-start sweep: dead workers from a previous process get recovered or
  // parked for review — never silently abandoned
  const recoveryActions = executor.recover({ workdir });

  const customTools = [jobStatusTool(jobStore)];
  if (delegationCommand) customTools.push(delegateTool(executor, { commandFor: delegationCommand, workdir }));

  const { session, guard, extensionsResult } = await createPiSession({
    workdir,
    sessionOptions: { agentDir: join(core.paths.root, 'pi-agent'), ...sessionOptions },
    managedExtensions,
    instructionEnvelope: core.instructionEnvelope,
    contextEnvelope: core.contextEnvelope,
    audit: core.audit,
    customTools,
    // revalidate defaults to the session's own tool registry via pi-ai
    // Pi ctx carries the name at ctx.toolCall.name; the kernel contract is
    // ctx.toolName — translate at the boundary, don't leak Pi shape inward.
    decide: async (ctx, signal) => {
      const toolName = ctx.toolCall?.name ?? ctx.toolName;
      const decision = await core.kernel.decideToolCall({ ...ctx, toolName }, signal);
      if (decision) return decision; // kernel denied — done
      // kernel admitted: long-running commands become durable jobs instead of
      // blocking the session — the sync call is refused with the job id so the
      // model can poll job_status (Devin/Crush background-command pattern)
      const command = ctx.args?.command;
      if (typeof command === 'string' && isLongRunningCommand(command)) {
        const { job_id, attempt_id } = executor.spawnCommandJob({
          command,
          workdir,
          jobType: 'shell_command',
        });
        return {
          block: true,
          reason:
            `long-running command converted to durable job ${job_id} ` +
            `(attempt ${attempt_id}) — it survives restarts; poll job_status`,
        };
      }
      return undefined;
    },
    loopGovernance: taskRequirements.length
      ? {
          continuation: new ContinuationGovernor({
            ledgerPath: join(core.paths.root, 'continuation.jsonl'),
            audit: core.audit,
            requirements: taskRequirements,
          }),
          predictions: core.predictions,
        }
      : null,
  });

  if (!guard.sealed()) {
    throw new Error('composite guard failed to seal');
  }

  core.audit.write({
    kind: 'HOST_STARTED',
    runId,
    data: {
      body: 'pi',
      extensions_loaded: extensionsResult.extensions.length,
      extension_errors: extensionsResult.errors.length,
    },
  });

  // M6: the UI-facing channel — consumers speak the host protocol, never pi's
  const channel = createChannelHost({ session, core, jobs: jobStore });

  return { ...core, session, guard, runId, jobStore, executor, recoveryActions, channel };
}
