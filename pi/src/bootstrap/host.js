import { join, resolve } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHostCore } from '../../../host/src/app/host.js';
import { createPiSession, sessionManagers } from '../adapter/index.js';
import { parseShellCommand } from '../adapter/command-parse.js';
import { ContinuationGovernor } from '../../../host/src/core/continuation.js';
import { selectBody } from '../../../host/src/core/eligibility.js';
import { JobStore } from '../../../host/src/core/jobs.js';
import { PendingAsks } from '../../../host/src/core/asks.js';
import { JobExecutor } from '../adapter/jobs.js';
import { SandboxProvider } from '../../../host/src/core/sandbox.js';
import { BudgetGovernor } from '../../../host/src/core/budget.js';
import { installBudgetFetch, collectProviderHosts } from '../adapter/budgetfetch.js';
import { WorkspaceWriteLease } from '../adapter/writelease.js';
import { LoopDetector } from '../../../host/src/core/loopwatch.js';
import { HookRunner } from '../../../host/src/core/hooks.js';
import { shadowJudgeFromEnv } from '../../../host/src/core/shadowjudge.js';
import { loadSteering } from '../../../host/src/core/steering.js';
import { PaiIgnore } from '../../../host/src/core/paiignore.js';
import { ModePresets } from '../../../host/src/core/modes.js';

/** Operator env lever — a number or undefined; never NaN into limits. */
function numEnv(name) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}
import { delegateTool, jobStatusTool } from '../adapter/delegate.js';
import { updateTodosTool, readTodos } from '../adapter/todos.js';
import { askUserTool } from '../adapter/askuser.js';
import { webFetchTool, webSearchTool } from '../adapter/web.js';
import { scheduleTool, startSchedulerPump } from '../adapter/schedule.js';
import { sessionSearchTool } from '../adapter/sessionsearch.js';
import { specTools } from '../adapter/specs.js';
import { ScheduleStore } from '../../../host/src/core/scheduler.js';
import { loadAgentProfiles } from '../adapter/agentprofiles.js';
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
  let riskMode = 'normal';
  let modeOverlay = null; // named preset overlay (Policy Preset Overlay)
  // Presets re-read on every list/set so an edited modes.json takes effect
  // on the next mode_set without a respawn (two small JSONs — negligible).
  const loadModePresets = () => new ModePresets({ instanceRoot, workdir });
  const core = createHostCore({
    instanceRoot,
    manifestPath: join(PI_ROOT, 'extensions', 'managed-manifest.json'),
    governance: {
      // pi body supplies the real shell parser; host never imports pi code
      commandClassifier: parseShellCommand,
      commandArgs: { powershell: 'command', bash: 'command', shell: 'command' },
      // no responder yet = fail-closed deny, never crash-open
      ask: (pending, signal) => (asks ? asks.ask(pending, signal) : Promise.resolve('deny')),
      // session risk mode — 'plan' turns the session read-only (mutating
      // calls escalate to ask). Session-scoped: resets on session switch.
      modeProvider: () => riskMode,
      modeOverlay: () => modeOverlay,
      mutatingTools: ['write', 'edit', 'delete'],
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

  asks = new PendingAsks({ audit: core.audit }, join(core.paths.root, 'always-allow.json'));

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

  // Bounded autonomy: cumulative spend gate. Limits come from the attested
  // policy doc (policy.doc.budget) or the operator env — never from anything
  // the agent can reach. The ledger is append-only so session rewind can
  // never un-spend tokens.
  const budget = new BudgetGovernor({
    ledgerPath: join(core.paths.root, 'budget-ledger.jsonl'),
    limits: core.policy.doc?.budget ?? {
      maxTokensPerSession: numEnv('PAI_BUDGET_MAX_TOKENS'),
      maxCostPerSessionUsd: numEnv('PAI_BUDGET_MAX_COST_USD'),
      maxCallsPerSession: numEnv('PAI_BUDGET_MAX_CALLS'),
    },
    audit: core.audit,
  });

  // Workspace write mutex: a mutating durable job holds it; foreground
  // mutating calls are refused while held. Closes the fore/background race.
  const writeLease = new WorkspaceWriteLease(join(core.paths.root, 'workspace-write-lease.json'));

  // M4: durable jobs — state machine in host, executor in the body.
  const jobStore = new JobStore(join(core.paths.root, 'jobs', 'durable_jobs.db'));
  const executor = new JobExecutor(jobStore, join(core.paths.root, 'jobs'), {
    audit: core.audit,
    runId,
    writeLease,
    classifier: parseShellCommand,
    budget, // child PAI_USAGE bills into the spawning session's scope
    sandbox: SandboxProvider.fromEnv(), // PAI_SANDBOX=none|wsl — durable-job surface only
  });
  // cold-start sweep: dead workers from a previous process get recovered or
  // parked for review — never silently abandoned
  const recoveryActions = executor.recover({ workdir });

  // Durable schedule pump: due entries fire as durable jobs (own write lease,
  // restart-safe); boot tick catches up missed fires exactly once. The store
  // instance is shared with the schedule_task tool so list shows live truth.
  const scheduleStore = new ScheduleStore(core.paths.root);
  const schedulerPump = startSchedulerPump({
    store: scheduleStore,
    executor,
    workdir,
    audit: core.audit,
    getScope: () => currentSession?.sessionId ?? null,
  });

  const customTools = [
    jobStatusTool(jobStore),
    updateTodosTool(core.paths.root, () => currentSession?.sessionId ?? null),
    // structured operator questions — kind:'question' asks bypass session
    // auto-allow by design (a question can never answer itself)
    askUserTool(() => asks),
    // network tools — web_fetch always on (policy maps it to ask); web_search
    // only when the operator configures an endpoint (never advertised empty)
    webFetchTool(),
    ...(process.env.PAI_WEB_SEARCH_URL
      ? [webSearchTool({ endpoint: process.env.PAI_WEB_SEARCH_URL, apiKey: process.env.PAI_WEB_SEARCH_KEY ?? null })]
      : []),
    scheduleTool(scheduleStore),
    // agent-facing past-session recall — same index the operator's Ctrl+K
    // uses, late-bound to sessionsFacade.search (built below)
    sessionSearchTool(() => sessionsFacade.search),
    // G11 thin SDD: spec artifacts under .pai/specs/ — the model writes
    // docs via governed write/edit; these tools only scaffold + report
    ...specTools({ getWorkdir: () => workdir }),
  ];
  if (delegationCommand) customTools.push(delegateTool(executor, {
    commandFor: delegationCommand,
    workdir,
    getScope: () => currentSession?.sessionId ?? null,
    budget,
    // frontmatter subagent personas: project .pai/agents + instance agents/
    profiles: loadAgentProfiles({ workdir, instanceRoot: core.paths.root }),
  }));

  // M2 production wiring: policy-denied tools never reach the visible surface
  // (excludeTools at construction); runtime terminate-level denials hide the
  // tool via ToolSurface + deny-memory so a restart reproduces the same view.
  const initialDeny = Object.entries(core.policy.toolPolicy)
    .filter(([, rules]) => rules?.action === 'deny')
    .map(([name]) => name);
  const fileOps = new FileOpsGuard(core.paths.root);
  let toolSurface = null; // assigned once the session exists — decide runs later
  let currentDecide = null; // per-session decide fn — carries the turn-call budget

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
      // live provider — not a snapshot; steering files are workdir-scoped
      // context composed at this boundary (host core stays workdir-blind)
      contextEnvelope: () => ({
        ...core.contextProvider(),
        steering: loadSteering(workdir),
        // moim-style turn budget hint: consumed/limits visible every turn so
        // the model paces itself instead of learning at the hard gate.
        budget: (() => {
          if (!budget?.configured) return null;
          const c = budget.consumed(currentSession?.sessionId ?? 'unknown');
          const l = budget.limits ?? {};
          const parts = [];
          if (l.maxTokensPerSession) parts.push(`tokens ${c.tokens}/${l.maxTokensPerSession} (${Math.round(100 * c.tokens / l.maxTokensPerSession)}%)`);
          if (l.maxCostPerSessionUsd) parts.push(`cost $${c.cost.toFixed(4)}/$${l.maxCostPerSessionUsd}`);
          if (l.maxCallsPerSession) parts.push(`calls ${c.calls}/${l.maxCallsPerSession}`);
          return parts.length
            ? `session budget consumed: ${parts.join(', ')} — pace accordingly; exceeding a limit halts the session`
            : null;
        })(),
      }),
      audit: core.audit,
      customTools,
      excludeTools: initialDeny,
      // revalidate defaults to the session's own tool registry via pi-ai
      // Pi ctx carries the name at ctx.toolCall.name; the kernel contract is
      // ctx.toolName — translate at the boundary, don't leak Pi shape inward.
      decide: (currentDecide = makeDecide({
        core, executor, fileOps,
        getSurface: () => toolSurface,
        workdir,
        writeLease,
        classifier: parseShellCommand,
        getSessionScope: () => currentSession?.sessionId ?? null,
        // stuck-loop scoring is session-scoped: a rebuilt session starts fresh
        loopwatch: new LoopDetector(),
        asks, // loop escalations reuse the operator-ask surface
        // G9: env-configured shadow LLM — telemetry only, never authoritative
        shadowJudge: shadowJudgeFromEnv({ audit: core.audit }),
        // workdir context exclusion — rebuilt per session so .paiignore edits
        // take effect on the next session build
        paiignore: new PaiIgnore(workdir),
      })),
      writeLease,
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

  // Authoritative budget admission sits at the provider-request layer, not
  // just the channel entry — auto-retry, compaction summarizer, and provider
  // retries all end in an HTTP call through this fetch. Denial is a synthetic
  // 402 (non-retryable 4xx) so an over-budget request fails once, cleanly.
  const ungateFetch = installBudgetFetch({
    budget,
    getScope: () => currentSession?.sessionId ?? 'unknown',
    getProviderHosts: () => collectProviderHosts(currentSession?.modelRuntime),
    audit: core.audit,
    onGateEvent: process.env.PAI_BUDGET_GATE_DEBUG
      ? (e) => process.stderr.write(`[budget-gate] ${JSON.stringify(e)}\n`)
      : null,
  });

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
    asks.abortPending(); // questions/asks from the old session must not leak
    asks.resetSession(); // "本会话允许" grants die with the conversation
    riskMode = 'normal'; // plan mode is session-scoped too
    modeOverlay = null; // preset overlays die with the session as well
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
    // Full-text search across persisted session JSONL — the sidebar filter
    // only covers name/firstMessage; this scans message bodies too.
    search: async (query) => {
      const q = String(query ?? '').toLowerCase().trim();
      if (!q) return [];
      const metas = new Map((await sessionManagers.list(workdir, sessionDir)).map((s) => [s.path, s]));
      const hits = [];
      let files;
      try { files = readdirSync(sessionDir).filter((x) => x.endsWith('.jsonl')); }
      catch { return []; }
      for (const f of files) {
        const p = join(sessionDir, f);
        const snippets = [];
        try {
          for (const line of readFileSync(p, 'utf-8').split('\n')) {
            if (!line.includes(q) && !line.toLowerCase().includes(q)) continue;
            let e; try { e = JSON.parse(line); } catch { continue; }
            const c = e?.message?.content ?? e?.content;
            const flat = typeof c === 'string' ? c
              : Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text).join(' ') : '';
            const idx = flat.toLowerCase().indexOf(q);
            if (idx < 0) continue;
            snippets.push(flat.slice(Math.max(0, idx - 40), idx + q.length + 60).trim());
            if (snippets.length >= 3) break;
          }
        } catch { continue; }
        if (snippets.length) hits.push({ path: p, ...sessionInfo(metas.get(p) ?? { path: p }), snippets });
      }
      return hits;
    },
    // Deleting the LIVE session would orphan its in-memory tree — refuse;
    // the caller switches away first.
    remove: async (path) => {
      const live = currentSession?.sessionManager?.getSessionFile?.();
      if (live && resolve(path) === resolve(live)) throw new Error('cannot delete the active session');
      return sessionManagers.remove(path, sessionDir);
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
    // /btw — a side question on an EPHEMERAL fork: same context, answer never
    // lands in the live transcript. The fork is a real governed session
    // (same guard/lease/audit) — read-only is enforced by the operator's
    // intent, not by faking a restricted tool surface. Fork file deleted
    // after; the live session never rebinds.
    btw: async (message) => {
      const liveFile = currentSession?.sessionManager?.getSessionFile?.();
      if (!liveFile) throw new Error('no live session to fork for btw');
      const forkMgr = sessionManagers.forkFrom(liveFile, workdir, sessionDir);
      const forkFile = forkMgr?.getSessionFile?.() ?? forkMgr?.path ?? null;
      const built = await buildSession(forkMgr);
      const s = built.session;
      try {
        core.audit.write({ kind: 'BTW_FORK', runId, data: { preview: String(message).slice(0, 120) } });
        await Promise.race([
          s.prompt(message),
          new Promise((_, rej) => setTimeout(() => rej(new Error('btw timed out after 120s')), 120_000)),
        ]);
        const last = [...(s.messages ?? [])].reverse().find((m) => m.role === 'assistant');
        const text = Array.isArray(last?.content)
          ? last.content.filter((b) => b?.type === 'text').map((b) => b.text).join('')
          : (typeof last?.content === 'string' ? last.content : '');
        return { answer: text || '(无回答)', ephemeral: true };
      } finally {
        try { s.dispose?.(); } catch { /* best-effort */ }
        if (forkFile) { try { sessionManagers.remove(forkFile, sessionDir); } catch { /* leftover fork file is cosmetic */ } }
        core.audit.write({ kind: 'BTW_DONE', runId });
      }
    },
  };

  // G5: typed lifecycle hooks — observational only, never in the decide path
  // (hook config is agent-writable workdir state; a veto there would let the
  // agent gate itself). Absent .pai/hooks.json → no-op; malformed config
  // throws at boot so the operator hears about it.
  const hooks = new HookRunner(workdir, { audit: core.audit });

  // M6: the UI-facing channel — consumers speak the host protocol, never pi's
  channelHandle = createChannelHost({
    session, core, jobs: jobStore, jobDetail: executor,
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
    fileops: {
      list: (n) => fileOps.list(n),
      listAll: () => fileOps.listAll(),
      restore: async (receiptId) => ({ restored: fileOps.restore(receiptId) }),
      diff: (n) => fileOps.diff(n),
    },
    budget,
    writeLease,
    hooks,
    turns: { reset: () => currentDecide?.resetTurn?.() },
    modes: {
      get: () => riskMode,
      set: (m) => { riskMode = m; core.audit.write({ kind: 'RISK_MODE_SET', data: { mode: m } }); return riskMode; },
      list: () => [
        { name: 'normal', description: 'full posture', source: 'builtin' },
        { name: 'plan', description: 'read-only planning — mutations escalate to operator asks', source: 'builtin' },
        ...loadModePresets().list(),
      ],
      active: () => modeOverlay?.name ?? riskMode,
      setMode: (name) => {
        if (name === 'normal' || name === 'plan') {
          riskMode = name;
          modeOverlay = null;
          toolSurface?.setModeDenied([]);
          core.audit.write({ kind: 'MODE_SET', data: { mode: name, overlay: null } });
          return { mode: name };
        }
        const overlay = loadModePresets().compile(name); // null = unknown → fail closed
        if (!overlay) return null;
        riskMode = 'normal'; // the overlay is the posture; keep plan orthogonal
        modeOverlay = overlay;
        toolSurface?.setModeDenied(overlay.hideTools);
        core.audit.write({ kind: 'MODE_SET', data: { mode: name, overlay: true, policy_hash: overlay.hash } });
        return { mode: name, overlay: { hideTools: overlay.hideTools, defaultAction: overlay.defaultAction } };
      },
    },
    todos: {
      list: () => readTodos(core.paths.root, currentSession?.sessionId ?? null),
    },
  });
  const channel = channelHandle.channel;

  const dispose = () => {
    ungateFetch();
    schedulerPump.dispose();
    releaseWriter();
    asks.dispose();
    channelHandle.dispose();
    currentSession.dispose?.();
    jobStore.db.close();
    core.leases.close();
  };

  return { ...core, identity, session, guard, runId, jobStore, executor, recoveryActions, channel, toolSurface, fileOps, dispose };
}
