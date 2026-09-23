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
