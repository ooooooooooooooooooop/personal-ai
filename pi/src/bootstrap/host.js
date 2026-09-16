import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHostCore } from '../../../host/src/app/host.js';
import { createPiSession } from '../adapter/index.js';
import { parseShellCommand } from '../adapter/command-parse.js';
import { ContinuationGovernor } from '../../../host/src/core/continuation.js';
import { selectBody } from '../../../host/src/core/eligibility.js';
import { JobStore } from '../../../host/src/core/jobs.js';
import { JobExecutor } from '../adapter/jobs.js';
import { delegateTool, jobStatusTool } from '../adapter/delegate.js';
import { createChannelHost } from '../adapter/channel.js';
import { ToolSurface, defaultDenyMemoryPath } from '../adapter/surface.js';
import { FileOpsGuard } from '../adapter/fileops.js';
import { makeDecide } from './decide.js';
import { resolveManagedExtensions } from '../extensions/loader.js';
import { writeRuntimeIdentity } from '../../../host/src/core/identity.js';
import { randomUUID } from 'node:crypto';

const PI_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HOST_ROOT = fileURLToPath(new URL('../../../host/', import.meta.url));

/** Pi body's declared capability coverage — facts, not status. */
const PI_CAPABILITIES = {
  final_post_extension_guard: 'supported',
  canonical_prediction_binding: 'supported', // M2: kernel binds mutations to open predictions
  loop_observability: 'supported',
  provider_request_audit: 'supported',
  compaction_governance: 'supported', // M3: session_before_compact governance + context-seam preservation
  durable_jobs: 'supported', // M4: JobStore + executor + kill recovery
  mcp_native: 'unsupported', // bridged via RPC/customTools at M4
};

/** Which governance surfaces the Pi body actually enforces (M8-verified). */
const PI_GOVERNANCE_COVERAGE = {
  tool_decide: 'supported',
  schema_revalidation: 'supported',
  deny_hide: 'supported',
  fileops_guard: 'supported',
  audit: 'supported',
  compaction_hooks: 'supported',
  continuation_steer: 'supported',
  usage_accounting: 'supported',
};

/** Cold-handoff phase support — the full seven-state machine is implemented. */
const PI_HANDOFF_CAPABILITIES = {
  quiesce: 'supported',
  checkpoint: 'supported',
  release: 'supported',
  acquire: 'supported',
  resume: 'supported',
  verify: 'supported',
};

/**
 * Production session's non-negotiable body requirements — the task profile
 * the selector is measured against. "Pi is the default body" means: pi is
 * the body selectBody() returns for THIS profile, re-evaluated every boot.
 */
const REQUIRED_BODY_CAPABILITIES = [
  { capability: 'final_post_extension_guard', negotiable: false },
  { capability: 'durable_jobs', negotiable: false },
  { capability: 'provider_request_audit', negotiable: false },
];

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
    verified_capabilities: PI_CAPABILITIES,
    governance_coverage: PI_GOVERNANCE_COVERAGE,
    handoff_capabilities: PI_HANDOFF_CAPABILITIES,
    supported_effect_domains: ['tools', 'filesystem', 'shell', 'network'],
    known_limitations: { mcp: 'no native MCP; bridged at M4' },
  });

  // Body selection is a mechanism, not a declaration: evaluate every
  // registered body against the production task profile and boot pi only
  // because the selector picked it. Any future body that also satisfies the
  // non-negotiables changes this result by FACTS, not by editing this file.
  const selection = selectBody(core.registry.list(), {
    requiredCapabilities: REQUIRED_BODY_CAPABILITIES,
  });
  if (selection.selected?.body_id !== 'pi') {
    throw new Error(
      `body selection refused pi bootstrap: ${JSON.stringify(selection.results)}`,
    );
  }
  core.audit.write({
    kind: 'BODY_SELECTED',
    data: {
      selected: 'pi',
      required: REQUIRED_BODY_CAPABILITIES.map((r) => r.capability),
      results: selection.results,
    },
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

  // M2 production wiring: policy-denied tools never reach the visible surface
  // (excludeTools at construction); runtime terminate-level denials hide the
  // tool via ToolSurface + deny-memory so a restart reproduces the same view.
  const initialDeny = Object.entries(core.policy.toolPolicy)
    .filter(([, rules]) => rules?.action === 'deny')
    .map(([name]) => name);
  const fileOps = new FileOpsGuard(core.paths.root);
  let toolSurface = null; // assigned once the session exists — decide runs later

  const { session, guard, extensionsResult } = await createPiSession({
    workdir,
    sessionOptions: { agentDir: join(core.paths.root, 'pi-agent'), ...sessionOptions },
    managedExtensions,
    instructionEnvelope: core.instructionEnvelope,
    contextEnvelope: core.contextProvider, // live provider — not a snapshot
    audit: core.audit,
    customTools,
    excludeTools: initialDeny,
    // revalidate defaults to the session's own tool registry via pi-ai
    // Pi ctx carries the name at ctx.toolCall.name; the kernel contract is
    // ctx.toolName — translate at the boundary, don't leak Pi shape inward.
    decide: makeDecide({
      core, executor, fileOps,
      getSurface: () => toolSurface,
      workdir,
    }),
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

  // runtime deny→hide surface: re-assert persisted denials on the real session
  toolSurface = new ToolSurface({
    session,
    denyMemoryPath: defaultDenyMemoryPath(core.paths.root),
    initialDeny,
  });
  toolSurface.reconcile();

  // runtime identity completes once the session exists — session id is part of
  // it, and every audit event cites this identity via the annotations below.
  const identity = writeRuntimeIdentity(core.paths, {
    hostVersion: '0.0.1',
    adapter: { id: 'pi', version: '0.85.1' },
    lockfiles: {
      host: join(HOST_ROOT, 'package-lock.json'),
      pi: join(PI_ROOT, 'package-lock.json'),
    },
    sessionId: session.sessionId ?? null,
    runId,
  });
  core.audit.annotations.governance_coverage = PI_GOVERNANCE_COVERAGE;

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

  return { ...core, identity, session, guard, runId, jobStore, executor, recoveryActions, channel, toolSurface, fileOps };
}
