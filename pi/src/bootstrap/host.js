import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHostCore } from '../../../host/src/app/host.js';
import { createPiSession, sessionManagers } from '../adapter/index.js';
import { parseShellCommand } from '../adapter/command-parse.js';
import { ContinuationGovernor } from '../../../host/src/core/continuation.js';
import { selectBody } from '../../../host/src/core/eligibility.js';
import { JobStore } from '../../../host/src/core/jobs.js';
import { PendingAsks } from '../../../host/src/core/asks.js';
import { JobExecutor } from '../adapter/jobs.js';
import { delegateTool, jobStatusTool } from '../adapter/delegate.js';
import { createChannelHost } from '../adapter/channel.js';
import { ToolSurface, defaultDenyMemoryPath } from '../adapter/surface.js';
import { FileOpsGuard } from '../adapter/fileops.js';
import { makeDecide } from './decide.js';
import { resolveManagedExtensions } from '../extensions/loader.js';
import { writeRuntimeIdentity } from '../../../host/src/core/identity.js';
import {
  PI_GOVERNANCE_COVERAGE,
  REQUIRED_BODY_CAPABILITIES,
  piFacts,
} from './facts.js';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';

const PI_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HOST_ROOT = fileURLToPath(new URL('../../../host/', import.meta.url));

/** Domain lease the live body holds: canonical writer authority. */
const WRITER_LEASE = { scope: 'domain', name: 'canonical-writer' };
const WRITER_TTL_SECONDS = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Claim the canonical-writer lease, waiting out a dead predecessor's TTL.
 * A lease held by a LIVE body (not yet stale past its expiry) is fail-closed:
 * two bodies writing canonical at once is exactly what the fence exists to stop.
 */
async function claimCanonicalWriter(leases, owner) {
  const deadline = Date.now() + (WRITER_TTL_SECONDS + 5) * 1000;
  for (;;) {
    const r = leases.claim({ ...WRITER_LEASE, owner, ttlSeconds: WRITER_TTL_SECONDS });
    if (r.ok) return r.lease;
    const expiresAtMs = (r.heldBy?.expiresAt ?? 0) * 1000;
    if (Date.now() + Math.max(0, expiresAtMs - Date.now()) > deadline) {
      throw new Error(
        `canonical-writer lease held by ${r.heldBy?.owner ?? 'unknown'} (gen ${r.heldBy?.generation}) — refusing to boot a second writer`,
      );
    }
    await sleep(Math.min(500, Math.max(50, expiresAtMs - Date.now() + 50)));
  }
}

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
  // Operator-ask registry: constructed right after core (it audits), but the
  // kernel needs an ask callback at construction — lazy closure resolves it.
  let asks = null;
  const core = createHostCore({
    instanceRoot,
    manifestPath: join(PI_ROOT, 'extensions', 'managed-manifest.json'),
    governance: {
      // pi body supplies the real shell parser; host never imports pi code
      commandClassifier: parseShellCommand,
      commandArgs: { powershell: 'command', bash: 'command', shell: 'command' },
      // no responder yet = fail-closed deny, never crash-open
      ask: (pending, signal) => (asks ? asks.ask(pending, signal) : Promise.resolve('deny')),
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

  asks = new PendingAsks({ audit: core.audit });

  core.registry.register(piFacts());

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

  // Sessions persist under the instance root — the app lists/resumes them.
  const sessionDir = join(core.paths.root, 'sessions');
  const agentDir = join(core.paths.root, 'pi-agent');

  // Session construction is a closure because session_new/session_switch
  // rebuild it in-process: same guard + envelopes + tools, new SessionManager.
  const buildSession = async (sessionManager) => {
    const built = await createPiSession({
      workdir,
      sessionOptions: { agentDir, ...sessionOptions, sessionManager },
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
            observations: core.observations,
          }
        : null,
    });
    if (!built.guard.sealed()) {
      throw new Error('composite guard failed to seal');
    }
    // runtime deny→hide surface: re-assert persisted denials on the real session
    toolSurface = new ToolSurface({
      session: built.session,
      denyMemoryPath: defaultDenyMemoryPath(core.paths.root),
      initialDeny,
    });
    toolSurface.reconcile();
    return built;
  };

  const { session, guard, extensionsResult } = await buildSession(
    sessionManagers.create(workdir, sessionDir),
  );
  let currentSession = session;

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

  // Canonical writer authority: the live body holds this domain lease for the
  // whole session. Handoff releases it before another body may acquire — the
  // no-dual-writer window is enforced by the lease, not by politeness.
  const writerOwner = `pi:${runId}`;
  const writerLease = await claimCanonicalWriter(core.leases, writerOwner);
  const renewTimer = setInterval(() => {
    const r = core.leases.renew({
      ...WRITER_LEASE, owner: writerOwner,
      generation: writerLease.generation, ttlSeconds: WRITER_TTL_SECONDS,
    });
    if (!r.ok) {
      core.audit.write({
        kind: 'LEASE_LOST', runId,
        data: { ...WRITER_LEASE, reason: r.reason },
      });
    }
  }, Math.max(1000, (WRITER_TTL_SECONDS / 3) * 1000));
  renewTimer.unref();
  let writerReleased = false;
  const releaseWriter = () => {
    if (writerReleased) return { released: [] };
    writerReleased = true;
    clearInterval(renewTimer);
    const r = core.leases.release({
      ...WRITER_LEASE, owner: writerOwner, generation: writerLease.generation,
    });
    return { released: r.ok ? [WRITER_LEASE.name] : [], error: r.ok ? undefined : r.reason };
  };

  // Handoff facade — the body-owned side of the cold-handoff phases the app
  // supervisor orchestrates through the channel. prepare/export/release are
  // real operations on THIS live session, not declarations.
  const handoffFacade = {
    prepare: async () => {
      await currentSession.abort?.().catch(() => {});
      return {
        runId,
        sessionId: currentSession.sessionId ?? null,
        heldLeases: writerReleased
          ? []
          : [{ ...WRITER_LEASE, owner: writerOwner, generation: writerLease.generation }],
      };
    },
    export: async () => ({
      goalIdentity: `goal:${currentSession.sessionId ?? 'session'}`,
      canonicalCursor: `sha256:${createHash('sha256')
        .update(JSON.stringify(core.predictions.openPredictions())).digest('hex')}`,
      soulIdentity: `soul:${core.soul?.manifest?.name ?? 'personal-ai'}`,
      openPredictions: core.predictions.openPredictions().map((p) => p.id),
      jobCursors: jobStore.listUnfinished().map((j) => ({
        job_id: j.job_id,
        current_attempt: jobStore.getAttempts(j.job_id).length,
        checkpoint_ref: j.checkpoint_ref ?? null,
      })),
      policyIdentity: `sha256:${core.policy.checksum}`,
      provenanceChain: [runId],
      source: { body: 'pi', session: currentSession.sessionId ?? 'session', run: runId },
    }),
    release: async () => releaseWriter(),
  };

  core.audit.write({
    kind: 'HOST_STARTED',
    runId,
    data: {
      body: 'pi',
      extensions_loaded: extensionsResult.extensions.length,
      extension_errors: extensionsResult.errors.length,
    },
  });

  // Session lifecycle: session_new/session_switch rebuild the AgentSession
  // in-process with a fresh/opened SessionManager — same guard, envelopes,
  // tools, and governance; only the conversation state changes.
  let channelHandle = null;
  const rebuildSession = async (sessionManager, reason) => {
    const old = currentSession;
    await old.abort?.().catch(() => {});
    asks.resetSession(); // "本会话允许" grants die with the conversation
    const built = await buildSession(sessionManager);
    currentSession = built.session;
    channelHandle.rebind(built.session);
    channelHandle.channel.emitEvent({
      type: 'session_changed',
      session: {
        id: built.session.sessionId ?? null,
        name: built.session.sessionManager?.getSessionName?.() ?? null,
        file: built.session.sessionManager?.getSessionFile?.() ?? null,
      },
      reason,
    });
    old.dispose?.();
    core.audit.write({
      kind: 'SESSION_SWITCHED', runId,
      data: { reason, sessionId: built.session.sessionId ?? null },
    });
    return built.session;
  };

  const sessionInfo = (s) => ({
    path: s.path,
    id: s.id,
    cwd: s.cwd ?? '',
    name: s.name ?? null,
    created: s.created?.toISOString?.() ?? null,
    modified: s.modified?.toISOString?.() ?? null,
    messageCount: s.messageCount ?? 0,
    firstMessage: s.firstMessage ?? '',
  });

  const sessionsFacade = {
    list: async () => (await sessionManagers.list(workdir, sessionDir)).map(sessionInfo),
    create: async () => {
      const s = await rebuildSession(sessionManagers.create(workdir, sessionDir), 'new');
      return { id: s.sessionId ?? null, file: s.sessionManager?.getSessionFile?.() ?? null };
    },
    open: async (path) => {
      const s = await rebuildSession(sessionManagers.open(path, sessionDir), 'switch');
      return {
        id: s.sessionId ?? null,
        file: s.sessionManager?.getSessionFile?.() ?? null,
        name: s.sessionManager?.getSessionName?.() ?? null,
      };
    },
    rename: async (name) => {
      currentSession.setSessionName?.(name);
      return { name };
    },
    // Fork = copy the transcript into a new session file and continue there —
    // the original stays untouched. rebuildSession switches the live surface.
    fork: async (path) => {
      const s = await rebuildSession(sessionManagers.forkFrom(path, workdir, sessionDir), 'fork');
      return {
        id: s.sessionId ?? null,
        file: s.sessionManager?.getSessionFile?.() ?? null,
      };
    },
  };

  // M6: the UI-facing channel — consumers speak the host protocol, never pi's
  channelHandle = createChannelHost({
    session, core, jobs: jobStore,
    bodies: {
      current: async () => ({
        body_id: 'pi',
        runId,
        sessionId: currentSession.sessionId ?? null,
        facts: piFacts(),
        selection: selection.results,
      }),
    },
    handoff: handoffFacade,
    sessions: sessionsFacade,
    asks,
  });
  const channel = channelHandle.channel;

  const dispose = () => {
    releaseWriter();
    asks.dispose();
    channelHandle.dispose();
    currentSession.dispose?.();
    jobStore.db.close();
    core.leases.close();
  };

  return { ...core, identity, session, guard, runId, jobStore, executor, recoveryActions, channel, toolSurface, fileOps, dispose };
}
