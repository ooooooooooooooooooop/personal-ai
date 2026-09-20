import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, mkdirSync, copyFileSync, statSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHostCore } from '../../../host/src/app/host.js';
import { createPiSession, sessionManagers } from '../adapter/index.js';
import { parseShellCommand } from '../adapter/command-parse.js';
import { ContinuationGovernor } from '../../../host/src/core/continuation.js';
import { selectBody } from '../../../host/src/core/eligibility.js';
import { JobStore } from '../../../host/src/core/jobs.js';
import { TaskStore } from '../../../host/src/core/tasks.js';
import { MemoryStore, memoryDbPath } from '../../../host/src/core/memory.js';
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
import { loadPins, editPins } from '../../../host/src/core/pins.js';
import { PaiIgnore } from '../../../host/src/core/paiignore.js';
import { ModePresets, validateModesDoc } from '../../../host/src/core/modes.js';

/** Operator env lever — a number or undefined; never NaN into limits. */
function numEnv(name) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Bounded shell for `!cmd` operator direct-exec — 200KB cap, 120s kill. */
function runShell(command, cwd) {
  return new Promise((resolveP) => {
    const child = spawn(command, { shell: true, cwd, windowsHide: true });
    const cap = 200 * 1024;
    let out = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGTERM'); }, 120_000);
    const eat = (d) => { if (out.length < cap) out += d.toString('utf-8'); };
    child.stdout.on('data', eat);
    child.stderr.on('data', eat);
    child.on('error', (e) => { clearTimeout(timer); resolveP({ ok: false, code: -1, output: String(e.message) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveP({ ok: code === 0, code: killed ? -9 : (code ?? -1), output: out + (killed ? '\n[killed: 120s timeout]' : '') });
    });
  });
}
import { delegateTool, jobStatusTool } from '../adapter/delegate.js';
import { taskTools } from '../adapter/tasktools.js';
import { memoryTools } from '../adapter/memtools.js';
import { loadMicroagents, matchMicroagents, renderKnowledge } from '../../../host/src/core/microagents.js';
import { updateTodosTool, readTodos } from '../adapter/todos.js';
import { askUserTool } from '../adapter/askuser.js';
import { notifyUserTool } from '../adapter/notify.js';
import { skillTools } from '../adapter/skilltools.js';
import { createVerifier } from '../adapter/verify.js';
import { webFetchTool, webSearchTool } from '../adapter/web.js';
import { browserTools } from '../adapter/browser.js';
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
      // Roo command allowlist — OPERATOR-owned <instance>/command-allow.json
      // (never the workdir): matching prefixes skip the approval card. Only
      // consulted inside the kernel's ask path — it can soften an ask, never
      // a deny. Re-read per call so operator edits take effect live.
      commandAllowlist: (ctx) => {
        const arg = { powershell: 'command', bash: 'command', shell: 'command', cmd: 'command' }[ctx.toolName];
        const c = arg ? ctx.args?.[arg] : null;
        if (typeof c !== 'string') return false;
        let prefixes = [];
        try {
          const doc = JSON.parse(readFileSync(join(instanceRoot, 'command-allow.json'), 'utf-8'));
          prefixes = (Array.isArray(doc?.allowPrefixes) ? doc.allowPrefixes : []).map((p) => String(p).trim()).filter(Boolean).slice(0, 100);
        } catch { return false; }
        return prefixes.some((p) => c.trim().startsWith(p));
      },
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

  // F-family AgentTask mailbox — durable task records binding delegation
  // jobs to two-way inbox/outbox/event streams (v1: parent↔child only).
  const taskStore = new TaskStore(core.paths.root);
  // G-family canonical memory — SQLite + FTS5 recall; pinned rows inject
  // into every context envelope as untrusted evidence.
  const memoryStore = new MemoryStore(memoryDbPath(core.paths.root));
  // D2 full browser: CDP tools register only when a browser binary is
  // found (unconfigured = not advertised). Dedicated profile dir keeps
  // the operator's real cookies/credentials out of reach.
  const browserToolset = browserTools({ instanceRoot: core.paths.root, audit: core.audit });
  const customTools = [
    jobStatusTool(jobStore),
    ...taskTools(taskStore, { interrupt: (jobId) => executor.cancel(jobId, 'task_interrupt') }),
    ...memoryTools(memoryStore),
    updateTodosTool(core.paths.root, () => currentSession?.sessionId ?? null),
    // structured operator questions — kind:'question' asks bypass session
    // auto-allow by design (a question can never answer itself)
    askUserTool(() => asks),
    // one-way operator notification — the emit target is the channel handle
    // built below (late-bound); unlike ask_user this never suspends the turn
    notifyUserTool(() => (ev) => channelHandle?.channel.emitEvent(ev)),
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
    // self-authored skills (triggered knowledge) + durable plan library —
    // agent writes .pai/microagents|plans, governed like every other call
    ...skillTools({ workdir, audit: core.audit }),
    ...browserToolset,
  ];
  if (delegationCommand) customTools.push(delegateTool(executor, {
    commandFor: delegationCommand,
    workdir,
    getScope: () => currentSession?.sessionId ?? null,
    budget,
    // frontmatter subagent personas: project .pai/agents + instance agents/
    profiles: loadAgentProfiles({ workdir, instanceRoot: core.paths.root }),
    // every delegation becomes a mailbox-backed AgentTask — the bridge
    // binds --task-dir for real two-way coordination
    taskStore,
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
  let currentGovernor = null; // evidence contract governor — goals status source
  let currentLoopwatch = null; // per-session detector — pump feeds results into it

  // Sessions persist under the instance root — the app lists/resumes them.
  const sessionDir = join(core.paths.root, 'sessions');
  const agentDir = join(core.paths.root, 'pi-agent');

  // G5 operator gate: <instance>/hooks.json is outside the workdir — the
  // agent cannot reach it, so its 'pre_tool' event is a real veto (Claude
  // Code PreToolUse analogue), unlike the observational workdir hooks.
  // Absent file → empty runner, zero per-call cost. Created before
  // buildSession because the decide chain closes over it.
  const preToolGate = new HookRunner(workdir, {
    audit: core.audit,
    configPath: join(core.paths.root, 'hooks.json'),
    gate: true,
  });

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
        // pinned memory rides the context envelope as untrusted evidence —
        // recalled claims, never an authority channel
        memoryDigest: memoryStore.injection(),
        // /context add analogue — .pai/pins.json paths re-read live each
        // turn; .paiignore still wins over pinning (context exclusion holds)
        pins: loadPins(workdir, { isIgnored: (p) => new PaiIgnore(workdir).isIgnored(p) }),
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
        loopwatch: (currentLoopwatch = new LoopDetector()),
        asks, // loop escalations reuse the operator-ask surface
        // G9: env-configured shadow LLM — telemetry only, never authoritative
        shadowJudge: shadowJudgeFromEnv({ audit: core.audit }),
        // workdir context exclusion — rebuilt per session so .paiignore edits
        // take effect on the next session build
        paiignore: new PaiIgnore(workdir),
        // operator-private pre_tool veto hooks (gate HookRunner below)
        preToolGate,
      })),
      writeLease,
      loopGovernance: taskRequirements.length
        ? {
            continuation: (currentGovernor = new ContinuationGovernor({
              ledgerPath: join(core.paths.root, 'continuation.jsonl'),
              audit: core.audit,
              requirements: taskRequirements,
            })),
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

  // F-family topology: a delegated child claims its mailbox by writing its
  // run scope back into task.json (PAI_TASK_DIR is bridge-exported). Task
  // lists can then resolve parent_task_id (a spawning scope) → this task,
  // so nested delegation renders as a real tree. Called on (re)build because
  // the scope is the session id — a rebuilt session re-claims.
  const claimTaskScope = () => {
    const dir = process.env.PAI_TASK_DIR;
    const scope = currentSession?.sessionId;
    if (!dir || !scope) return;
    try {
      const metaPath = join(dir, 'task.json');
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      if (meta.run_scope === scope) return;
      meta.run_scope = scope;
      writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      const evPath = join(dir, 'events.jsonl');
      const seq = existsSync(evPath)
        ? readFileSync(evPath, 'utf-8').split('\n').filter(Boolean).length + 1
        : 1;
      appendFileSync(evPath,
        `${JSON.stringify({ seq, ts: new Date().toISOString(), kind: 'scope_claimed', data: { run_scope: scope } })}\n`);
    } catch { /* foreign/unreadable task dir — best effort */ }
  };
  claimTaskScope();

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
    claimTaskScope();
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
    // review-triggered hygiene: a session boundary is the natural review
    // moment — distill merges/decays/archived memory deterministically.
    setImmediate(() => {
      try {
        const d = memoryStore.distill();
        if (d.demoted || d.archived) core.audit.write({ kind: 'MEMORY_DISTILLED', runId, data: d });
      } catch { /* hygiene is best-effort */ }
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
    list: async () => {
      const rows = (await sessionManagers.list(workdir, sessionDir)).map(sessionInfo);
      // Goose session-type facet: a session claimed as a task's run_scope is
      // a spawned child — surfaced as 'subagent'/'teammate' so the drawer
      // can distinguish operator sessions from delegated ones.
      const byScope = new Map(taskStore.list().filter((t) => t.run_scope).map((t) => [t.run_scope, t]));
      for (const s of rows) {
        const t = byScope.get(s.id);
        if (t) s.type = t.kind === 'teammate' ? 'teammate' : 'subagent';
      }
      return rows;
    },
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
    // entryId (ZCode fork-from-any-assistant-message): navigate the fork's
    // tree head to that entry first — the fork inherits history up to the
    // chosen point instead of the source's current leaf.
    fork: async (path, { entryId = null } = {}) => {
      const s = await rebuildSession(sessionManagers.forkFrom(path, workdir, sessionDir), 'fork');
      if (entryId) await s.navigateTree?.(String(entryId));
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
    // /chat save (Gemini): named snapshot of the live transcript — the file
    // is copied under sessions/saved/ so the live session keeps moving while
    // the checkpoint stays resumable via session_switch on its path.
    save: async (name) => {
      const n = String(name ?? '').trim();
      if (!/^[\w-][\w -]{0,39}$/.test(n)) throw new Error('save name: 1-40 chars — letters/digits/space/-/_');
      const src = currentSession?.sessionManager?.getSessionFile?.();
      if (!src) throw new Error('no live session file to snapshot');
      const dir = join(sessionDir, 'saved');
      mkdirSync(dir, { recursive: true });
      const dst = join(dir, `${n}.jsonl`);
      copyFileSync(src, dst);
      core.audit.write({ kind: 'SESSION_SAVED', runId, data: { name: n, path: dst } });
      return { name: n, path: dst };
    },
    savedList: async () => {
      const dir = join(sessionDir, 'saved');
      let files;
      try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); }
      catch { return []; }
      return files.map((f) => {
        const p = join(dir, f);
        return { name: f.replace(/\.jsonl$/, ''), path: p, modified: statSync(p).mtime.toISOString() };
      }).sort((a, b) => b.modified.localeCompare(a.modified));
    },
    // AgentStats (Vibe): aggregate usage across persisted session files —
    // bounded scan of the newest N files; cost/token truth comes from
    // per-entry usage, not estimates.
    agentStats: async () => {
      let files;
      try {
        files = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'))
          .map((f) => join(sessionDir, f))
          .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
          .slice(0, 200);
      } catch { return { sessions: 0, messages: 0, tokens: 0, cost: 0 }; }
      const agg = { sessions: files.length, messages: 0, userMessages: 0, tokens: 0, cost: 0 };
      let first = null, last = null;
      for (const p of files) {
        const mt = statSync(p).mtime;
        if (!last || mt > last) last = mt;
        if (!first || mt < first) first = mt;
        try {
          for (const line of readFileSync(p, 'utf-8').split('\n')) {
            if (!line) continue;
            let e; try { e = JSON.parse(line); } catch { continue; }
            const role = e?.message?.role ?? e?.role;
            if (role === 'user') { agg.messages++; agg.userMessages++; }
            else if (role === 'assistant') {
              agg.messages++;
              const u = e?.message?.usage ?? e?.usage;
              if (u) {
                agg.tokens += Number(u.totalTokens ?? u.input ?? 0) + Number(u.output ?? 0);
                agg.cost += Number(u.cost?.total ?? 0);
              }
            }
          }
        } catch { continue; }
      }
      return {
        ...agg,
        cost: Number(agg.cost.toFixed(4)),
        firstSession: first?.toISOString?.() ?? null,
        lastSession: last?.toISOString?.() ?? null,
      };
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
    // task facade — channel-facing mirror of the model's task_* tools
    tasks: {
      list: () => taskStore.list(),
      get: (id) => taskStore.get(id),
      read: (id, s, since) => taskStore.read(id, s, since),
      postInbox: (id, m) => taskStore.postInbox(id, m),
      postEvent: (id, k, d) => taskStore.postEvent(id, k, d),
      setState: (id, s) => taskStore.setState(id, s),
      interrupt: (jobId) => executor.cancel(jobId, 'task_interrupt'),
    },
    memory: memoryStore,
    // H-family microagents — .pai/microagents/*.md frontmatter triggers
    // inject topic-scoped knowledge into the matching prompt, this turn only
    knowledge: {
      match: (text) => {
        const hits = matchMicroagents(loadMicroagents(workdir), text);
        return hits.length ? { text: renderKnowledge(hits), agents: hits.map((h) => h.name) } : null;
      },
    },
    asks,
    goals: () => currentGovernor?.status() ?? null,
    // Aider lint/test reflection loop — armed by .pai/verify.json, gated by
    // the same shell classifier + riskActions the kernel enforces
    verify: createVerifier({
      workdir,
      classify: parseShellCommand,
      riskActions: core.policy.doc?.riskActions ?? null,
      audit: core.audit,
      emit: (ev) => channelHandle?.channel.emitEvent(ev),
      observations: core.observations,
    }),
    // Roo command allow/deny lists, split by who owns the file:
    //   .pai/commands.json (workdir) — denyPrefixes only; the project file can
    //     tighten, never widen — a stray allowPrefixes key is a validation error
    //   <instance>/command-allow.json — operator-owned allowlist that skips
    //     approval cards for matching command prefixes
    commands: {
      readProject: () => {
        const f = join(workdir, '.pai', 'commands.json');
        try { return { path: f, content: readFileSync(f, 'utf-8') }; }
        catch { return { path: f, content: '' }; }
      },
      saveProject: (content) => {
        let doc;
        try { doc = JSON.parse(content); }
        catch (e) { return { error: `invalid JSON: ${e.message}` }; }
        const keys = Object.keys(doc ?? {});
        if (keys.some((k) => k !== 'denyPrefixes')) {
          return { error: 'only denyPrefixes is allowed here — allow lists live in the operator-owned command-allow.json' };
        }
        if (!Array.isArray(doc.denyPrefixes ?? []) || (doc.denyPrefixes ?? []).some((p) => typeof p !== 'string' || !p.trim())) {
          return { error: 'denyPrefixes must be an array of non-empty strings' };
        }
        mkdirSync(join(workdir, '.pai'), { recursive: true });
        const f = join(workdir, '.pai', 'commands.json');
        writeFileSync(f, JSON.stringify({ denyPrefixes: doc.denyPrefixes ?? [] }, null, 2) + '\n');
        core.audit.write({ kind: 'COMMANDS_SAVED', data: { file: '.pai/commands.json', denyPrefixes: (doc.denyPrefixes ?? []).length } });
        return { ok: true, path: f };
      },
      readAllow: () => {
        const f = join(instanceRoot, 'command-allow.json');
        try { return { path: f, content: readFileSync(f, 'utf-8') }; }
        catch { return { path: f, content: '' }; }
      },
      saveAllow: (content) => {
        let doc;
        try { doc = JSON.parse(content); }
        catch (e) { return { error: `invalid JSON: ${e.message}` }; }
        const keys = Object.keys(doc ?? {});
        if (keys.some((k) => k !== 'allowPrefixes')) return { error: 'only allowPrefixes is allowed' };
        if (!Array.isArray(doc.allowPrefixes ?? []) || (doc.allowPrefixes ?? []).some((p) => typeof p !== 'string' || !p.trim())) {
          return { error: 'allowPrefixes must be an array of non-empty strings' };
        }
        const f = join(instanceRoot, 'command-allow.json');
        writeFileSync(f, JSON.stringify({ allowPrefixes: doc.allowPrefixes ?? [] }, null, 2) + '\n');
        core.audit.write({ kind: 'COMMAND_ALLOW_SAVED', data: { file: 'command-allow.json', allowPrefixes: (doc.allowPrefixes ?? []).length } });
        return { ok: true, path: f };
      },
    },
    fileops: {
      list: (n) => fileOps.list(n),
      listAll: () => fileOps.listAll(),
      restore: async (receiptId) => ({ restored: fileOps.restore(receiptId) }),
      diff: (n, receiptId) => fileOps.diff(n, receiptId),
    },
    // /context add analogue — pinned files re-read live into the envelope
    // every turn. .paiignore wins over pinning both at add time and render.
    pins: {
      list: () => editPins(workdir, 'list'),
      add: (p) => {
        const r = editPins(workdir, 'add', p, { isIgnored: (x) => new PaiIgnore(workdir).isIgnored(x) });
        if (!r.error && !r.unchanged) core.audit.write({ kind: 'PIN_ADDED', data: { path: String(p).slice(0, 200) } });
        return r;
      },
      remove: (p) => {
        const r = editPins(workdir, 'remove', p);
        if (!r.error) core.audit.write({ kind: 'PIN_REMOVED', data: { path: String(p).slice(0, 200) } });
        return r;
      },
    },
    budget,
    writeLease,
    hooks,
    turns: { reset: () => currentDecide?.resetTurn?.() },
    getLoopwatch: () => currentLoopwatch,
    exec: {
      // `!cmd` operator direct-exec (Claude Code bang-mode analogue): the
      // command runs through the SAME decide chain as a model call — ask
      // rules still pop the approval card, denies still block. Operator
      // typing is not a policy bypass.
      run: async (command) => {
        if (!currentDecide) return { ok: false, error: 'session not ready' };
        const callId = `op-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
        const emit = (ev) => channelHandle?.channel.emitEvent(ev);
        const d = await currentDecide({ toolCall: { name: 'bash', id: callId }, args: { command } });
        emit({ type: 'tool_execution_start', toolCallId: callId, toolName: 'bash', args: { command } });
        if (d?.block) {
          emit({ type: 'tool_execution_end', toolCallId: callId, toolName: 'bash', result: d.reason ?? 'blocked', isError: true });
          core.audit.write({ kind: 'OPERATOR_BASH_BLOCK', data: { command: command.slice(0, 200), rule: d.rule ?? 'deny' } });
          return { ok: false, blocked: true, reason: d.reason ?? 'blocked' };
        }
        const r = await runShell(command, workdir);
        emit({ type: 'tool_execution_end', toolCallId: callId, toolName: 'bash', result: r.output.slice(0, 8000), isError: r.code !== 0 });
        core.audit.write({ kind: 'OPERATOR_BASH', data: { command: command.slice(0, 200), code: r.code } });
        return r;
      },
    },
    modes: {
      get: () => riskMode,
      set: (m) => { riskMode = m; core.audit.write({ kind: 'RISK_MODE_SET', data: { mode: m } }); return riskMode; },
      list: () => [
        { name: 'normal', description: 'full posture', source: 'builtin' },
        { name: 'plan', description: 'read-only planning — mutations escalate to operator asks', source: 'builtin' },
        { name: 'review', description: 'read-only review posture — mutation tools denied, execution asks', source: 'builtin' },
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
        if (name === 'review') {
          // builtin review posture (Codex /review analogue): same overlay
          // shape a project preset compiles to — denies mutation tools,
          // escalates execution; can never widen anything canonical denies
          modeOverlay = {
            name: 'review',
            toolActions: { write: 'deny', edit: 'deny', delete: 'deny', bash: 'ask', delegate_task: 'ask' },
            allowSet: new Set(),
            pathRules: [],
            defaultAction: 'allow',
            hideTools: [],
            hash: 'builtin-review',
          };
          riskMode = 'normal';
          toolSurface?.setModeDenied([]);
          core.audit.write({ kind: 'MODE_SET', data: { mode: 'review', overlay: true, policy_hash: 'builtin-review' } });
          return { mode: 'review', overlay: { hideTools: [], defaultAction: 'allow' } };
        }
        const overlay = loadModePresets().compile(name); // null = unknown → fail closed
        if (!overlay) return null;
        riskMode = 'normal'; // the overlay is the posture; keep plan orthogonal
        modeOverlay = overlay;
        toolSurface?.setModeDenied(overlay.hideTools);
        core.audit.write({ kind: 'MODE_SET', data: { mode: name, overlay: true, policy_hash: overlay.hash } });
        return { mode: name, overlay: { hideTools: overlay.hideTools, defaultAction: overlay.defaultAction } };
      },
      // project-level editor surface (.pai/modes.json) — validated before
      // write; instance modes.json stays operator-edited, not agent/UI-facing
      readProject: () => {
        const f = join(workdir, '.pai', 'modes.json');
        try { return { path: f, content: readFileSync(f, 'utf-8') }; }
        catch { return { path: f, content: '' }; }
      },
      saveProject: (content) => {
        let doc;
        try { doc = JSON.parse(content); }
        catch (e) { return { error: `invalid JSON: ${e.message}` }; }
        const err = validateModesDoc(doc);
        if (err) return { error: err };
        const f = join(workdir, '.pai', 'modes.json');
        mkdirSync(join(workdir, '.pai'), { recursive: true });
        writeFileSync(f, JSON.stringify(doc, null, 2) + '\n');
        core.audit.write({ kind: 'MODES_SAVED', data: { file: '.pai/modes.json', presets: doc.modes.length } });
        return { ok: true, path: f, presets: doc.modes.length };
      },
    },
    todos: {
      list: () => readTodos(core.paths.root, currentSession?.sessionId ?? null),
    },
  });
  const channel = channelHandle.channel;

  // H-family heartbeat (OpenClaw reference): an OPERATOR-owned config —
  // <instance>/heartbeat.json, never the agent-writable workdir — wakes the
  // session with a prompt when it is idle. Disabled by default; every beat
  // still travels the normal prompt path (budget admission, audit, events).
  const heartbeat = (() => {
    try {
      const cfg = JSON.parse(readFileSync(join(core.paths.root, 'heartbeat.json'), 'utf-8'));
      if (!cfg?.enabled || !(Number(cfg.everyMin) > 0) || !String(cfg.prompt ?? '').trim()) return null;
      return { everyMin: Number(cfg.everyMin), prompt: String(cfg.prompt) };
    } catch { return null; }
  })();
  let heartbeatTimer = null;
  if (heartbeat) {
    heartbeatTimer = setInterval(() => {
      try {
        const s = channelHandle ? currentSession : null;
        if (!s || s.isStreaming) return; // idle-only — never interrupt a run
        core.audit.write({ kind: 'HEARTBEAT_FIRED', runId, data: { everyMin: heartbeat.everyMin } });
        // channel prompt path: admitSpend gates it — a configured budget
        // still bounds autonomous spend; the beat is visible in the UI.
        channelHandle.channel.handle({ type: 'prompt', message: heartbeat.prompt, meta: { heartbeat: true } })
          .catch(() => { /* a refused beat is recorded by the spend gate */ });
      } catch { /* heartbeat is best-effort */ }
    }, heartbeat.everyMin * 60_000);
    heartbeatTimer.unref?.();
    core.audit.write({ kind: 'HEARTBEAT_ARMED', runId, data: { everyMin: heartbeat.everyMin } });
  }

  const dispose = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    ungateFetch();
    schedulerPump.dispose();
    releaseWriter();
    asks.dispose();
    channelHandle.dispose();
    browserToolset.dispose?.(); // browser session teardown (kills the child)
    currentSession.dispose?.();
    jobStore.db.close();
    core.leases.close();
  };

  return { ...core, identity, session, guard, runId, jobStore, executor, recoveryActions, channel, toolSurface, fileOps, dispose };
}
