/**
 * M1 end-to-end: startHost wires host core + pi body for real.
 * No model contact — stub model satisfies construction; the guard chain and
 * host artifacts are what matter here.
 */
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHost, restartSpecToJobSpawnArgs, btwReadonlyDecide } from '../src/bootstrap/host.js';

const stubModel = {
  id: 'stub', name: 'stub', api: 'openai-completions', provider: 'openai',
  baseUrl: 'http://127.0.0.1:9', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000, maxTokens: 4096,
};

test('startHost assembles a governed pi body end-to-end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-boot-'));
  // M2: canonical policy is a fail-closed requirement — provision the fixture
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: { destructive: 'deny', privilege: 'deny' },
  }));
  const host = await startHost({
    instanceRoot: dir,
    workdir: dir,
    sessionOptions: { model: stubModel },
  });

  // guard sealed on the REAL session
  assert.ok(host.guard.sealed());

  // body facts registered — facts, not status (frozen schema fields)
  const body = host.registry.get('pi');
  assert.equal(body.verified_capabilities.final_post_extension_guard, 'supported');
  assert.equal(body.verified_capabilities.mcp_native, 'unsupported');
  assert.equal(body.verified_capabilities.durable_jobs, 'supported');
  assert.equal(body.governance_coverage.tool_decide, 'supported');
  assert.equal(body.handoff_capabilities.resume, 'supported');

  // runtime identity on disk with both lockfile hashes
  const identity = JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf-8'));
  assert.equal(identity.adapter_id, 'pi');
  assert.ok(identity.lockfile_sha256.pi);
  assert.ok(identity.lockfile_sha256.host);

  // audit: HOST_STARTED recorded, run id present; BODY_SELECTED proves the
  // default body is a selector output, not a declaration
  const auditLines = readFileSync(
    join(dir, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf-8')
    .trim().split('\n').map(JSON.parse);
  assert.ok(auditLines.some((e) => e.kind === 'HOST_STARTED'));
  const sel = auditLines.find((e) => e.kind === 'BODY_SELECTED');
  assert.equal(sel?.data?.selected, 'pi');
  assert.ok(sel.data.results.pi.eligible);

  // envelopes built as two distinct channels
  assert.equal(host.instructionEnvelope.kind, 'InstructionEnvelope');
  assert.equal(host.contextEnvelope.kind, 'ContextEnvelope');

  // lease store live: claim a domain through the real store
  const claim = host.leases.claim({ scope: 'domain', name: 'smoke', owner: 'pi:test', ttlSeconds: 60 });
  assert.ok(claim.ok);
  host.dispose();
});

// BCC-1 wiring: the world-model adapter must actually reach the live session —
// an extension that never attaches, or a tool that never registers, is the same
// as no adapter at all (which is exactly how this loop stayed dark before).
test('BCC-1: the world-model adapter is wired into the live session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-boot-wm-'));
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  const host = await startHost({
    instanceRoot: dir,
    workdir: dir,
    sessionOptions: { model: stubModel },
  });
  try {
    const ids = (host.extensionsResult?.extensions ?? []).map((e) => e?.path ?? '');
    assert.ok(ids.some((id) => id.includes('pai-world-model')),
      `world-model extension must attach; loaded: ${JSON.stringify(ids)}`);
    const names = (host.session?.getAllTools?.() ?? []).map((t) => t?.name ?? t);
    assert.ok(names.includes('world_model'),
      `world_model tool must be registered; tools: ${JSON.stringify(names.slice(0, 40))}`);
    // the adapter writes its state under the instance root
    assert.ok(existsSync(join(dir, 'world-model')),
      'world-model state dir must exist under the instance root');
  } finally {
    host.dispose();
  }
});

// The guard is the whole point of the adapter: without it the world model is a
// passive log. This drives it through the shim (the same path the decide chain
// uses) so a wiring mistake in either file fails here.
test('BCC-1: the world-model guard denies an unbound consequential mutation', async () => {
  const { createWorldModelShim } = await import('../src/adapter/world-model-shim.js');
  const dir = mkdtempSync(join(tmpdir(), 'pai-wm-guard-'));
  const mk = (mode) => createWorldModelShim({
    stateDir: join(dir, 'state'), canonicalDir: join(dir, 'canonical'),
    mode, bodyId: 'test', getSessionId: () => 's1',
  });

  // core mode: an unbound consequential mutation is refused
  const denial = mk('core').guard({ name: 'exec', arguments: { command: 'ls' } });
  assert.equal(typeof denial, 'string');
  assert.match(denial, /BLOCKED/);

  // off mode: the same call is admitted (world model present, gate not armed)
  assert.equal(mk('off').guard({ name: 'exec', arguments: { command: 'ls' } }), undefined);

  // a read tool is never gated, even in core
  assert.equal(mk('core').guard({ name: 'read', arguments: { path: 'x' } }), undefined);

  // an unnamed tool call fails closed
  assert.match(String(mk('core').guard({ name: '', arguments: {} })), /fail closed/);
});

// The contract's tool interface and pi's are NOT the same, and only a real
// provider run surfaced it: a contract-shaped tool (no `parameters`, execute
// taking the input first) makes the runtime fail with "Cannot read properties of
// undefined (reading 'properties')". The shim must translate both ways.
test('BCC-1: the shim exposes the tool in PI\'s shape, not the contract\'s', async () => {
  const { createWorldModelShim } = await import('../src/adapter/world-model-shim.js');
  const dir = mkdtempSync(join(tmpdir(), 'pai-wm-shape-'));
  const shim = createWorldModelShim({
    stateDir: join(dir, 'state'), canonicalDir: join(dir, 'canonical'),
    mode: 'core', bodyId: 'test', getSessionId: () => 's1',
  });
  const tool = shim.tool;
  assert.ok(tool, 'shim must expose a tool');
  // pi reads .parameters.properties to describe the tool to the model
  assert.equal(tool.parameters?.type, 'object');
  assert.ok(tool.parameters.properties.op, 'op must be declared');
  assert.deepEqual(tool.parameters.required, ['op']);
  // pi calls execute(toolCallId, params) and expects {content:[...]}
  const out = await tool.execute('call-1', { op: 'status' });
  assert.ok(Array.isArray(out.content), 'result must be a content block array');
  assert.equal(out.content[0].type, 'text');
  const parsed = JSON.parse(out.content[0].text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.bcc, 'BCC-1');
  // an unknown op is reported as an error result, not a throw
  const bad = await tool.execute('call-2', { op: 'nope' });
  assert.equal(bad.isError, true);
});

// The depth is a RATCHET, not a switch: the session may maintain or raise it,
// never lower it. Otherwise the agent could disarm the very gate it is subject
// to — activate({mode:'off'}) would end the mechanism. `off` is env/config only.
test('BCC-1: a session cannot lower its own formalization depth', async () => {
  const { createWorldModelShim } = await import('../src/adapter/world-model-shim.js');
  const dir = mkdtempSync(join(tmpdir(), 'pai-wm-ratchet-'));
  const shim = createWorldModelShim({
    stateDir: join(dir, 'state'), canonicalDir: join(dir, 'canonical'),
    mode: 'core', bodyId: 'test', getSessionId: () => 's1',
  });
  const call = async (input) => JSON.parse((await shim.tool.execute('c', input)).content[0].text);

  // asking for off is refused and reported
  const lowered = await call({ op: 'activate', mode: 'off' });
  assert.equal(lowered.mode, 'core', 'mode must not drop to off');
  assert.equal(lowered.refused_lower, 'off');
  // and the gate is still armed after the attempt
  assert.match(String(shim.guard({ name: 'exec', arguments: { command: 'ls' } })), /BLOCKED/);

  // raising is allowed
  assert.equal((await call({ op: 'activate', mode: 'full' })).mode, 'full');
  // but then it cannot be lowered back
  assert.equal((await call({ op: 'activate', mode: 'core' })).mode, 'full');
});

// Regression: the loop-governance extension bundles four jobs, and only two of
// them (continuation, fallbacks) have a precondition. It must be installed even
// when BOTH are absent — otherwise the canonical observation feed (one row per
// tool result per turn) is silently disabled, which is exactly what happened
// while the whole extension was gated on
// `(taskRequirements.length || fallbackCfg.chain.length)`: the production entry
// point passes no taskRequirements, so the stream stayed permanently empty.
test('loop governance is installed without taskRequirements or a fallback chain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-boot-lg-'));
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  // NOTE: no taskRequirements, no model-fallbacks.json — the production shape.
  const host = await startHost({
    instanceRoot: dir,
    workdir: dir,
    sessionOptions: { model: stubModel },
  });

  // Inline factories register with a synthetic `<inline:NAME>` path; file-backed
  // extensions carry a real path. Either way the NAME is what we assert on.
  const ids = (host.extensionsResult?.extensions ?? [])
    .map((e) => (typeof e === 'string' ? e : e?.path ?? e?.name ?? e?.id ?? ''))
    .filter(Boolean);
  assert.ok(
    ids.some((id) => id.includes('pai-loop-governance')),
    `loop-governance extension must load unconditionally; loaded: ${JSON.stringify(ids)}`,
  );
  host.dispose(); // full teardown — dispose() already closes leases; calling both double-closes
});

test('M8-B4: canonical observations flow into the live context provider', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-boot-obs-'));
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  const host = await startHost({
    instanceRoot: dir,
    workdir: dir,
    sessionOptions: { model: stubModel },
  });

  // real canonical source — record an observation, the provider re-reads it
  host.observations.record({ kind: 'tool_result', subject: 'bash', detail: { isError: false }, actor: 'pi' });
  const env = host.contextProvider();
  assert.ok(env.observations.some((o) => o.subject === 'bash'));

  // rendered into the context channel text (what the model actually sees)
  const { renderContext } = await import('../../host/src/core/envelopes.js');
  const rendered = renderContext(env);
  assert.ok(rendered.includes('<observations>'));
  assert.ok(rendered.includes('[tool_result] bash'));

  // canonical durability: a fresh store over the same dir sees it — the
  // projection survives process restarts, so post-compaction turns re-read it
  const { ObservationStore } = await import('../../host/src/core/observation.js');
  const reopened = new ObservationStore(join(dir, 'canonical'));
  assert.ok(reopened.recent(20).some((o) => o.subject === 'bash'));

  host.dispose();
});

test('M8: ToolSurface + FileOpsGuard are wired into the real session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-boot-m8-'));
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], riskActions: {},
    tools: { powershell: { action: 'deny' } }, // policy-denied from turn zero
  }));
  const host = await startHost({
    instanceRoot: dir,
    workdir: dir,
    sessionOptions: { model: stubModel },
  });

  // production instances exist — not just modules
  assert.ok(host.toolSurface);
  assert.ok(host.fileOps);

  // initial suppression: denied tool is off the REAL session's visible surface
  const active = host.session.getActiveToolNames();
  assert.ok(!active.includes('powershell'));
  assert.ok(host.toolSurface.isDenied('powershell'));

  // deny-memory persisted under the instance root
  assert.ok(existsSync(join(dir, 'deny-memory.json')));

  host.dispose();
});

test('M89: session_import never mutates the source file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-import-'));
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  const host = await startHost({
    instanceRoot: dir,
    workdir: dir,
    sessionOptions: { model: stubModel },
  });
  // a foreign pi session file WITHOUT a trailing newline — upstream
  // loadEntriesFromFile() appends '\n' to repair that; importing must not
  // let that write reach the source (it is someone else's file)
  const src = join(dir, 'foreign.jsonl');
  const srcContent =
    JSON.stringify({ type: 'session', version: 3, id: 'src-1', timestamp: new Date().toISOString(), cwd: dir }) + '\n' +
    JSON.stringify({ type: 'message', id: 'm1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } });
  writeFileSync(src, srcContent); // deliberately no trailing newline
  const before = readFileSync(src);
  const r = await host.channel.handle({ type: 'session_import', path: src });
  assert.equal(r.success, true, `import failed: ${JSON.stringify(r)}`);
  assert.deepEqual(readFileSync(src), before, 'source bytes must be identical after import');
  // M89-R2: the fork stamps parentSession=<scratch>; the import must rewrite
  // the destination header to name the ORIGINAL source — provenance must not
  // dangle on a deleted temp file.
  const destFile = r.data?.file ?? r.file;
  assert.ok(destFile && existsSync(destFile), `imported session file missing: ${JSON.stringify(r)}`);
  const header = JSON.parse(readFileSync(destFile, 'utf-8').split('\n')[0]);
  assert.equal(header.parentSession, resolve(src), 'imported header must name the original source, not the deleted scratch');
  const stageRoot = join(dir, 'sessions', '.import-stage');
  assert.ok(
    !existsSync(stageRoot) || readdirSync(stageRoot).length === 0,
    'staging dir must be gone after import');
  host.dispose();
});

test('M89-R3: a post-fork failure also removes the half-imported session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-import-postfork-'));
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  const host = await startHost({
    instanceRoot: dir,
    workdir: dir,
    sessionOptions: { model: stubModel },
  });
  const src = join(dir, 'foreign3.jsonl');
  const srcContent =
    JSON.stringify({ type: 'session', version: 3, id: 'src-3', timestamp: new Date().toISOString(), cwd: dir }) + '\n' +
    JSON.stringify({ type: 'message', id: 'm1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } }) + '\n';
  writeFileSync(src, srcContent);
  const before = readFileSync(src);
  const sessionsDir = join(dir, 'sessions');
  const preImport = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'));
  // the destination exists the moment forkFrom returns — a failure in ANY
  // later step (here: post-fork, standing in for appendSessionInfo etc.)
  // must still clean it up
  await assert.rejects(
    host.channel.sessions.importSession(src, {
      afterFork: (mgr, destFile) => {
        assert.ok(existsSync(destFile), 'destination already exists right after fork');
        throw new Error('forced post-fork failure');
      },
    }),
    /forced post-fork failure/,
  );
  const postImport = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'));
  assert.deepEqual(postImport.sort(), preImport.sort(), 'failed import must not leave a session file behind');
  assert.deepEqual(readFileSync(src), before);
  const stageRoot = join(sessionsDir, '.import-stage');
  assert.ok(!existsSync(stageRoot) || readdirSync(stageRoot).length === 0);
  host.dispose();
});

test('M89-R3: a mid-fork throw leaves no orphan — staging sweep + atomic publish', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-import-orphan-'));
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  const host = await startHost({
    instanceRoot: dir,
    workdir: dir,
    sessionOptions: { model: stubModel },
  });
  const src = join(dir, 'foreign4.jsonl');
  const srcContent =
    JSON.stringify({ type: 'session', version: 3, id: 'src-4', timestamp: new Date().toISOString(), cwd: dir }) + '\n' +
    JSON.stringify({ type: 'message', id: 'm1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } }) + '\n';
  writeFileSync(src, srcContent);
  const before = readFileSync(src);
  const sessionsDir = join(dir, 'sessions');
  const preImport = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'));
  // upstream forkFrom() creates the destination BEFORE it can return the
  // manager — simulate a mid-write throw leaving a PARTIAL HEADER orphan
  // (unparseable, no newline): a provenance scan could never identify it,
  // staging containment must sweep it regardless
  let orphanPath = null;
  let stageUsed = null;
  await assert.rejects(
    host.channel.sessions.importSession(src, {
      fork: (scratch, _workdir, dir) => {
        stageUsed = dir;
        orphanPath = join(dir, `2099-01-01T00-00-00-000_orphanid.jsonl`);
        writeFileSync(orphanPath, '{"type":"session","version":3,"id":"orph'); // truncated mid-header
        throw new Error('simulated mid-copy I/O failure');
      },
    }),
    /simulated mid-copy I\/O failure/,
  );
  const postImport = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'));
  assert.deepEqual(postImport.sort(), preImport.sort(), 'nothing reaches the real sessions root until atomic publish');
  assert.ok(!existsSync(orphanPath), 'partial-header orphan swept with the staging dir');
  assert.ok(stageUsed && stageUsed.includes('.import-stage'), 'fork ran inside a staging dir');
  assert.ok(!existsSync(stageUsed), 'staging dir removed after failure');
  assert.deepEqual(readFileSync(src), before);
  const stageRoot = join(sessionsDir, '.import-stage');
  assert.ok(!existsSync(stageRoot) || readdirSync(stageRoot).length === 0);
  host.dispose();
});

test('M90-R3: restart gate args use the canonical job_spawn schema', () => {
  const args = restartSpecToJobSpawnArgs({
    command: 'npm test',
    workdir: '/repo',
    authorized_root: '/repo',
    job_type: 'shell_command',
    timeout_ms: 1_800_000,
    worktree: true,
    sandbox: { kind: 'ssh', target: 'me@box:22', dir: '/work', key: '/k' },
    budget_scope: 'sess-1',
    budget_committed: false,
  });
  assert.equal(args.command, 'npm test');
  assert.equal(args.timeout_minutes, 30);                 // ms → canonical minutes
  assert.equal(args.worktree, true);
  assert.equal(args.sandbox, 'ssh');                      // kind string, not object
  assert.equal(args.sandbox_target, 'me@box:22');
  assert.equal(args.remote_dir, '/work');
  assert.equal(args.sandbox_key, '/k');
  // internal-only fields must NOT leak into the audit surface — a first
  // job_spawn never presents them
  assert.equal('workdir' in args, false);
  assert.equal('authorized_root' in args, false);
  assert.equal('job_type' in args, false);
  assert.equal('budget_committed' in args, false);
  assert.equal('budget_scope' in args, false);
  assert.equal('timeout_ms' in args, false);
  // unsandboxed replay → sandbox omitted entirely (first spawn parity)
  const none = restartSpecToJobSpawnArgs({ command: 'x', sandbox: { kind: 'none' }, timeout_ms: null, worktree: false });
  assert.equal(none.sandbox, undefined);
  assert.equal(none.timeout_minutes, undefined);
  assert.equal(none.worktree, false);
});

test('M89-R2: provenance rewrite failure fails the whole import — no dangling session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-import-fail-'));
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  const host = await startHost({
    instanceRoot: dir,
    workdir: dir,
    sessionOptions: { model: stubModel },
  });
  const src = join(dir, 'foreign2.jsonl');
  const srcContent =
    JSON.stringify({ type: 'session', version: 3, id: 'src-2', timestamp: new Date().toISOString(), cwd: dir }) + '\n' +
    JSON.stringify({ type: 'message', id: 'm1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } }) + '\n';
  writeFileSync(src, srcContent);
  const before = readFileSync(src);
  const sessionsDir = join(dir, 'sessions');
  const preImport = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'));
  // force the provenance rewrite to fail — the import must NOT land a
  // session whose parentSession dangles on the deleted scratch
  await assert.rejects(
    host.channel.sessions.importSession(src, {
      rewriteParent: () => { throw new Error('forced rewrite failure'); },
    }),
    /forced rewrite failure/,
  );
  const postImport = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'));
  assert.deepEqual(postImport.sort(), preImport.sort(), 'failed import must not leave a session file behind');
  assert.deepEqual(readFileSync(src), before, 'source bytes must be identical after failed import');
  const stageRoot = join(sessionsDir, '.import-stage');
  assert.ok(
    !existsSync(stageRoot) || readdirSync(stageRoot).length === 0,
    'staging must be cleaned even on failure');
  host.dispose();
});

test('M107: btw readonly posture — effectful tools denied at decide, reads pass through', async () => {
  const calls = [];
  const inner = async (ctx) => { calls.push(ctx.toolCall?.name ?? ctx.toolName); return undefined; };
  inner.resetTurn = () => calls.push('reset');
  const decide = btwReadonlyDecide(inner, 'btw-readonly');
  for (const t of ['write', 'edit', 'delete', 'apply_patch', 'bash', 'shell', 'powershell',
    'job_spawn', 'delegate_task', 'request_permission', 'tool_activate',
    'mcp__filesystem_write', 'browser_click', 'memory_save', 'schedule_task',
    'mode_request', 'ask_user', 'notify_user', 'update_todos', 'task_send']) {
    const d = await decide({ toolCall: { name: t, id: 'x' }, args: {} });
    assert.equal(d?.block, true, `${t} must be denied on a btw fork`);
    assert.equal(d.rule, 'btw_readonly');
  }
  for (const t of ['read', 'grep', 'repo_map', 'session_search', 'web_fetch', 'tool_search']) {
    const d = await decide({ toolCall: { name: t, id: 'x' }, args: {} });
    assert.equal(d, undefined, `${t} should pass through to inner decide`);
  }
  // ctx.toolName fallback shape also covered
  assert.equal((await decide({ toolName: 'bash', args: {} }))?.block, true);
  // no posture → wrapper is a pass-through (normal sessions unaffected)
  assert.equal(btwReadonlyDecide(inner, undefined), inner);
  decide.resetTurn();
  assert.ok(calls.includes('reset'));
});

test('M123: operator bash_run fires observational tool_start/tool_end hooks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-boot-bashhook-'));
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: { bash: { action: 'allow' } }, riskActions: {},
  }));
  const marker = join(dir, 'hook-fires.jsonl');
  mkdirSync(join(dir, '.pai'), { recursive: true });
  const hookScript = join(dir, 'hook.js');
  writeFileSync(hookScript, `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{require('fs').appendFileSync(${JSON.stringify(marker)},JSON.stringify({ev:process.env.PAI_HOOK_EVENT,tool:JSON.parse(d).toolName})+String.fromCharCode(10));});`);
  const hookCmd = `"${process.execPath}" ${JSON.stringify(hookScript)}`;
  writeFileSync(join(dir, '.pai', 'hooks.json'), JSON.stringify({
    hooks: { tool_start: [{ command: hookCmd }], tool_end: [{ command: hookCmd }] },
  }));
  const host = await startHost({
    instanceRoot: dir,
    workdir: dir,
    sessionOptions: { model: stubModel },
  });
  const r = await host.channel.handle({ type: 'bash_run', command: 'echo m123-ok' });
  assert.equal(r.success, true, JSON.stringify(r));
  // hooks are fired detached — give the child processes a moment to write
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (existsSync(marker) && readFileSync(marker, 'utf-8').trim().split('\n').length >= 2) break;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  assert.ok(existsSync(marker), 'hook marker file written');
  const fired = readFileSync(marker, 'utf-8').trim().split('\n').map((l) => JSON.parse(l).ev);
  assert.ok(fired.includes('tool_start'), `tool_start fired (got ${fired})`);
  assert.ok(fired.includes('tool_end'), `tool_end fired (got ${fired})`);
  host.dispose();
});

test('B1 scan_run: artifact stub + governed prompt fire (or honest refusal)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-boot-scan-'));
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  const host = await startHost({
    instanceRoot: dir,
    workdir: dir,
    sessionOptions: { model: stubModel },
  });
  try {
    // validation: empty goal + subdir escape refuse before any prompt
    assert.equal((await host.channel.handle({ type: 'scan_run', goal: '  ' })).success, false);
    assert.equal((await host.channel.handle({ type: 'scan_run', goal: 'x', subdir: '../outside' })).success, false);

    const r = await host.channel.handle({ type: 'scan_run', goal: 'find all TODO markers' });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.match(r.data.id, /^scan-/);
    // the findings artifact is pre-created for the model to fill
    const artifact = readFileSync(join(dir, r.data.artifact), 'utf-8');
    assert.match(artifact, /status: RUNNING/);
    assert.match(artifact, /find all TODO markers/);
    // stub model is dead — either the prompt fired (turn attempted) or it
    // refused honestly; never a silent fake success
    if (!r.data.fired) assert.ok(r.data.refused);
    // scan_list surfaces the artifact
    const listed = await host.channel.handle({ type: 'scan_list' });
    assert.ok(listed.data.some((f) => f === `${r.data.id}.md`));
  } finally { host.dispose(); }
});

test('M112 webhook_status facade: no config → not listening, zero endpoints', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-boot-wh-'));
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  const host = await startHost({
    instanceRoot: dir,
    workdir: dir,
    sessionOptions: { model: stubModel },
  });
  try {
    const r = await host.channel.handle({ type: 'webhook_status' });
    assert.equal(r.success, true);
    assert.equal(r.data.listening, false);
    assert.equal(r.data.endpoints.length, 0);
  } finally { host.dispose(); }
});

test('#1284: session_fork refuses an oversized source transcript', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-forkcap-'));
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  const host = await startHost({
    instanceRoot: dir,
    workdir: dir,
    sessionOptions: { model: stubModel },
  });
  try {
    const big = join(dir, 'huge.jsonl');
    writeFileSync(big, Buffer.alloc(64 * 1024 * 1024 + 1, 'x')); // 1 byte over cap
    const r = await host.channel.handle({ type: 'session_fork', path: big });
    assert.equal(r.success, false, 'oversized source must be refused');
    assert.match(String(r.error ?? r), /too large to fork/);
    // the refusal happens before any destination file exists
    const sessionsDir = join(dir, 'sessions');
    const spawned = existsSync(sessionsDir)
      ? readdirSync(sessionsDir, { recursive: true }).filter((f) => String(f).endsWith('.jsonl')).length
      : 0;
    assert.ok(spawned <= 1, 'no fork destination left behind');
  } finally { host.dispose(); }
});

// candidates-open #2: operator worktree spawn — the sidebar worktree-creation
// analogue rides the channel job_spawn command through the SAME decide chain
// and lands a durable job inside a detached git worktree.
test('operator job_spawn: worktree flag reaches a real detached-checkout job', { timeout: 40_000 }, async () => {
  const { spawnSync } = await import('node:child_process');
  // instanceRoot must NOT sit inside a git worktree (doctor refuses) — keep
  // runtime state separate from the repo the job runs against.
  const inst = mkdtempSync(join(tmpdir(), 'pai-opwt-inst-'));
  const dir = mkdtempSync(join(tmpdir(), 'pai-opwt-repo-'));
  mkdirSync(join(inst, 'canonical'), { recursive: true });
  writeFileSync(join(inst, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  for (const args of [
    ['init', '-q'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't'],
  ]) spawnSync('git', args, { cwd: dir });
  writeFileSync(join(dir, 'base.txt'), 'base');
  spawnSync('git', ['add', 'base.txt'], { cwd: dir });
  spawnSync('git', ['commit', '-qm', 'init'], { cwd: dir });

  const host = await startHost({
    instanceRoot: inst, workdir: dir, sessionOptions: { model: stubModel },
  });
  try {
    const writeCmd = process.platform === 'win32' ? 'echo wt>wt-marker.txt' : 'echo wt > wt-marker.txt';
    const r = await host.channel.handle({ type: 'job_spawn', command: writeCmd, worktree: true });
    assert.equal(r.success, true, `operator spawn refused: ${r.error ?? JSON.stringify(r)}`);
    const jobId = r.data?.jobId ?? r.data?.job_id;
    assert.ok(jobId, 'spawn returns a job id');

    let job = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      const st = await host.channel.handle({ type: 'job_status', job_id: jobId });
      job = st.data?.job;
      const state = String(job?.job_state ?? job?.state ?? '');
      if (/COMPLETED|FAILED|CANCELLED/.test(state)) break;
    }
    assert.equal(String(job?.job_state ?? job?.state), 'COMPLETED', `job did not complete: ${JSON.stringify(job)}`);

    const audits = readdirSync(join(inst, 'audit')).map((f) => join(inst, 'audit', f));
    const lines = audits.flatMap((f) => readFileSync(f, 'utf-8').trim().split('\n').map(JSON.parse));
    assert.ok(lines.some((e) => e.kind === 'OPERATOR_JOB_SPAWN' && e.data?.worktree === true), 'OPERATOR_JOB_SPAWN audited');
    const kept = lines.find((e) => e.kind === 'JOB_WORKTREE_KEPT');
    assert.ok(kept, 'worktree kept (dirty write)');
    assert.ok(existsSync(join(kept.data.path ?? kept.data.worktree ?? '', 'wt-marker.txt')), 'marker lives in the worktree');
    assert.ok(!existsSync(join(dir, 'wt-marker.txt')), 'real checkout untouched');

    // policy denial stops the worktree job before any side effect — the
    // project deny list is the same chain a model job_spawn faces.
    mkdirSync(join(dir, '.pai'), { recursive: true });
    writeFileSync(join(dir, '.pai', 'commands.json'), JSON.stringify({ denyPrefixes: ['blocked-cmd'] }));
    const denied = await host.channel.handle({ type: 'job_spawn', command: 'blocked-cmd --now', worktree: true });
    assert.equal(denied.success, false, 'denied command must not spawn');
    const deniedLines = readdirSync(join(inst, 'audit'))
      .flatMap((f) => readFileSync(join(inst, 'audit', f), 'utf-8').trim().split('\n').map(JSON.parse));
    assert.ok(deniedLines.some((e) => e.kind === 'OPERATOR_JOB_BLOCK'), 'block audited');
    const deniedJobs = await host.channel.handle({ type: 'job_list' });
    assert.ok(!JSON.stringify(deniedJobs).includes('blocked-cmd'), 'no denied job record');
  } finally { host.dispose(); }
});

// candidates-open dedup-h #7: session insights — per-session breakdown +
// deterministic tips from the transcript file itself (no model call).
test('session_insights: real breakdown + tips; confined to the session dir', async () => {
  const inst = mkdtempSync(join(tmpdir(), 'pai-ins-'));
  mkdirSync(join(inst, 'canonical'), { recursive: true });
  mkdirSync(join(inst, 'sessions'), { recursive: true });
  writeFileSync(join(inst, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  const sf = join(inst, 'sessions', 's1.jsonl');
  writeFileSync(sf, [
    JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-09-23T00:00:00Z', cwd: inst }),
    JSON.stringify({ type: 'message', message: { role: 'user', timestamp: '2026-09-23T00:00:01Z', content: [{ type: 'text', text: 'fix the bug' }] } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', timestamp: '2026-09-23T00:10:00Z', content: [
      { type: 'toolCall', name: 'bash', id: 't1' },
      { type: 'toolResult', name: 'bash', isError: true, content: 'denied' },
      { type: 'toolCall', name: 'write', id: 't2' },
    ], usage: { totalTokens: 4200, output: 800, cost: { total: 0.42 } } } }),
    'not-json-torn-tail',
  ].join('\n'));
  const host = await startHost({
    instanceRoot: inst, workdir: inst, sessionOptions: { model: stubModel },
  });
  try {
    const r = await host.channel.handle({ type: 'session_insights', path: sf });
    assert.equal(r.success, true, `insights refused: ${r.error}`);
    const d = r.data;
    assert.equal(d.messages, 2);
    assert.equal(d.roles.user, 1);
    assert.equal(d.tools.bash, 2, 'call+result counted under the tool name');
    assert.equal(d.toolErrors.bash, 1);
    assert.equal(d.tokens, 5000);
    assert.equal(d.cost, 0.42);
    assert.equal(d.durationMs, 600000, 'header ts → last message ts');
    assert.ok(d.tips.some((t) => t.includes('bash')), 'error tip names the failing tool');
    // outside the session dir → confined refusal, not a read
    const outside = join(inst, 'canonical', 'policy.json');
    const bad = await host.channel.handle({ type: 'session_insights', path: outside });
    assert.equal(bad.success, false);
    assert.match(String(bad.error), /outside session dir/);

    // dedup-h #390 — aggregate mode fans the same analysis over the dir
    writeFileSync(join(inst, 'sessions', 's2.jsonl'), [
      JSON.stringify({ type: 'session', id: 's2', timestamp: '2026-09-23T01:00:00Z', cwd: inst }),
      JSON.stringify({ type: 'message', message: { role: 'user', timestamp: '2026-09-23T01:00:01Z', content: [{ type: 'text', text: 'again' }] } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', timestamp: '2026-09-23T01:30:00Z', content: [
        { type: 'toolCall', name: 'bash', id: 't9' },
        { type: 'toolResult', name: 'read', isError: true, content: 'e' },
      ], usage: { totalTokens: 1000, output: 200, cost: { total: 0.08 } } } }),
    ].join('\n'));
    const all = await host.channel.handle({ type: 'session_insights', all: true });
    assert.equal(all.success, true, `aggregate refused: ${all.error}`);
    const a = all.data;
    assert.equal(a.sessions, 2);
    assert.equal(a.messages, 4, 'two sessions merged');
    assert.equal(a.tools.bash, 3, 'tool counts merged across sessions');
    assert.equal(a.toolErrors.bash, 1);
    assert.equal(a.toolErrors.read, 1);
    assert.equal(a.tokens, 6200);
    assert.ok(Math.abs(a.cost - 0.5) < 1e-9);
    assert.ok(a.longest?.file === 's2.jsonl' && a.longest.durationMs === 1800000);
    assert.equal(a.avgDurationMs, 1200000, '(600000+1800000)/2');
    assert.ok(a.tips.some((t) => t.includes('bash')), 'aggregate tip names the repeat offender');
  } finally { host.dispose(); }
});

// candidates-open dedup-h #12: operator-pinned session id — UUID validated
// before any file exists; collisions refused, not adopted.
test('session_new id: custom UUID lands in the filename; bad/colliding ids refuse', async () => {
  const inst = mkdtempSync(join(tmpdir(), 'pai-sid-'));
  mkdirSync(join(inst, 'canonical'), { recursive: true });
  writeFileSync(join(inst, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  const host = await startHost({
    instanceRoot: inst, workdir: inst, sessionOptions: { model: stubModel },
  });
  try {
    const uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const r = await host.channel.handle({ type: 'session_new', id: uuid });
    assert.equal(r.success, true, `pinned create refused: ${r.error}`);
    assert.equal(r.data.id, uuid);
    assert.ok(String(r.data.file).includes(uuid), 'filename carries the pinned id');
    // files are lazily written (first message) — the pinned-id set is the
    // collision fence before anything lands on disk
    // malformed → refused before any file
    const bad = await host.channel.handle({ type: 'session_new', id: 'not-a-uuid' });
    assert.equal(bad.success, false);
    assert.match(String(bad.error), /not a UUID/);
    // same id again → collision refused even though nothing is written yet
    const again = await host.channel.handle({ type: 'session_new', id: uuid });
    assert.equal(again.success, false);
    assert.match(String(again.error), /already exists/);
    // a persisted session header with the id also collides
    const sid2 = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    mkdirSync(join(inst, 'sessions'), { recursive: true });
    writeFileSync(join(inst, 'sessions', `2026-09-23T00-00-00-000Z_${sid2}.jsonl`),
      JSON.stringify({ type: 'session', version: 3, id: sid2, timestamp: '2026-09-23T00:00:00Z', cwd: inst }) + '\n');
    const dup = await host.channel.handle({ type: 'session_new', id: sid2 });
    assert.equal(dup.success, false);
    assert.match(String(dup.error), /already exists/);
    // no id → random path still works
    const rand = await host.channel.handle({ type: 'session_new' });
    assert.equal(rand.success, true);
    assert.ok(rand.data.id && rand.data.id !== uuid);
  } finally { host.dispose(); }
});

// candidates-open dedup-h #202: session_directory gate event — the
// operator-private hooks.json may relocate session persistence; a broken
// hook refuses startup rather than scattering sessions.
test('session_directory hook relocates sessionDir; broken hook refuses closed', async () => {
  const inst = mkdtempSync(join(tmpdir(), 'pai-sdir-'));
  const dir = mkdtempSync(join(tmpdir(), 'pai-sdir-wd-'));
  const custom = join(dir, 'custom-sessions');
  mkdirSync(join(inst, 'canonical'), { recursive: true });
  writeFileSync(join(inst, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  const hookScript = join(dir, 'sdir-hook.js');
  writeFileSync(hookScript, `console.log(${JSON.stringify(JSON.stringify({ directory: custom }))});\n`);
  writeFileSync(join(inst, 'hooks.json'), JSON.stringify({
    hooks: {
      session_directory: [{
        command: `"${process.execPath}" "${hookScript}"`,
      }],
    },
  }));
  const host = await startHost({
    instanceRoot: inst, workdir: dir, sessionOptions: { model: stubModel },
  });
  try {
    const r = await host.channel.handle({ type: 'session_new' });
    assert.equal(r.success, true, `new session refused: ${r.error}`);
    assert.ok(existsSync(custom), 'custom session dir created');
    assert.ok(String(r.data.file ?? '').startsWith(custom), `session file lands in custom dir: ${r.data.file}`);
    const audits = readdirSync(join(inst, 'audit')).flatMap((f) =>
      readFileSync(join(inst, 'audit', f), 'utf-8').trim().split('\n').map(JSON.parse));
    assert.ok(audits.some((e) => e.kind === 'SESSION_DIRECTORY' && e.data?.source === 'hook'),
      'relocated dir audited');
  } finally { host.dispose(); }

  // a configured-but-broken hook refuses startup — never silently defaults
  const inst2 = mkdtempSync(join(tmpdir(), 'pai-sdir2-'));
  mkdirSync(join(inst2, 'canonical'), { recursive: true });
  writeFileSync(join(inst2, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  writeFileSync(join(inst2, 'hooks.json'), JSON.stringify({
    hooks: { session_directory: [{ command: 'exit 3' }] },
  }));
  await assert.rejects(
    startHost({ instanceRoot: inst2, workdir: dir, sessionOptions: { model: stubModel } }),
    /session_directory|exited 3/i,
  );
});

// candidates-open dedup-h #233: proxy.mode outbound control —
// <instance>/proxy.json applies env-proxy at bootstrap; config_set writes
// the file and honestly reports appliesOnRestart.
test('proxy.json: env-proxy applied at bootstrap; config_set persists + reports restart', async () => {
  const inst = mkdtempSync(join(tmpdir(), 'pai-pxy-'));
  const dir = mkdtempSync(join(tmpdir(), 'pai-pxy-wd-'));
  mkdirSync(join(inst, 'canonical'), { recursive: true });
  writeFileSync(join(inst, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  writeFileSync(join(inst, 'proxy.json'), JSON.stringify({ mode: 'http://127.0.0.1:8080', noProxy: ['localhost'] }));
  const host = await startHost({
    instanceRoot: inst, workdir: dir, sessionOptions: { model: stubModel },
  });
  try {
    assert.equal(process.env.NODE_USE_ENV_PROXY, '1', 'env-proxy flag applied');
    assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:8080');
    assert.equal(process.env.NO_PROXY, 'localhost');
    const audits = readdirSync(join(inst, 'audit')).flatMap((f) =>
      readFileSync(join(inst, 'audit', f), 'utf-8').trim().split('\n').map(JSON.parse));
    assert.ok(audits.some((e) => e.kind === 'HOST_STARTED' && e.data?.proxy === 'http://127.0.0.1:8080'),
      'proxy posture audited at start');

    const st = await host.channel.handle({ type: 'get_state' });
    assert.equal(st.data.proxy?.active?.url, 'http://127.0.0.1:8080', 'status surfaces active proxy');

    // config_set persists + honestly says the dispatcher is already bound
    const r = await host.channel.handle({ type: 'config_set', key: 'proxy_mode', value: 'off' });
    assert.equal(r.success, true, `config_set refused: ${r.error}`);
    assert.equal(r.data.appliesOnRestart, true);
    assert.equal(JSON.parse(readFileSync(join(inst, 'proxy.json'), 'utf-8')).mode, 'off');

    const bad = await host.channel.handle({ type: 'config_set', key: 'proxy_mode', value: 'socks5://x' });
    assert.equal(bad.success, false, 'non-http scheme refused');
  } finally {
    delete process.env.NODE_USE_ENV_PROXY; delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY; delete process.env.NO_PROXY;
    host.dispose();
  }
});

// dedup-h #389 — PAI_PROXY_URL (OpenClaw OPENCLAW_PROXY_URL analogue):
// operator-named env var names the proxy outright; explicit proxy.json
// still wins; a malformed env URL fails loud, not silently off.
test('PAI_PROXY_URL: env-named proxy applies; proxy.json wins; bad URL loud', async () => {
  const inst = mkdtempSync(join(tmpdir(), 'pai-pxyenv-'));
  const dir = mkdtempSync(join(tmpdir(), 'pai-pxyenv-wd-'));
  mkdirSync(join(inst, 'canonical'), { recursive: true });
  writeFileSync(join(inst, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  process.env.PAI_PROXY_URL = 'http://127.0.0.1:9090';
  try {
    const host = await startHost({
      instanceRoot: inst, workdir: dir, sessionOptions: { model: stubModel },
    });
    try {
      assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:9090', 'env-named proxy applied');
      const st = await host.channel.handle({ type: 'get_state' });
      assert.equal(st.data.proxy?.active?.url, 'http://127.0.0.1:9090');
      assert.equal(st.data.proxy?.envSource, 'PAI_PROXY_URL', 'source honestly labeled');
    } finally {
      host.dispose();
    }
    // explicit proxy.json beats the env var
    writeFileSync(join(inst, 'proxy.json'), JSON.stringify({ mode: 'off' }));
    const host2 = await startHost({
      instanceRoot: inst, workdir: dir, sessionOptions: { model: stubModel },
    });
    try {
      const st = await host2.channel.handle({ type: 'get_state' });
      assert.equal(st.data.proxy?.active, null, 'explicit off wins over env var');
    } finally {
      host2.dispose();
    }
    // malformed env URL fails at bootstrap, not silently
    process.env.PAI_PROXY_URL = 'not-a-url';
    rmSync(join(inst, 'proxy.json'));
    await assert.rejects(
      () => startHost({ instanceRoot: inst, workdir: dir, sessionOptions: { model: stubModel } }),
      /PAI_PROXY_URL.*proxy URL/,
    );
  } finally {
    delete process.env.PAI_PROXY_URL;
    delete process.env.NODE_USE_ENV_PROXY; delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY; delete process.env.NO_PROXY;
  }
});

// dedup-h #391 — operator-side MCP OAuth surface: status rows, PKCE
// authorize URL, code exchange into the user-private token store.
// Tokens never surface — only authorization booleans.
test('mcp facade: status/auth/authDone — PKCE URL + stored token, never token bytes', async () => {
  const { createServer } = await import('node:http');
  const seen = { tokenBodies: [] };
  const tokSrv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.tokenBodies.push(Object.fromEntries(new URLSearchParams(body)));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ access_token: 'tok-xyz', token_type: 'bearer', expires_in: 3600, refresh_token: 'r1' }));
    });
  });
  await new Promise((r) => tokSrv.listen(0, '127.0.0.1', r));
  const inst = mkdtempSync(join(tmpdir(), 'pai-mcpf-'));
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcpf-wd-'));
  mkdirSync(join(inst, 'canonical'), { recursive: true });
  writeFileSync(join(inst, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  const cfgPath = join(inst, 'mcp.json');
  writeFileSync(cfgPath, JSON.stringify({
    mcpServers: {
      secured: {
        url: 'https://mcp.example.com/mcp',
        oauth: {
          clientId: 'cid-1',
          tokenUrl: `http://127.0.0.1:${tokSrv.address().port}/token`,
          authorizationUrl: 'https://auth.example.com/authorize',
          scope: 'mcp:read',
        },
      },
      plain: { url: 'https://plain.example.com/mcp' },
    },
  }));
  const prevCfg = process.env.PAI_MCP_CONFIG, prevStore = process.env.PAI_MCP_TOKEN_STORE;
  process.env.PAI_MCP_CONFIG = cfgPath;
  process.env.PAI_MCP_TOKEN_STORE = join(inst, 'mcp-oauth.json');
  try {
    const host = await startHost({
      instanceRoot: inst, workdir: dir, sessionOptions: { model: stubModel },
    });
    try {
      const st = await host.channel.handle({ type: 'mcp_status' });
      assert.equal(st.success, true, `status refused: ${st.error}`);
      const secured = st.data.servers.find((s) => s.name === 'secured');
      assert.equal(secured.oauth, 'authorization_code');
      assert.equal(secured.authorized, false, 'no token yet — honestly unauthorized');
      const plain = st.data.servers.find((s) => s.name === 'plain');
      assert.equal(plain.oauth, undefined);

      const auth = await host.channel.handle({ type: 'mcp_auth', server: 'secured' });
      assert.equal(auth.success, true, `auth refused: ${auth.error}`);
      const u = new URL(auth.data.url);
      assert.equal(u.origin + u.pathname, 'https://auth.example.com/authorize');
      assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
      assert.ok(u.searchParams.get('code_challenge'), 'PKCE challenge present');
      assert.equal(u.searchParams.get('client_id'), 'cid-1');
      assert.equal(u.searchParams.get('resource'), 'https://mcp.example.com/mcp', 'RFC8707 resource = server url');

      const done = await host.channel.handle({ type: 'mcp_auth_done', server: 'secured', code: 'authcode-1' });
      assert.equal(done.success, true, `auth_done refused: ${done.error}`);
      const req = seen.tokenBodies[0];
      assert.equal(req.grant_type, 'authorization_code');
      assert.equal(req.code, 'authcode-1');
      assert.ok(req.code_verifier, 'PKCE verifier sent');
      // token stored user-privately; status now reports authorized — and
      // the token bytes never appear in any facade payload
      const store = JSON.parse(readFileSync(join(inst, 'mcp-oauth.json'), 'utf-8'));
      assert.equal(store.secured.access_token, 'tok-xyz');
      const st2 = await host.channel.handle({ type: 'mcp_status' });
      assert.equal(st2.data.servers.find((s) => s.name === 'secured').authorized, true);
      assert.ok(!JSON.stringify(st2.data).includes('tok-xyz'), 'token bytes never surface');

      // expired/unknown pending → honest error, not a silent state
      const again = await host.channel.handle({ type: 'mcp_auth_done', server: 'secured', code: 'x' });
      assert.equal(again.success, false);
      assert.match(String(again.error), /no pending OAuth/);
      const unknown = await host.channel.handle({ type: 'mcp_auth', server: 'ghost' });
      assert.equal(unknown.success, false);
    } finally { host.dispose(); }
  } finally {
    tokSrv.close();
    if (prevCfg === undefined) delete process.env.PAI_MCP_CONFIG; else process.env.PAI_MCP_CONFIG = prevCfg;
    if (prevStore === undefined) delete process.env.PAI_MCP_TOKEN_STORE; else process.env.PAI_MCP_TOKEN_STORE = prevStore;
  }
});

test('dedup-h #459: auth-success notification hook fires on mcp_auth_done', async () => {
  const { createServer } = await import('node:http');
  // fake OAuth token endpoint — the exchange must succeed for the event
  const tokenSrv = createServer((_q, r) => {
    r.setHeader('content-type', 'application/json');
    r.end(JSON.stringify({ access_token: 'tok-x', token_type: 'bearer', expires_in: 3600 }));
  });
  await new Promise((res) => tokenSrv.listen(0, '127.0.0.1', res));
  const dir = mkdtempSync(join(tmpdir(), 'pai-boot-authhook-'));
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  // notification hook → marker file (records the full stdin payload)
  const marker = join(dir, 'hook-fires.jsonl');
  mkdirSync(join(dir, '.pai'), { recursive: true });
  const hookScript = join(dir, 'hook.js');
  writeFileSync(hookScript, `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{require('fs').appendFileSync(${JSON.stringify(marker)},JSON.stringify({ev:process.env.PAI_HOOK_EVENT,payload:JSON.parse(d)})+String.fromCharCode(10));});`);
  const hookCmd = `"${process.execPath}" ${JSON.stringify(hookScript)}`;
  writeFileSync(join(dir, '.pai', 'hooks.json'), JSON.stringify({
    hooks: { notification: [{ command: hookCmd }] },
  }));
  // MCP config: one oauth server pointing at the local token endpoint
  const mcpCfg = join(dir, 'mcp.json');
  writeFileSync(mcpCfg, JSON.stringify({ mcpServers: { authsrv: {
    url: 'https://mcp.example.com/mcp',
    oauth: { clientId: 'cid', tokenUrl: `http://127.0.0.1:${tokenSrv.address().port}/token`, authorizationUrl: 'https://auth.example.com/a' },
  } } }));
  const prevCfg = process.env.PAI_MCP_CONFIG, prevStore = process.env.PAI_MCP_TOKEN_STORE;
  process.env.PAI_MCP_CONFIG = mcpCfg;
  process.env.PAI_MCP_TOKEN_STORE = join(dir, 'mcp-oauth.json');
  const host = await startHost({ instanceRoot: dir, workdir: dir, sessionOptions: { model: stubModel } });
  try {
    const a = await host.channel.handle({ type: 'mcp_auth', server: 'authsrv' });
    assert.equal(a.success, true, JSON.stringify(a));
    assert.match(a.data.url, /^https:\/\/auth\.example\.com\/a\?/);
    const d = await host.channel.handle({ type: 'mcp_auth_done', server: 'authsrv', code: 'code-1' });
    assert.equal(d.success, true, JSON.stringify(d));
    assert.equal(d.data.server, 'authsrv');
    // hook fires detached — poll the marker
    const deadline = Date.now() + 8000;
    let rows = [];
    while (Date.now() < deadline) {
      if (existsSync(marker)) rows = readFileSync(marker, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      if (rows.some((r) => r.ev === 'notification' && r.payload?.kind === 'auth_success')) break;
      await new Promise((r2) => setTimeout(r2, 100));
    }
    const hit = rows.find((r) => r.ev === 'notification' && r.payload?.kind === 'auth_success');
    assert.ok(hit, `auth_success notification hook fired (got ${JSON.stringify(rows)})`);
    assert.equal(hit.payload.server, 'authsrv');
  } finally {
    host.dispose();
    tokenSrv.close();
    if (prevCfg === undefined) delete process.env.PAI_MCP_CONFIG; else process.env.PAI_MCP_CONFIG = prevCfg;
    if (prevStore === undefined) delete process.env.PAI_MCP_TOKEN_STORE; else process.env.PAI_MCP_TOKEN_STORE = prevStore;
  }
});

// dedup-h #509: git worktree management — worktree_list reports every linked
// checkout (managed flagged); job_spawn{in_worktree} opens an EXISTING
// worktree (fail closed on unknown names).
test('worktree_list + job_spawn in_worktree: open an existing linked checkout', { timeout: 40_000 }, async () => {
  const { spawnSync } = await import('node:child_process');
  const inst = mkdtempSync(join(tmpdir(), 'pai-wtm-inst-'));
  const dir = mkdtempSync(join(tmpdir(), 'pai-wtm-repo-'));
  mkdirSync(join(inst, 'canonical'), { recursive: true });
  writeFileSync(join(inst, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  for (const args of [
    ['init', '-q'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't'],
  ]) spawnSync('git', args, { cwd: dir });
  writeFileSync(join(dir, 'base.txt'), 'base');
  spawnSync('git', ['add', 'base.txt'], { cwd: dir });
  spawnSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  // a pre-existing linked worktree the operator created outside the product
  // (unique name — a fixed one collides with leftovers from crashed runs)
  const linked = join(dir, '..', `pai-wtm-linked-${process.pid}`);
  spawnSync('git', ['worktree', 'add', '--detach', linked, 'HEAD'], { cwd: dir });

  const host = await startHost({ instanceRoot: inst, workdir: dir, sessionOptions: { model: stubModel } });
  try {
    const wl = await host.channel.handle({ type: 'worktree_list' });
    assert.equal(wl.success, true, JSON.stringify(wl));
    const paths = wl.data.worktrees.map((w) => w.path);
    assert.ok(paths.some((p) => resolve(p) === resolve(dir)), 'main checkout listed');
    assert.ok(paths.some((p) => resolve(p) === resolve(linked)), 'linked worktree listed');
    assert.ok(wl.data.worktrees.every((w) => w.managed === false), 'no managed entries yet');

    // unknown name → fail closed, never an arbitrary directory
    const bad = await host.channel.handle({ type: 'job_spawn', command: 'echo x', in_worktree: '..\..\Windows' });
    assert.equal(bad.success, false, 'arbitrary dir must not be accepted as a worktree');

    // open the linked worktree by basename → job lands THERE, not the main checkout
    const writeCmd = process.platform === 'win32' ? 'echo wt>wt-open.txt' : 'echo wt > wt-open.txt';
    const r = await host.channel.handle({ type: 'job_spawn', command: writeCmd, in_worktree: `pai-wtm-linked-${process.pid}` });
    assert.equal(r.success, true, `in_worktree spawn refused: ${r.error ?? JSON.stringify(r)}`);
    const jobId = r.data?.jobId ?? r.data?.job_id;
    let job = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      const st = await host.channel.handle({ type: 'job_status', job_id: jobId });
      job = st.data?.job;
      if (/COMPLETED|FAILED|CANCELLED/.test(String(job?.job_state ?? ''))) break;
    }
    assert.equal(String(job?.job_state), 'COMPLETED', `job did not complete: ${JSON.stringify(job)}`);
    assert.ok(existsSync(join(linked, 'wt-open.txt')), 'marker landed in the opened worktree');
    assert.ok(!existsSync(join(dir, 'wt-open.txt')), 'main checkout untouched');
    // audit names the opened worktree
    const lines = readdirSync(join(inst, 'audit'))
      .flatMap((f) => readFileSync(join(inst, 'audit', f), 'utf-8').trim().split('\n').map(JSON.parse));
    assert.ok(lines.some((e) => e.kind === 'OPERATOR_JOB_SPAWN' && e.data?.in_worktree), 'in_worktree audited');
  } finally {
    host.dispose();
    spawnSync('git', ['worktree', 'remove', '--force', linked], { cwd: dir });
  }
});

// dedup-h #727 — proxy.json mode 'pac'/'wpad': a PAC script fetched at
// bootstrap decides per probe host; a unanimous PROXY verdict maps onto
// the env-proxy surface and DIRECT hosts join NO_PROXY. Failure posture
// surfaces in proxy.status, never silently.
test('proxy.json pac: FindProxyForURL verdict applies env-proxy; DIRECT hosts enter NO_PROXY', async () => {
  const inst = mkdtempSync(join(tmpdir(), 'pai-pac-'));
  const dir = mkdtempSync(join(tmpdir(), 'pai-pac-wd-'));
  mkdirSync(join(inst, 'canonical'), { recursive: true });
  writeFileSync(join(inst, 'canonical', 'policy.json'), JSON.stringify({ version: 1, deny: [], tools: {}, riskActions: {} }));
  const pacFile = join(inst, 'proxy.pac');
  writeFileSync(pacFile, `
function FindProxyForURL(url, host) {
  if (dnsDomainIs(host, ".internal")) return "DIRECT";
  return "PROXY 127.0.0.1:8318";
}`);
  writeFileSync(join(inst, 'proxy.json'), JSON.stringify({
    mode: 'pac', pacUrl: pacFile, hosts: ['api.anthropic.com', 'db.internal'],
  }));
  const host = await startHost({ instanceRoot: inst, workdir: dir, sessionOptions: { model: stubModel } });
  try {
    assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:8318', 'unanimous PROXY verdict applied');
    assert.equal(process.env.NO_PROXY, 'db.internal', 'DIRECT host joined NO_PROXY');
    const st = await host.channel.handle({ type: 'get_state' });
    assert.equal(st.data.proxy?.active?.mode, 'pac');
    assert.equal(st.data.proxy?.active?.url, 'http://127.0.0.1:8318');

    // config_set: pac requires pacUrl; wpad persists wpadUrl
    const noUrl = await host.channel.handle({ type: 'config_set', key: 'proxy_mode', value: 'pac' });
    assert.equal(noUrl.success, false, 'pac without pacUrl refused');
    const wpad = await host.channel.handle({
      type: 'config_set', key: 'proxy_mode',
      value: { mode: 'wpad', wpadUrl: pacFile, hosts: ['x.example'] },
    });
    assert.equal(wpad.success, true, `wpad persist refused: ${wpad.error}`);
    const doc = JSON.parse(readFileSync(join(inst, 'proxy.json'), 'utf-8'));
    assert.equal(doc.mode, 'wpad');
    assert.equal(doc.wpadUrl, pacFile);
  } finally {
    delete process.env.NODE_USE_ENV_PROXY; delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY; delete process.env.NO_PROXY;
    host.dispose();
  }
});

// dedup-h #740 — RFC 8628 device flow through the channel facade: mcp_auth
// returns the user-facing code; the host polls the token endpoint detached
// and stores the token on approval; auth_success notification fires.
test('mcp facade device flow: user code returned; detached poll stores token + fires notification', async () => {
  const { createServer } = await import('node:http');
  const calls = { device: 0, token: 0 };
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/device') {
        calls.device++;
        res.end(JSON.stringify({ device_code: 'dc-x', user_code: 'WXYZ-9876', verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 300 }));
      } else {
        calls.token++;
        if (calls.token < 2) res.end(JSON.stringify({ error: 'authorization_pending' }));
        else res.end(JSON.stringify({ access_token: 'tok-device', token_type: 'bearer', expires_in: 3600 }));
      }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'pai-boot-devflow-'));
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({ version: 1, deny: [], tools: {}, riskActions: {} }));
  const marker = join(dir, 'hook-fires.jsonl');
  mkdirSync(join(dir, '.pai'), { recursive: true });
  const hookScript = join(dir, 'hook.js');
  writeFileSync(hookScript, `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{require('fs').appendFileSync(${JSON.stringify(marker)},JSON.stringify({ev:process.env.PAI_HOOK_EVENT,payload:JSON.parse(d)})+String.fromCharCode(10));});`);
  writeFileSync(join(dir, '.pai', 'hooks.json'), JSON.stringify({ hooks: { notification: [{ command: `"${process.execPath}" ${JSON.stringify(hookScript)}` }] } }));
  const mcpCfg = join(dir, 'mcp.json');
  writeFileSync(mcpCfg, JSON.stringify({ mcpServers: { devsrv: {
    url: 'https://mcp.example.com/mcp',
    oauth: { clientId: 'cid', tokenUrl: `http://127.0.0.1:${srv.address().port}/token`, deviceAuthUrl: `http://127.0.0.1:${srv.address().port}/device` },
  } } }));
  const storePath = join(dir, 'mcp-oauth.json');
  const prevCfg = process.env.PAI_MCP_CONFIG, prevStore = process.env.PAI_MCP_TOKEN_STORE;
  process.env.PAI_MCP_CONFIG = mcpCfg;
  process.env.PAI_MCP_TOKEN_STORE = storePath;
  const host = await startHost({ instanceRoot: dir, workdir: dir, sessionOptions: { model: stubModel } });
  try {
    // status shows the device_code flow
    const st = await host.channel.handle({ type: 'mcp_status' });
    assert.equal(st.data.servers[0].oauth, 'device_code');

    const a = await host.channel.handle({ type: 'mcp_auth', server: 'devsrv' });
    assert.equal(a.success, true, JSON.stringify(a));
    assert.equal(a.data.device.userCode, 'WXYZ-9876');
    assert.equal(a.data.device.verificationUri, 'https://github.com/login/device');
    assert.equal(calls.device, 1);

    // detached poll: token lands in the store + auth_success hook fires
    const deadline = Date.now() + 10000;
    let stored = null, hooks = [];
    while (Date.now() < deadline) {
      if (existsSync(storePath)) { try { stored = JSON.parse(readFileSync(storePath, 'utf-8'))?.devsrv; } catch {} }
      if (existsSync(marker)) hooks = readFileSync(marker, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      if (stored?.access_token && hooks.some((r) => r.ev === 'notification' && r.payload?.kind === 'auth_success')) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(stored?.access_token, 'tok-device', 'polled token stored');
    assert.equal(stored?.flow, 'device_code');
    assert.ok(calls.token >= 2, `token endpoint polled (${calls.token})`);
    assert.ok(hooks.some((r) => r.payload?.flow === 'device_code'), 'auth_success carries device_code flow');
  } finally {
    host.dispose();
    srv.close();
    if (prevCfg === undefined) delete process.env.PAI_MCP_CONFIG; else process.env.PAI_MCP_CONFIG = prevCfg;
    if (prevStore === undefined) delete process.env.PAI_MCP_TOKEN_STORE; else process.env.PAI_MCP_TOKEN_STORE = prevStore;
  }
});

// dedup-h #1059 — mcp spec 'defer_loading:true': the server's tools register
// onto the LAZY surface (off the eager schema list), still discoverable via
// tool_search and claimable via tool_activate. Boot connect is async, so
// the defer must hold whether tools land before or after the surface exists.
test('mcp defer_loading: tools join lazy surface, tool_search finds, tool_activate claims', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-mcpdefer-'));
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  const serverPath = join(dir, 'fake-mcp.js');
  // NB: single-quoted lines keep \\n as an escape INSIDE the written file —
  // a template literal would render a real newline and break the child.
  writeFileSync(serverPath, [
    "let buf='';",
    "process.stdin.on('data',(c)=>{buf+=c;let nl;",
    "while((nl=buf.indexOf('\\n'))>=0){const line=buf.slice(0,nl).trim();buf=buf.slice(nl+1);if(!line)continue;",
    "const msg=JSON.parse(line);",
    "if(msg.method==='initialize'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{protocolVersion:'2025-06-18',serverInfo:{name:'fake',version:'0'},capabilities:{tools:{}}}})+'\\n');}",
    "else if(msg.method==='tools/list'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{tools:[{name:'echo',description:'echo back',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]}})+'\\n');}}});",
    "setInterval(()=>{},1000);",
  ].join('\n'));
  const mcpCfg = join(dir, 'mcp.json');
  writeFileSync(mcpCfg, JSON.stringify({ mcpServers: {
    lazysrv: { command: process.execPath, args: [serverPath], defer_loading: true },
  } }));
  const prevCfg = process.env.PAI_MCP_CONFIG;
  process.env.PAI_MCP_CONFIG = mcpCfg;
  const host = await startHost({ instanceRoot: dir, workdir: dir, sessionOptions: { model: stubModel } });
  try {
    // boot connect is async — poll for the tool to land (either registered
    // before the surface existed and deferred by the prefix pass, or late
    // and deferred through the onDeferTools hook)
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (host.toolSurface.isLazy('mcp__lazysrv__echo')) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(host.toolSurface.isLazy('mcp__lazysrv__echo'),
      'defer_loading tool must join the lazy surface');
    assert.ok(!host.session.getActiveToolNames().includes('mcp__lazysrv__echo'),
      'deferred tool is off the eager surface');

    // discoverable via tool_search; claimable via tool_activate
    const tools = host.session.getAllTools?.() ?? [];
    assert.ok(tools.some((t) => t.name === 'mcp__lazysrv__echo'), 'catalog still knows the tool');
    const activated = host.toolSurface.activate(['mcp__lazysrv__echo']);
    assert.deepEqual(activated, ['mcp__lazysrv__echo']);
    assert.ok(host.session.getActiveToolNames().includes('mcp__lazysrv__echo'),
      'activated tool returns to the visible surface');
  } finally {
    host.dispose();
    if (prevCfg === undefined) delete process.env.PAI_MCP_CONFIG; else process.env.PAI_MCP_CONFIG = prevCfg;
  }
});

// dedup-h #1065 — loopback OAuth redirect through the channel facade:
// mcp_auth returns the authorize URL AND opens a 127.0.0.1 receiver; a
// state-matching browser callback completes exchange+store without paste.
test('mcp facade loopback auth: callback captures code, token stored, auth_success fires', async () => {
  const { createServer } = await import('node:http');
  // free port for the loopback receiver (the provider redirects to a KNOWN
  // port, so the spec must declare one — grab a free one first)
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const cbPort = probe.address().port;
  probe.close();
  const tokenSrv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ access_token: 'tok-loopback', token_type: 'bearer', expires_in: 3600 }));
    });
  });
  await new Promise((r) => tokenSrv.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'pai-boot-loopback-'));
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({ version: 1, deny: [], tools: {}, riskActions: {} }));
  const marker = join(dir, 'hooks.jsonl');
  mkdirSync(join(dir, '.pai'), { recursive: true });
  const hookScript = join(dir, 'hook.js');
  writeFileSync(hookScript, `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{require('fs').appendFileSync(${JSON.stringify(marker)},JSON.stringify({ev:process.env.PAI_HOOK_EVENT,payload:JSON.parse(d)})+String.fromCharCode(10));});`);
  writeFileSync(join(dir, '.pai', 'hooks.json'), JSON.stringify({ hooks: { notification: [{ command: `"${process.execPath}" ${JSON.stringify(hookScript)}` }] } }));
  const mcpCfg = join(dir, 'mcp.json');
  writeFileSync(mcpCfg, JSON.stringify({ mcpServers: { loopsrv: {
    url: 'https://mcp.example.com/mcp',
    oauth: {
      clientId: 'cid', tokenUrl: `http://127.0.0.1:${tokenSrv.address().port}/token`,
      authorizationUrl: 'https://auth.example.com/authorize',
      redirectUri: `http://localhost:${cbPort}/callback`,
    },
  } } }));
  const storePath = join(dir, 'mcp-oauth.json');
  const prevCfg = process.env.PAI_MCP_CONFIG, prevStore = process.env.PAI_MCP_TOKEN_STORE;
  process.env.PAI_MCP_CONFIG = mcpCfg;
  process.env.PAI_MCP_TOKEN_STORE = storePath;
  const host = await startHost({ instanceRoot: dir, workdir: dir, sessionOptions: { model: stubModel } });
  try {
    const a = await host.channel.handle({ type: 'mcp_auth', server: 'loopsrv' });
    assert.equal(a.success, true, JSON.stringify(a));
    assert.equal(a.data.loopback?.auto, true, 'loopback receiver must be announced');
    // extract state from the authorize URL, then simulate the browser redirect
    const state = new URL(a.data.url).searchParams.get('state');
    assert.ok(state);
    const hit = await fetch(`http://127.0.0.1:${cbPort}/callback?code=CODE7&state=${state}`);
    assert.equal(hit.status, 200);
    // detached exchange + store + auth_success notification
    const deadline = Date.now() + 8000;
    let stored = null, hooks = [];
    while (Date.now() < deadline) {
      if (existsSync(storePath)) { try { stored = JSON.parse(readFileSync(storePath, 'utf-8'))?.loopsrv; } catch {} }
      if (existsSync(marker)) hooks = readFileSync(marker, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      if (stored?.access_token && hooks.some((r) => r.payload?.kind === 'auth_success')) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(stored?.access_token, 'tok-loopback', 'callback-driven exchange stored the token');
    assert.equal(stored?.flow, 'authorization_code');
    assert.ok(hooks.some((r) => r.ev === 'notification' && r.payload?.kind === 'auth_success'), 'auth_success notification fired');
  } finally {
    host.dispose();
    tokenSrv.close();
    if (prevCfg === undefined) delete process.env.PAI_MCP_CONFIG; else process.env.PAI_MCP_CONFIG = prevCfg;
    if (prevStore === undefined) delete process.env.PAI_MCP_TOKEN_STORE; else process.env.PAI_MCP_TOKEN_STORE = prevStore;
  }
});

// dedup-h #1807: before_branch gate hook + skipConversationRestore — a
// hook answering {skipConversationRestore:true} branches lineage without
// the transcript; {deny} refuses; the explicit flag wins over the hook.
const mkSessionSrc = (dir, name = 'src') => {
  const src = join(dir, name + '.jsonl');
  writeFileSync(src,
    JSON.stringify({ type: 'session', version: 3, id: 'src-1', timestamp: new Date().toISOString(), cwd: dir }) + '\n' +
    JSON.stringify({ type: 'message', id: 'm1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } }) + '\n' +
    JSON.stringify({ type: 'message', id: 'm2', timestamp: new Date().toISOString(), message: { role: 'assistant', content: 'hello' } }) + '\n');
  return src;
};
const bootWithBranchHook = async (dir, answer) => {
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  const hookScript = join(dir, 'branch-hook.js');
  writeFileSync(hookScript, `process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(${JSON.stringify(JSON.stringify(answer))});});`);
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify({
    hooks: { before_branch: [{ command: `"${process.execPath}" ${JSON.stringify(hookScript)}` }] },
  }));
  return startHost({ instanceRoot: dir, workdir: dir, sessionOptions: { model: stubModel } });
};

test('#1807: before_branch hook answering skipConversationRestore branches lineage only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-branch-skip-'));
  const host = await bootWithBranchHook(dir, { skipConversationRestore: true });
  try {
    const src = mkSessionSrc(dir);
    const r = await host.channel.handle({ type: 'session_fork', path: src });
    assert.equal(r.success, true, JSON.stringify(r));
    const file = r.data?.file ?? r.file;
    assert.ok(file && existsSync(file));
    const lines = readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].type, 'session');
    assert.equal(lines[0].parentSession, resolve(src), 'lineage stamped to the source');
    assert.ok(!lines.some((l) => l.type === 'message'), 'no transcript entries carried over');
    const audit = readFileSync(join(dir, 'audit', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf-8');
    assert.match(audit, /SESSION_BRANCHED_FRESH/);
    assert.match(audit, /"via":"hook"/);
  } finally { host.dispose(); }
});

test('#1807: explicit skipConversationRestore flag branches fresh without a hook', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-branch-flag-'));
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  const host = await startHost({ instanceRoot: dir, workdir: dir, sessionOptions: { model: stubModel } });
  try {
    const src = mkSessionSrc(dir);
    const r = await host.channel.handle({ type: 'session_fork', path: src, skipConversationRestore: true });
    assert.equal(r.success, true, JSON.stringify(r));
    const file = r.data?.file ?? r.file;
    const lines = readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].parentSession, resolve(src));
    assert.ok(!lines.some((l) => l.type === 'message'));

    // entryId + skipRestore = honest refusal (nothing to navigate)
    const bad = await host.channel.handle({ type: 'session_fork', path: src, skipConversationRestore: true, entryId: 'm1' });
    assert.equal(bad.success, false);
    assert.match(String(bad.error ?? bad), /no landing|no entries/);

    // ordinary fork still carries the transcript (regression)
    const full = await host.channel.handle({ type: 'session_fork', path: src });
    assert.equal(full.success, true, JSON.stringify(full));
    const fullLines = readFileSync(full.data?.file ?? full.file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(fullLines.filter((l) => l.type === 'message').length >= 2, 'full fork inherits messages');
  } finally { host.dispose(); }
});

test('#1807: before_branch hook deny refuses the fork closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-branch-deny-'));
  const host = await bootWithBranchHook(dir, { deny: 'branches frozen for review' });
  try {
    const src = mkSessionSrc(dir);
    const r = await host.channel.handle({ type: 'session_fork', path: src });
    assert.equal(r.success, false);
    assert.match(String(r.error ?? r), /branches frozen for review/);
  } finally { host.dispose(); }
});

// dedup-h #1907 — session lifecycle hooks (finalize/reset): session_end was
// declared in HOOK_EVENTS but never fired; session_start fired once at
// channel creation and never on rebuild. A session_new must now bracket the
// boundary: session_end(old, reason) → session_start(new, reason).
test('#1907 session_new fires session_end for the old and session_start for the new', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-boot-1907-'));
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({ version: 1, deny: [], tools: {}, riskActions: {} }));
  const marker = join(dir, 'lifecycle.jsonl');
  const hookScript = join(dir, 'hook.js');
  writeFileSync(hookScript, `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const p=JSON.parse(d);require('fs').appendFileSync(${JSON.stringify(marker)},JSON.stringify({ev:p.event,sessionId:p.sessionId,reason:p.reason})+String.fromCharCode(10));});`);
  const hookCmd = `"${process.execPath}" ${JSON.stringify(hookScript)}`;
  mkdirSync(join(dir, '.pai'), { recursive: true });
  writeFileSync(join(dir, '.pai', 'hooks.json'), JSON.stringify({
    hooks: { session_start: [{ command: hookCmd }], session_end: [{ command: hookCmd }] },
  }));
  const host = await startHost({
    instanceRoot: dir,
    workdir: dir,
    sessionOptions: { model: stubModel },
  });
  try {
    const firstId = host.channel.handle ? (await host.channel.handle({ type: 'session_list' })).data?.[0]?.id ?? null : null;
    const r = await host.channel.handle({ type: 'session_new' });
    assert.equal(r.success, true, JSON.stringify(r));
    const newId = r.data.id;
    // hooks fire detached — wait for all three markers
    const deadline = Date.now() + 8000;
    let fired = [];
    while (Date.now() < deadline) {
      if (existsSync(marker)) {
        fired = readFileSync(marker, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        if (fired.filter((f) => f.ev === 'session_start').length >= 2 && fired.some((f) => f.ev === 'session_end')) break;
      }
      await new Promise((r2) => setTimeout(r2, 100));
    }
    const starts = fired.filter((f) => f.ev === 'session_start');
    const ends = fired.filter((f) => f.ev === 'session_end');
    assert.ok(starts.length >= 2, `two session_start fires expected (boot + new), got ${JSON.stringify(fired)}`);
    assert.ok(ends.length >= 1, `session_end fired (got ${JSON.stringify(fired)})`);
    assert.equal(ends[0].reason, 'new');
    // the new session_start carries the NEW session's id and the reason
    const newStart = starts[starts.length - 1];
    assert.equal(newStart.sessionId, newId);
    assert.equal(newStart.reason, 'new');
  } finally { host.dispose(); }
});

// dedup-h #1969 — http hook egress guard wired at bootstrap: the workdir
// observational runner's http entries pass through resolveChecked — a
// private/metadata literal refuses BEFORE any payload leaves; localhost
// dev intent posts normally (local single-user policy).
test('http hook egress: metadata literal refused + audited, localhost posts', async () => {
  const inst = mkdtempSync(join(tmpdir(), 'pai-heg-'));
  const dir = mkdtempSync(join(tmpdir(), 'pai-heg-wd-'));
  mkdirSync(join(inst, 'canonical'), { recursive: true });
  writeFileSync(join(inst, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  const { createServer } = await import('node:http');
  const seen = [];
  const srv = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { seen.push({ url: req.url, body: b }); res.end('{}'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  mkdirSync(join(dir, '.pai'), { recursive: true });
  writeFileSync(join(dir, '.pai', 'hooks.json'), JSON.stringify({
    hooks: {
      session_start: [
        { http: 'http://169.254.169.254/latest/meta-data' },
        { http: `http://127.0.0.1:${srv.address().port}/hook` },
      ],
    },
  }));
  const host = await startHost({
    instanceRoot: inst, workdir: dir, sessionOptions: { model: stubModel },
  });
  try {
    await host.channel.handle({ type: 'session_new' });
    // the observational runner fires detached — give the real POST a beat
    await new Promise((r) => setTimeout(r, 800));
    const hit = seen.find((s) => s.url === '/hook');
    assert.ok(hit, 'localhost http hook POSTed its payload');
    assert.match(hit.body, /session_start/);
    const audits = readdirSync(join(inst, 'audit')).flatMap((f) =>
      readFileSync(join(inst, 'audit', f), 'utf-8').trim().split('\n').map(JSON.parse));
    const refused = audits.find((e) => e.kind === 'HOOK_EGRESS_REFUSED');
    assert.ok(refused, 'private-network hook refusal audited');
    assert.match(String(refused.data?.url ?? ''), /169\.254\.169\.254/);
    assert.ok(!seen.some((s) => String(s.url).includes('meta')), 'metadata URL never fetched');
  } finally { host.dispose(); srv.close(); }
});

test('dedup-h #1981: PAI_ADMIN_CONFIG MDM tier governs auto-run — merge, exclusive lockdown, unreadable fail-closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-adm-'));
  const adminDir = mkdtempSync(join(tmpdir(), 'pai-admcfg-')); // outside instanceRoot — operator cannot edit it
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: { network: 'ask' }, // curl needs approval
  }));
  const adminFile = join(adminDir, 'admin-config.json');
  writeFileSync(adminFile, JSON.stringify({ autoRun: { allowPrefixes: ['curl https://corp.example'], exclusive: false } }));
  const prev = process.env.PAI_ADMIN_CONFIG;
  process.env.PAI_ADMIN_CONFIG = adminFile;
  try {
    const host = await startHost({ instanceRoot: dir, workdir: dir, sessionOptions: { model: stubModel } });
    try {
      const dry = (command) => host.channel.handle({ type: 'governance_dryrun', tool: 'bash', args: { command } });
      // admin prefix auto-runs — the ask is skipped
      assert.equal((await dry('curl https://corp.example/a')).data.action, 'allow');
      // non-matching command still asks
      assert.equal((await dry('curl https://other.example')).data.action, 'ask');
      // operator file merges when not exclusive
      writeFileSync(join(dir, 'command-allow.json'), JSON.stringify({ allowPrefixes: ['curl https://other.example'] }));
      assert.equal((await dry('curl https://other.example')).data.action, 'allow');
      // exclusive → operator file ignored (live re-read of the MDM file)
      writeFileSync(adminFile, JSON.stringify({ autoRun: { allowPrefixes: ['curl https://corp.example'], exclusive: true } }));
      assert.equal((await dry('curl https://other.example')).data.action, 'ask');
      assert.equal((await dry('curl https://corp.example/a')).data.action, 'allow');
      // boot posture audited
      const audits = readdirSync(join(dir, 'audit')).flatMap((f) =>
        readFileSync(join(dir, 'audit', f), 'utf-8').trim().split('\n').map(JSON.parse));
      const posture = audits.find((e) => e.kind === 'ADMIN_AUTORUN');
      assert.ok(posture, 'admin posture audited at boot');
      assert.equal(posture.data.ok, true);
      assert.equal(posture.data.exclusive, false); // boot-time snapshot: file read before the exclusive flip
    } finally { host.dispose(); }

    // env set + file unreadable → fail-closed lockdown: nothing auto-runs
    rmSync(adminFile);
    const dir2 = mkdtempSync(join(tmpdir(), 'pai-adm2-'));
    mkdirSync(join(dir2, 'canonical'), { recursive: true });
    writeFileSync(join(dir2, 'canonical', 'policy.json'), JSON.stringify({
      version: 1, deny: [], tools: {}, riskActions: { network: 'ask' },
    }));
    writeFileSync(join(dir2, 'command-allow.json'), JSON.stringify({ allowPrefixes: ['curl https://other.example'] }));
    const host2 = await startHost({ instanceRoot: dir2, workdir: dir2, sessionOptions: { model: stubModel } });
    try {
      const r = await host2.channel.handle({ type: 'governance_dryrun', tool: 'bash', args: { command: 'curl https://other.example' } });
      assert.equal(r.data.action, 'ask', 'unreadable admin file = lockdown: operator list ignored');
      const audits = readdirSync(join(dir2, 'audit')).flatMap((f) =>
        readFileSync(join(dir2, 'audit', f), 'utf-8').trim().split('\n').map(JSON.parse));
      assert.equal(audits.find((e) => e.kind === 'ADMIN_AUTORUN')?.data.ok, false);
    } finally { host2.dispose(); }
  } finally {
    if (prev === undefined) delete process.env.PAI_ADMIN_CONFIG; else process.env.PAI_ADMIN_CONFIG = prev;
  }
});

test('dedup-h #1985: skill_install upload path is operator-gated default-off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-skilli-'));
  mkdirSync(join(dir, 'canonical'), { recursive: true });
  writeFileSync(join(dir, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: { destructive: 'deny', privilege: 'deny' },
  }));
  const host = await startHost({ instanceRoot: dir, workdir: dir, sessionOptions: { model: stubModel } });
  try {
    const install = (p) => host.channel.handle({ type: 'skill_install', ...p });
    // gate absent = closed — upload refused before any file write
    const r0 = await install({ name: 'demo', triggers: ['x'], body: 'do x' });
    assert.equal(r0.success, false);
    assert.match(r0.error, /skill-install\.json/);
    assert.equal(existsSync(join(dir, '.pai', 'microagents', 'demo.md')), false);

    // operator opt-in enables the surface
    writeFileSync(join(dir, 'skill-install.json'), JSON.stringify({ allowInstall: true }));
    const r1 = await install({ name: 'demo', triggers: ['deploy', 'release'], body: 'ship it carefully' });
    assert.equal(r1.success, true);
    assert.equal(r1.data.name, 'demo');
    const written = readFileSync(join(dir, '.pai', 'microagents', 'demo.md'), 'utf-8');
    assert.match(written, /triggers: deploy, release/);
    assert.match(written, /ship it carefully/);
    // installed skill shows on the operator list surface
    const list = await host.channel.handle({ type: 'skills_list' });
    assert.ok(list.data.skills.some((s) => s.name === 'demo'));

    // gate open does not relax validation — bad name / no triggers refused
    assert.equal((await install({ name: 'bad name!', triggers: ['x'], body: 'b' })).success, false);
    assert.equal((await install({ name: 'ok-name', triggers: [], body: 'b' })).success, false);
    assert.equal(existsSync(join(dir, '.pai', 'microagents', 'bad name!.md')), false);

    // audits: refusal + install both recorded
    const audits = readdirSync(join(dir, 'audit')).flatMap((f) =>
      readFileSync(join(dir, 'audit', f), 'utf-8').trim().split('\n').map(JSON.parse));
    assert.ok(audits.some((e) => e.kind === 'SKILL_INSTALL_REFUSED'), 'closed-gate refusal audited');
    const inst = audits.find((e) => e.kind === 'SKILL_INSTALLED');
    assert.ok(inst, 'install audited');
    assert.equal(inst.data.name, 'demo');
  } finally { host.dispose(); }
});

test('dedup-h #2010: proxy.tls.caFile extends the default CA trust root', async () => {
  const tls = await import('node:tls');
  const savedCa = tls.getCACertificates('default');
  const inst = mkdtempSync(join(tmpdir(), 'pai-tlsca-'));
  const dir = mkdtempSync(join(tmpdir(), 'pai-tlsca-wd-'));
  mkdirSync(join(inst, 'canonical'), { recursive: true });
  writeFileSync(join(inst, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  // a real PEM stands in for the corporate MITM root
  writeFileSync(join(inst, 'corp-ca.pem'), tls.rootCertificates[0]);
  writeFileSync(join(inst, 'proxy.json'), JSON.stringify({
    mode: 'http://127.0.0.1:8080', tls: { caFile: 'corp-ca.pem' },
  }));
  // prove the mechanism actually applies: remove the cert from the default
  // list first — the caFile path must be what puts it back
  tls.setDefaultCACertificates(tls.rootCertificates.slice(1));
  const host = await startHost({ instanceRoot: inst, workdir: dir, sessionOptions: { model: stubModel } });
  try {
    const now = tls.getCACertificates('default');
    assert.equal(now.length, tls.rootCertificates.length, 'operator CA rejoined via caFile');
    const { X509Certificate } = await import('node:crypto');
    const want = new X509Certificate(tls.rootCertificates[0]).fingerprint256;
    assert.ok(now.some((pem) => new X509Certificate(pem).fingerprint256 === want),
      'the caFile PEM is in the trust root (fingerprint match)');
    const audits = readdirSync(join(inst, 'audit')).flatMap((f) =>
      readFileSync(join(inst, 'audit', f), 'utf-8').trim().split('\n').map(JSON.parse));
    assert.ok(audits.some((e) => e.kind === 'PROXY_CA_APPLIED'), 'CA application audited');
    const st = await host.channel.handle({ type: 'get_state' });
    assert.match(String(st.data.proxy?.caFile ?? ''), /corp-ca\.pem$/, 'status surfaces the CA path');
  } finally {
    tls.setDefaultCACertificates(savedCa); // process-global — restore
    delete process.env.NODE_USE_ENV_PROXY; delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY; delete process.env.NO_PROXY;
    host.dispose();
  }

  // unreadable trust material fails loud at boot — never silently ignored
  const inst2 = mkdtempSync(join(tmpdir(), 'pai-tlsca2-'));
  mkdirSync(join(inst2, 'canonical'), { recursive: true });
  writeFileSync(join(inst2, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  writeFileSync(join(inst2, 'proxy.json'), JSON.stringify({
    mode: 'http://127.0.0.1:8080', tls: { caFile: 'missing.pem' },
  }));
  await assert.rejects(() => startHost({
    instanceRoot: inst2, workdir: inst2, sessionOptions: { model: stubModel },
  }), /ENOENT|no such file/i);
});

// dedup-h #2051 — agents.defaults.imageQuality analogue: operator-owned
// image-detail.json seeds the session image tier; malformed seeds are
// audited and ignored, never silent.
test('dedup-h #2051: image-detail.json seeds the image tier; invalid seed ignored+audited', async () => {
  const inst = mkdtempSync(join(tmpdir(), 'pai-imgq-'));
  mkdirSync(join(inst, 'canonical'), { recursive: true });
  writeFileSync(join(inst, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  writeFileSync(join(inst, 'image-detail.json'), JSON.stringify({ tier: 'low' }));
  const host = await startHost({
    instanceRoot: inst, workdir: inst, sessionOptions: { model: stubModel },
  });
  try {
    const st = await host.channel.handle({ type: 'config_get' });
    assert.equal(st.data?.image_detail ?? st.image_detail, 'low', 'operator seed wins over the high default');
    const lines = readFileSync(
      join(inst, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf-8')
      .trim().split('\n').map(JSON.parse);
    assert.ok(lines.some((e) => e.kind === 'IMAGE_DETAIL_DEFAULT' && e.data?.tier === 'low'),
      'seed application audited');
  } finally {
    host.dispose();
  }

  // invalid tier → default kept, audited ignored
  const inst2 = mkdtempSync(join(tmpdir(), 'pai-imgq2-'));
  mkdirSync(join(inst2, 'canonical'), { recursive: true });
  writeFileSync(join(inst2, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: {},
  }));
  writeFileSync(join(inst2, 'image-detail.json'), JSON.stringify({ tier: 'ultra' }));
  const host2 = await startHost({
    instanceRoot: inst2, workdir: inst2, sessionOptions: { model: stubModel },
  });
  try {
    const st = await host2.channel.handle({ type: 'config_get' });
    assert.equal(st.data?.image_detail ?? st.image_detail, 'high', 'unknown tier falls back to high');
    const lines = readFileSync(
      join(inst2, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf-8')
      .trim().split('\n').map(JSON.parse);
    assert.ok(lines.some((e) => e.kind === 'IMAGE_DETAIL_DEFAULT_IGNORED' && e.data?.reason === 'unknown_tier'),
      'ignored seed audited with reason');
  } finally {
    host2.dispose();
  }
});
