#!/usr/bin/env node
/**
 * delegate-bridge — the real producer side of delegation usage attribution.
 *
 * Usage:  node delegate-bridge.js --target <name> -- <delegated shell command>
 *
 * Spawns the delegated command as a real subprocess, streams its output
 * through, measures wall time and output volume, forwards any usage the child
 * itself reported (a nested `PAI_USAGE {json}` line or a trailing
 * `usage {...}` JSON object), then emits ONE authoritative
 * `PAI_USAGE {json}` line on stdout. The host JobExecutor parses that line
 * into the result envelope and JOB_FINISHED audit under parent_run_id —
 * delegated work bills to the parent run identity.
 *
 * Emitted usage shape:
 *   { via:'delegate-bridge', target, wallMs, outputBytes, exitCode,
 *     childUsage: <object|null> }
 * childUsage carries token/cost when the delegate reports it; measured fields
 * are always real — never synthesized.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep === -1 || sep === argv.length - 1) {
  console.error('delegate-bridge: expected "-- <command>"');
  process.exit(2);
}
const tIdx = argv.indexOf('--target');
const target = tIdx !== -1 ? argv[tIdx + 1] : 'unknown';
// F-family mailbox: --task-dir binds this delegation to an AgentTask record.
// parent→child: inbox.jsonl rows forwarded to child stdin as `steer` frames.
// child→parent: child stdout markers PAI_TASK_POST/PAI_TASK_EVENT are
// intercepted into outbox/events — real for ANY subprocess that emits them.
// --task-dir sits before `--` so it never enters the spawned command.
const tdIdx = argv.indexOf('--task-dir');
const taskDir = tdIdx !== -1 ? argv[tdIdx + 1] : null;
if (taskDir) mkdirSync(taskDir, { recursive: true });
// the child may claim its own mailbox: PAI_TASK_DIR lets a pai body write
// its run scope back into task.json — that is what makes nested delegation
// render as a real tree instead of a flat list

const streamAppend = (stream, row) => {
  const p = join(taskDir, `${stream}.jsonl`);
  const seq = existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter(Boolean).length + 1 : 1;
  appendFileSync(p, `${JSON.stringify({ seq, ts: new Date().toISOString(), ...row })}\n`);
};
// Bounded delegation: the parent issues the child an enforceable budget cap
// via env. A pai-channel child reads PAI_BUDGET_MAX_* at bootstrap and gates
// every provider request itself — the cap is enforcement, not a hint.
const flagVal = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : null;
};
const childEnv = { ...process.env };
const budgetEnv = {
  '--budget-tokens': 'PAI_BUDGET_MAX_TOKENS',
  '--budget-calls': 'PAI_BUDGET_MAX_CALLS',
  '--budget-cost': 'PAI_BUDGET_MAX_COST_USD',
};
for (const [flag, envName] of Object.entries(budgetEnv)) {
  const v = flagVal(flag);
  if (v != null) childEnv[envName] = String(v);
}
if (taskDir) childEnv.PAI_TASK_DIR = taskDir;
// Thread-tree depth (Codex): the parent stamps the child's nesting level so
// a nested delegate_task call sees its own depth and hits the cap honestly.
const taskDepth = flagVal('--task-depth');
if (taskDepth != null) childEnv.PAI_SPAWN_DEPTH = String(taskDepth);
// Steering isolation (CC omitClaudeMd analogue): a dedicated bridge flag —
// never settable through --env-json since PAI_* is refused there — blinds the
// child to workdir steering files. Profiles can only request this when they
// come from an operator-private dir or a trusted project.
if (argv.includes('--steering-off')) childEnv.PAI_STEERING_OFF = '1';
// M76 per-agent disallowedTools — dedicated flag (PAI_* refused via
// --env-json, so a profile/env can never inject it sideways): pai-channel
// children read PAI_TOOLS_DENY into their initial deny surface; foreign
// harnesses ignore it — the profile doc states that honestly.
const toolsDeny = flagVal('--tools-deny');
if (toolsDeny) childEnv.PAI_TOOLS_DENY = String(toolsDeny).slice(0, 2000);
// dedup-h #1112 — `tools:` profile allowlist rides the same dedicated-flag
// channel; the child's bootstrap enforces it at decide + surface.
const toolsAllow = flagVal('--tools-allow');
if (toolsAllow) childEnv.PAI_TOOLS_ALLOW = String(toolsAllow).slice(0, 2000);
// C3 per-agent MCP subset — same dedicated-flag channel: the child's mcp
// extension reads PAI_MCP_DENY and skips denied servers at connect time.
const mcpDeny = flagVal('--mcp-deny');
if (mcpDeny) childEnv.PAI_MCP_DENY = String(mcpDeny).slice(0, 4000);
// dedup-h #1390 — agent context id for mcp.servers.<name>.context scoping:
// the profile name this delegate child runs under. Base64 so any profile
// name (unicode included) survives the shell argv channel byte-exact; a
// dedicated flag because --env-json refuses PAI_*. Profile-less children
// inherit the parent id through env passthrough — context scope propagates
// down the delegation tree.
const agentIdB64 = flagVal('--agent-id-b64');
if (agentIdB64) {
  try { childEnv.PAI_AGENT_ID = Buffer.from(agentIdB64, 'base64').toString('utf-8').slice(0, 200); }
  catch { /* malformed stamp — child inherits the parent context */ }
}
// dedup-h #1546 — agent.compaction_model: the profile-declared summarizer
// model rides the same dedicated-flag channel (PAI_* refused via --env-json).
// The child's bootstrap resolves it into the compaction path; a bare value
// means "model on the session provider", provider/model pins both.
const compactionB64 = flagVal('--compaction-model-b64');
if (compactionB64) {
  try { childEnv.PAI_COMPACTION_MODEL = Buffer.from(compactionB64, 'base64').toString('utf-8').slice(0, 300); }
  catch { /* malformed stamp — child compacts on its session model */ }
}
// Profile env fields (OpenHands profile-scoped secrets analogue): set/deny
// ride the bridge so the CHILD's env is shaped — the parent process env is
// untouched. PAI_* keys are refused outright, so profile env can never
// override the enforcement channels applied above (budget/depth/task dir).
const envJson = flagVal('--env-json');
if (envJson) {
  try {
    const spec = JSON.parse(Buffer.from(envJson, 'base64').toString('utf-8'));
    for (const k of spec.deny ?? []) {
      if (typeof k === 'string' && !k.startsWith('PAI_')) delete childEnv[k];
    }
    for (const [k, v] of Object.entries(spec.set ?? {})) {
      if (!k.startsWith('PAI_')) childEnv[k] = String(v);
    }
  } catch { /* malformed env spec — ignore, child runs with parent env */ }
}
// re-quote args that lost their shell quoting through argv — whitespace must
// survive the shell:true respawn as one token
const command = argv.slice(sep + 1)
  .map((a) => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
  .join(' ');

const started = Date.now();
const child = spawn(command, { windowsHide: true, shell: true, env: childEnv });
let out = '';
let outputBytes = 0;

// --- mailbox wiring (only when --task-dir is bound) ----------------------
let lineBuf = '';
const markerRe = /^(PAI_TASK_POST|PAI_TASK_EVENT) (\{.*\})\s*$/;
const scanLine = (line) => {
  const m = line.match(markerRe);
  if (!m) { out += `${line}\n`; return; }
  try {
    const payload = JSON.parse(m[2]);
    streamAppend(m[1] === 'PAI_TASK_POST' ? 'outbox' : 'events',
      m[1] === 'PAI_TASK_POST' ? { from: target, body: payload.body ?? payload } : { kind: payload.kind ?? 'child_event', data: payload });
  } catch { out += `${line}\n`; } // malformed marker stays visible in output
};
const onStdout = taskDir
  ? (d) => {
      outputBytes += d.length;
      lineBuf += d;
      let i;
      while ((i = lineBuf.indexOf('\n')) !== -1) { scanLine(lineBuf.slice(0, i).replace(/\r$/, '')); lineBuf = lineBuf.slice(i + 1); }
    }
  : (d) => { out += d; outputBytes += d.length; };
child.stdout.on('data', onStdout);
child.stderr.on('data', (d) => { out += d; outputBytes += d.length; });

// parent→child: poll inbox.jsonl, forward new rows as steer frames on the
// child's stdin (pai-channel speaks the JSONL protocol; a foreign child
// simply sees JSON on stdin — opt-in, never harmful).
let inboxSeen = 0;
const inboxTimer = taskDir ? setInterval(() => {
  try {
    const p = join(taskDir, 'inbox.jsonl');
    if (!existsSync(p)) return;
    const rows = readFileSync(p, 'utf-8').split('\n').filter(Boolean);
    for (const l of rows.slice(inboxSeen)) {
      try {
        const row = JSON.parse(l);
        child.stdin.write(`${JSON.stringify({ type: 'steer', message: `[parent] ${row.body}` })}\n`);
      } catch { /* malformed row skipped */ }
    }
    inboxSeen = rows.length;
  } catch { /* inbox watch is best-effort */ }
}, 400) : null;

child.on('error', (e) => {
  console.log(`PAI_USAGE ${JSON.stringify({
    via: 'delegate-bridge', target, wallMs: Date.now() - started,
    outputBytes, exitCode: null, childUsage: null, error: e.message,
  })}`);
  process.exit(1);
});

child.on('exit', (code) => {
  if (inboxTimer) clearInterval(inboxTimer);
  if (lineBuf) { if (taskDir) scanLine(lineBuf); else out += lineBuf; lineBuf = ''; }
  if (taskDir) {
    try { streamAppend('events', { kind: 'child_exited', data: { exitCode: code, wallMs: Date.now() - started } }); } catch { /* best-effort */ }
  }
  // child's own usage report wins the detail slot; ours is the envelope
  const nested = out.match(/PAI_USAGE (\{[^\n]*\})/);
  const loose = out.match(/usage[=: ]+(\{[^\n]*\})/i);
  let childUsage = null;
  for (const m of [nested, loose]) {
    if (m) { try { childUsage = JSON.parse(m[1]); break; } catch { /* keep null */ } }
  }
  // strip the child's own marker lines — the bridge's single authoritative
  // PAI_USAGE envelope carries them nested under childUsage instead, so the
  // executor's first-match parse sees exactly one producer record
  process.stdout.write(out.split('\n').filter((l) => !/PAI_USAGE \{/.test(l)).join('\n'));
  console.log(`PAI_USAGE ${JSON.stringify({
    via: 'delegate-bridge', target, wallMs: Date.now() - started,
    outputBytes, exitCode: code, childUsage,
  })}`);
  process.exit(code ?? 1);
});
