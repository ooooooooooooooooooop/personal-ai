import { join, resolve, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, mkdirSync, copyFileSync, statSync, writeFileSync, appendFileSync, existsSync, unlinkSync, openSync, writeSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHostCore } from '../../../host/src/app/host.js';
import { createPiSession, sessionManagers } from '../adapter/index.js';
import { parseShellCommand } from '../adapter/command-parse.js';
import { commandAllowlistMatch } from '../adapter/command-allow.js';
import { ContinuationGovernor } from '../../../host/src/core/continuation.js';
import { selectBody } from '../../../host/src/core/eligibility.js';
import { JobStore } from '../../../host/src/core/jobs.js';
import { TaskStore } from '../../../host/src/core/tasks.js';
import { MemoryStore, memoryDbPath } from '../../../host/src/core/memory.js';
import { PendingAsks } from '../../../host/src/core/asks.js';
import { JobExecutor } from '../adapter/jobs.js';
import { SandboxProvider } from '../../../host/src/core/sandbox.js';
import { JudgeAdvisor } from '../../../host/src/core/judge.js';
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

// Windows planted-binary defense (Cline NoDefaultCurrentDirectoryInExePath
// analogue): cmd.exe resolves bare names against the cwd BEFORE PATH, so a
// repo-planted git.exe/rg.exe/node.exe would run with user privileges the
// moment a command mentions it. Set the opt-out on our own env — every
// spawned shell (bash tool, durable jobs, delegate children) inherits it.
// `??=` respects an operator who deliberately unset it.
if (process.platform === 'win32') process.env.NoDefaultCurrentDirectoryInExePath ??= '1';

/** Operator env lever — a number or undefined; never NaN into limits. */
function numEnv(name) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Bounded shell for `!cmd` operator direct-exec — 200KB cap, 120s kill. */
function runShell(command, cwd, { detachedDir = null } = {}) {
  return new Promise((resolveP) => {
    const child = spawn(command, { shell: true, cwd, windowsHide: true });
    const cap = 200 * 1024;
    let out = '';
    let detached = null;
    // M12 (CodeBuddy auto-backgrounding analogue): a foreground command that
    // overruns is NOT killed — it detaches to a log file and keeps running.
    const timer = setTimeout(() => {
      try {
        const dir = detachedDir ?? cwd;
        mkdirSync(dir, { recursive: true });
        detached = join(dir, `detached-${child.pid}.log`);
        const fd = openSync(detached, 'a');
        writeSync(fd, out);
        const eat2 = (d) => { try { writeSync(fd, d); } catch { /* closed */ } };
        child.stdout.removeAllListeners('data');
        child.stderr.removeAllListeners('data');
        child.stdout.on('data', eat2);
        child.stderr.on('data', eat2);
        child.on('close', () => { try { closeSync(fd); } catch { /* */ } });
        child.unref?.();
      } catch { detached = null; /* no dir — fall back to plain timeout note */ }
      resolveP({
        ok: false, code: -9,
        output: out + `\n[转后台运行 — pid ${child.pid}${detached ? ` → ${detached}` : ''}（前台 120s 超时，进程未杀死）]`,
        detached: detached ? { pid: child.pid, log: detached } : null,
      });
    }, 120_000);
    const eat = (d) => { if (out.length < cap) out += d.toString('utf-8'); };
    child.stdout.on('data', eat);
    child.stderr.on('data', eat);
    child.on('error', (e) => { clearTimeout(timer); resolveP({ ok: false, code: -1, output: String(e.message) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveP({ ok: code === 0, code: code ?? -1, output: out });
    });
  });
}
import { delegateTool, jobStatusTool } from '../adapter/delegate.js';
import { jobSpawnTool } from '../adapter/jobs.js';
import { taskTools } from '../adapter/tasktools.js';
import { memoryTools } from '../adapter/memtools.js';
import { loadMicroagents, matchMicroagents, renderKnowledge } from '../../../host/src/core/microagents.js';
import { isTrusted, setTrust, hasInjectableContent } from '../../../host/src/core/trust.js';
import { updateTodosTool, readTodos } from '../adapter/todos.js';
import { askUserTool } from '../adapter/askuser.js';
import { notifyUserTool } from '../adapter/notify.js';
import { skillTools } from '../adapter/skilltools.js';
import { modeRequestTool } from '../adapter/modetools.js';
import { createVerifier } from '../adapter/verify.js';
import { webFetchTool, webSearchTool } from '../adapter/web.js';
import { browserTools } from '../adapter/browser.js';
import { scheduleTool, startSchedulerPump } from '../adapter/schedule.js';
import { MonitorRegistry } from '../adapter/monitor.js';
import { goalCoordinatorTool } from '../adapter/goals.js';
import { GoalStore } from '../../../host/src/core/goals.js';
import { sessionSearchTool, sessionReadTool } from '../adapter/sessionsearch.js';
import { repoMapTool } from '../adapter/repomap.js';
import { buildRepoMap } from '../../../host/src/core/repomap.js';
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
  // Shared by the channel facade AND the model's mode_request tool —
  // Claude ExitPlanMode analogue: the model may REQUEST a mode switch, the
  // operator approves it on an ask card, applyMode performs it.
  const applyMode = (name) => {
    if (name === 'normal' || name === 'plan') {
      riskMode = name;
      modeOverlay = null;
      toolSurface?.setModeDenied([]);
      core.audit.write({ kind: 'MODE_SET', data: { mode: name, overlay: null } });
      return { mode: name };
    }
    if (name === 'review') {
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
    riskMode = 'normal';
    modeOverlay = overlay;
    toolSurface?.setModeDenied(overlay.hideTools);
    core.audit.write({ kind: 'MODE_SET', data: { mode: name, overlay: true, policy_hash: overlay.hash } });
    return { mode: name, overlay: { hideTools: overlay.hideTools, defaultAction: overlay.defaultAction } };
  };
  // P3 judge call seam: POST {baseUrl}/chat/completions with the resolved
  // credential of the session's default provider. Runs through the gated
  // fetch → it IS billed as a provider call. Returns null when the session
  // or provider auth isn't resolvable — the card then shows no advice.
  const judgeCall = async (system, user) => {
    const rt = currentSession?.modelRuntime;
    if (!rt) return null;
    // per-feature model routing: <instance>/feature-models.json may point the
    // judge at a cheaper/stronger model than the session's — judge calls are
    // frequent and low-stakes, so a small model is usually the right pick.
    let feature = null;
    try {
      const fm = JSON.parse(readFileSync(join(instanceRoot, 'feature-models.json'), 'utf-8'));
      feature = fm?.judge ?? null;
    } catch { /* absent file = session model */ }
    const pid = feature?.provider ?? currentSession?.model?.provider ?? rt.getProviders?.()[0]?.id;
    const p = rt.getProvider?.(pid);
    const auth = await rt.getAuth?.(pid).catch(() => undefined);
    const base = auth?.auth?.baseUrl ?? p?.baseUrl;
    const model = feature?.model ?? currentSession?.model?.id ?? currentSession?.model?.model;
    if (!base || !model) return null;
    const headers = { 'content-type': 'application/json', ...(p?.headers ?? {}), ...(auth?.auth?.headers ?? {}) };
    if (auth?.auth?.apiKey) headers.Authorization = `Bearer ${auth.auth.apiKey}`;
    const res = await fetch(`${String(base).replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', headers,
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 160,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    return body?.choices?.[0]?.message?.content ?? null;
  };
  const core = createHostCore({
    instanceRoot,
    manifestPath: join(PI_ROOT, 'extensions', 'managed-manifest.json'),
    governance: {
      // pi body supplies the real shell parser; host never imports pi code
      commandClassifier: parseShellCommand,
      commandArgs: { powershell: 'command', bash: 'command', shell: 'command', job_spawn: 'command' },
      // no responder yet = fail-closed deny, never crash-open
      ask: (pending, signal) => (asks ? asks.ask(pending, signal) : Promise.resolve('deny')),
      // session risk mode — 'plan' turns the session read-only (mutating
      // calls escalate to ask). Session-scoped: resets on session switch.
      modeProvider: () => riskMode,
      modeOverlay: () => modeOverlay,
      // P3 shadow judge (web-review ruling): explicit opt-in PAI_JUDGE=1.
      // Advisory only — opinions ride the approval card to the operator and
      // are audited; they can never flip a verdict. The call seam resolves
      // the configured provider per ask; unconfigured → advisor absent.
      judge: process.env.PAI_JUDGE === '1' ? new JudgeAdvisor({ call: judgeCall }) : null,
      // all write-capable surfaces — a patch-family tool must hit the same
      // instruction-file gate as write/edit (deny-equivalence analogue: a
      // rule covering 'write' must not leak through apply_patch/patch).
      mutatingTools: ['write', 'edit', 'delete', 'patch', 'apply_patch', 'create'],
      // Roo command allowlist — OPERATOR-owned <instance>/command-allow.json
      // (never the workdir): matching prefixes skip the approval card. Only
      // consulted inside the kernel's ask path — it can soften an ask, never
      // a deny. Re-read per call so operator edits take effect live.
      commandAllowlist: (ctx, meta) => {
        const arg = { powershell: 'command', bash: 'command', shell: 'command', cmd: 'command', job_spawn: 'command' }[ctx.toolName];
        const c = arg ? ctx.args?.[arg] : null;
        let prefixes = [];
        try {
          const doc = JSON.parse(readFileSync(join(instanceRoot, 'command-allow.json'), 'utf-8'));
          prefixes = (Array.isArray(doc?.allowPrefixes) ? doc.allowPrefixes : []).map((p) => String(p).trim()).filter(Boolean).slice(0, 100);
        } catch { return false; }
        return commandAllowlistMatch(c, meta, prefixes);
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

  // Skill allow-list lives in the INSTANCE root (operator-private), never in
  // .pai/ — a repo-planted file must not decide which repo-planted knowledge
  // can inject. Per-process hit counts feed the skill-doctor stats surface.
  const skillAllowPath = join(core.paths.root, 'skill-allow.json');
  const skillHitCounts = new Map();
  const readSkillAllow = () => {
    try {
      const doc = JSON.parse(readFileSync(skillAllowPath, 'utf-8'));
      return Array.isArray(doc?.allow) ? new Set(doc.allow.map(String)) : null;
    } catch { return null; }
  };

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
    // M14: scheduled-job completions surface to the UI as an event — a job
    // nobody is watching must still deliver its result somewhere visible.
    onJobFinished: (d) => channelHandle?.channel.emitEvent({ type: 'scheduled_job_done', ...d }),
  });
  // cold-start sweep: dead workers from a previous process get recovered or
  // parked for review — never silently abandoned
  const recoveryActions = executor.recover({ workdir });

  // Durable schedule pump: due entries fire as durable jobs (own write lease,
  // restart-safe); boot tick catches up missed fires exactly once. The store
  // instance is shared with the schedule_task tool so list shows live truth.
  const scheduleStore = new ScheduleStore(core.paths.root);
  const goalStore = new GoalStore(core.paths.root);
  // F-family AgentTask mailbox — durable task records binding delegation
  // jobs to two-way inbox/outbox/event streams (v1: parent↔child only).
  const taskStore = new TaskStore(core.paths.root);
  const schedulerPump = startSchedulerPump({
    store: scheduleStore,
    executor,
    workdir,
    audit: core.audit,
    getScope: () => currentSession?.sessionId ?? null,
    goals: goalStore,
    tasks: taskStore,
    jobStore,
    // governed prompt path (heartbeat analogue): the tick travels the same
    // channel prompt route — budget admission, audit, governance on every
    // tool call in the turn. Busy sessions refuse; the entry stays due.
    promptSink: async (msg) => {
      if (!channelHandle || currentSession?.isStreaming) return { refused: 'busy' };
      const r = await channelHandle.channel.handle({ type: 'prompt', message: msg, meta: { goal_tick: true } });
      return r?.success ? { ok: true } : { refused: r?.error ?? 'prompt refused' };
    },
  });

  // event-driven monitors (CodeBuddy Monitor / ambient-context analogue):
  // operator-armed fs.watch entries wake the session through the SAME
  // governed promptSink as schedule ticks — a busy session refuses.
  const monitors = new MonitorRegistry({
    audit: core.audit,
    promptSink: async (msg) => {
      if (!channelHandle || currentSession?.isStreaming) return { refused: 'busy' };
      const r = await channelHandle.channel.handle({ type: 'prompt', message: msg, meta: { monitor_wake: true } });
      return r?.success ? { ok: true } : { refused: r?.error ?? 'prompt refused' };
    },
  });

  // G-family canonical memory — SQLite + FTS5 recall; pinned rows inject
  // into every context envelope as untrusted evidence.
  const memoryStore = new MemoryStore(memoryDbPath(core.paths.root));
  // D2 full browser: CDP tools register only when a browser binary is
  // found (unconfigured = not advertised). Dedicated profile dir keeps
  // the operator's real cookies/credentials out of reach.
  const browserToolset = browserTools({ instanceRoot: core.paths.root, audit: core.audit });
  // repo_map builds scan hundreds of files — one PaiIgnore instance per
  // build (fresh .paiignore each call, not per file and not boot-stale)
  const repoMapIgnore = () => { const ig = new PaiIgnore(workdir); return (rel) => ig.isIgnored(rel); };
  const customTools = [
    jobStatusTool(jobStore),
    // remote execution (P1): durable command jobs under an optional
    // wsl/docker/ssh boundary — same command classification as bash
    jobSpawnTool(executor, { workdir, getScope: () => currentSession?.sessionId ?? null }),
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
    // egress domain allowlist — operator-owned <instance>/egress-allow.json
    // {allowDomains:[...]}; absent file = unrestricted (governance ask is the
    // baseline). Re-read per call so operator edits take effect live.
    webFetchTool({ egressAllow: () => {
      try {
        const doc = JSON.parse(readFileSync(join(instanceRoot, 'egress-allow.json'), 'utf-8'));
        return Array.isArray(doc?.allowDomains) ? doc.allowDomains.map(String) : null;
      } catch { return null; }
    } }),
    ...(process.env.PAI_WEB_SEARCH_URL
      ? [webSearchTool({ endpoint: process.env.PAI_WEB_SEARCH_URL, apiKey: process.env.PAI_WEB_SEARCH_KEY ?? null })]
      : []),
    scheduleTool(scheduleStore),
    // orchestrator family: long-horizon goals armed with prompt-kind
    // schedules — each tick wakes the agent with live goal context
    goalCoordinatorTool(goalStore, scheduleStore),
    // agent-facing past-session recall — same index the operator's Ctrl+K
    // uses, late-bound to sessionsFacade.search (built below)
    sessionSearchTool(() => sessionsFacade.search),
    sessionReadTool({ sessionDir: join(core.paths.root, 'sessions') }),
    // Aider repo-map analogue: dependency-free structural outline, .paiignore
    // honored — the model gets "where things live" without burning reads
    repoMapTool({ workdir, getIgnored: repoMapIgnore }),
    // G11 thin SDD: spec artifacts under .pai/specs/ — the model writes
    // docs via governed write/edit; these tools only scaffold + report
    ...specTools({ getWorkdir: () => workdir }),
    // self-authored skills (triggered knowledge) + durable plan library —
    // agent writes .pai/microagents|plans, governed like every other call
    ...skillTools({ workdir, audit: core.audit }),
    // Claude ExitPlanMode analogue: the model REQUESTS a mode switch; the
    // operator approves on an ask card. Never self-applies — a model asking
    // to leave plan mode is exactly the escalation the mode exists for.
    modeRequestTool({
      catalogModes: () => ['normal', 'plan', 'review', ...loadModePresets().list().map((m) => m.name)],
      applyMode,
      asks,
    }),
    ...browserToolset,
  ];
  if (delegationCommand) customTools.push(delegateTool(executor, {
    commandFor: delegationCommand,
    workdir,
    getScope: () => currentSession?.sessionId ?? null,
    budget,
    // frontmatter subagent personas: project .pai/agents + instance agents/
    // profile env fields only load under the same trust gate as microagents —
    // a repo-planted profile must never steer the delegate child's environment
    profiles: loadAgentProfiles({ workdir, instanceRoot: core.paths.root, workdirTrusted: isTrusted(core.paths.root, workdir) }),
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
      contextEnvelope: (hint) => ({
        ...core.contextProvider(),
        // Steering isolation (CC omitClaudeMd analogue): a delegated child
        // spawned with --steering-off carries PAI_STEERING_OFF — workdir
        // steering files (AGENTS.md et al.) never reach its context.
        steering: process.env.PAI_STEERING_OFF ? null : loadSteering(workdir),
        // pinned + relevance-recalled memory rides the context envelope as
        // untrusted evidence — recalled claims, never an authority channel
        memoryDigest: memoryStore.injection(12, hint),
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
    search: async (query, { scope = 'all' } = {}) => {
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
            // scope 'prompts' (Kiro session-search-scope analogue): only the
            // user's own messages match — agent replies stay out of recall.
            if (scope === 'prompts') {
              const role = e?.message?.role ?? e?.role;
              if (role !== 'user') continue;
            }
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
    // session import (Cursor/Claude import-session analogue): copy a foreign
    // pi-format session file into the store WITHOUT switching to it — the
    // imported transcript lands in the drawer with a [导入] name marker and
    // forkFrom's parentSession header records the source path (provenance).
    importSession: async (srcPath) => {
      const abs = resolve(String(srcPath ?? ''));
      if (!existsSync(abs)) throw new Error(`session file not found: ${abs}`);
      const mgr = sessionManagers.forkFrom(abs, workdir, sessionDir);
      const srcName = mgr.getSessionName?.() ?? basename(abs);
      mgr.appendSessionInfo?.(`[导入] ${srcName}`);
      return { file: mgr.getSessionFile?.() ?? null, name: `[导入] ${srcName}`, importedFrom: abs };
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
      // Vibe AgentStats outcome buckets — approval answers counted by结局
      // from the ASK_RESOLVED audit trail (survives session reloads)
      const asks = { allow: 0, allow_session: 0, always: 0, deny: 0, timeout: 0, aborted: 0, question_answered: 0 };
      try {
        const auditDir = core.paths?.auditDir;
        if (auditDir && existsSync(auditDir)) {
          for (const f of readdirSync(auditDir).filter((x) => x.endsWith('.jsonl'))) {
            for (const line of readFileSync(join(auditDir, f), 'utf-8').split('\n')) {
              if (!line || !line.includes('ASK_RESOLVED')) continue;
              let e; try { e = JSON.parse(line); } catch { continue; }
              const a = e?.data?.answer;
              if (e?.data?.kind === 'question') { if (a && a !== 'timeout' && a !== 'aborted') asks.question_answered++; else if (a) asks[a]++; }
              else if (a && asks[a] != null) asks[a]++;
            }
          }
        }
      } catch { /* stats are best-effort */ }
      return {
        ...agg,
        cost: Number(agg.cost.toFixed(4)),
        asks,
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
    // operator mirror of schedule_task — same store, list/cancel only
    schedules: {
      list: () => scheduleStore.list(),
      cancel: (id) => scheduleStore.remove(id),
      setEnabled: (id, enabled) => scheduleStore.setEnabled(id, enabled),
    },
    // coordinator surface — operator reads goal truth + sets state
    goalStore: {
      list: () => goalStore.list(),
      setState: (id, state) => goalStore.setState(id, state),
    },
    // event-driven monitors — operator arms/disarms fs watchers that wake
    // the session through the governed prompt path
    monitors: {
      add: ({ path, prompt }) => monitors.add({ path, prompt }),
      remove: (id) => monitors.remove(id),
      list: () => monitors.list(),
    },
    // /map — operator surface over the same builder repo_map wraps
    repoMap: {
      build: (subdir) => buildRepoMap(workdir, { isIgnored: repoMapIgnore(), subdir }),
    },
    workdir, // bash workspace-delta notices diff git status against this root
    memory: memoryStore,
    // H-family microagents — .pai/microagents/*.md frontmatter triggers
    // inject topic-scoped knowledge into the matching prompt, this turn only.
    // TRUST-GATED (Pi project-trust analogue): repo-planted auto-inject
    // content only activates on an operator-recorded trust grant —
    // cloned code must never write straight into the model's prompt.
    knowledge: {
      match: (text) => {
        if (!isTrusted(core.paths.root, workdir)) return null;
        const allow = readSkillAllow();
        const hits = matchMicroagents(loadMicroagents(workdir), text)
          .filter((a) => !allow || allow.has(a.name));
        for (const h of hits) skillHitCounts.set(h.name, (skillHitCounts.get(h.name) ?? 0) + 1);
        return hits.length ? { text: renderKnowledge(hits), agents: hits.map((h) => h.name) } : null;
      },
      // Skill-doctor analogue (CC /skill-doctor): which skills exist, what
      // they cost when injected, and how often they actually fired this run.
      stats: () => {
        const allow = readSkillAllow();
        return loadMicroagents(workdir).map((a) => ({
          name: a.name,
          triggers: a.triggers,
          bytes: Buffer.byteLength(a.body, 'utf-8'),
          hits: skillHitCounts.get(a.name) ?? 0,
          allowed: !allow || allow.has(a.name),
        }));
      },
      allowGet: () => { const a = readSkillAllow(); return a ? [...a] : null; },
      allowSet: (names) => {
        if (names === null) {
          try { unlinkSync(skillAllowPath); } catch {}
          return { allow: null };
        }
        if (!Array.isArray(names) || names.some((n) => typeof n !== 'string' || !n)) {
          return { error: 'names must be an array of skill names, or null to clear' };
        }
        writeFileSync(skillAllowPath, JSON.stringify({ allow: names }, null, 2) + '\n');
        return { allow: names };
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
    // project trust — operator grant gates .pai/microagents auto-injection
    projectTrust: {
      status: () => ({ trusted: isTrusted(core.paths.root, workdir), hasInjectableContent: hasInjectableContent(workdir) }),
      set: (v) => {
        const r = setTrust(core.paths.root, workdir, v === true);
        core.audit.write({ kind: 'PROJECT_TRUST', data: { trusted: r.trusted } });
        return r;
      },
    },
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
        const r = await runShell(command, workdir, { detachedDir: join(core.paths.root, 'jobs') });
        emit({ type: 'tool_execution_end', toolCallId: callId, toolName: 'bash', result: r.output.slice(0, 8000), isError: r.code !== 0 });
        core.audit.write({ kind: 'OPERATOR_BASH', data: { command: command.slice(0, 200), code: r.code } });
        if (r.detached) {
          core.audit.write({ kind: 'SHELL_DETACHED', data: { command: command.slice(0, 200), pid: r.detached.pid, log: r.detached.log } });
        }
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
      setMode: applyMode,
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
    monitors.dispose();
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
