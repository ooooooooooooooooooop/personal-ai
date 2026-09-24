import { isLongRunningCommand } from '../adapter/jobs.js';
import { hashOf } from '../../../host/src/core/audit.js';
import { EXEC_BODY_TOOLS, GIT_INTERNAL_RE, INSTRUCTION_PATH_RES } from '../../../host/src/core/governance.js';
import { scanForSecrets } from '../adapter/secrets.js';
import { pathInsideRoot, pathInsideRootForWrite } from '../adapter/paths.js';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

const FILE_MUTATION_TOOLS = new Set(['write', 'edit', 'delete', 'multi_edit']);
const MUTATING_RISK = new Set(['mutating', 'destructive', 'exec', 'unknown']);
// Goose unicode-tag sanitization analogue — invisible format chars that can
// hide instructions or spoof identifiers (zero-width, bidi controls, BOM).
// \u200B-\u200F zero-width, \u202A-\u202E bidi embed/override,
// \u2060-\u2064 word joiner/invisible ops, \uFEFF BOM, \u00AD soft hyphen
const INVISIBLE_UNICODE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g;
// Command/path args: invisible chars are ~always adversarial → block.
const STRICT_ARG_KEYS = new Set(['command', 'path', 'file', 'target', 'pattern', 'query', 'url']);
// Free-text payloads (write content, edits, messages): strip, don't refuse —
// prose can legitimately carry odd whitespace.
function sanitizeArgs(args) {
  const out = { blocked: [], stripped: 0, args };
  const walk = (v) => {
    if (typeof v === 'string' && INVISIBLE_UNICODE.test(v)) {
      out.stripped += 1;
      return v.replace(INVISIBLE_UNICODE, '');
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  for (const [k, v] of Object.entries(args ?? {})) {
    if (STRICT_ARG_KEYS.has(k) && typeof v === 'string' && INVISIBLE_UNICODE.test(v)) {
      out.blocked.push(k);
    } else {
      out.args = { ...out.args, [k]: walk(v) };
    }
  }
  return out;
}
// File-access tool surface the .paiignore check applies to — read AND write
// families: context exclusion means invisible AND untouchable.
const FILE_ACCESS_TOOLS = new Set(['read', 'ls', 'grep', 'glob', 'find', 'search', 'search_files', 'write', 'edit', 'delete', 'apply_patch', 'patch']);
// Read-family tools whose path arg is checked against the workspace boundary.
const READ_PATH_TOOLS = new Set(['read', 'ls', 'grep', 'glob', 'find', 'search', 'search_files']);
// Tools whose args carry a shell command string — prefix lists apply here.
// GATE-COMPOSITION-01: job_spawn's command arg is a shell command too — a
// project denyPrefix must gate normal spawns exactly as it gates restarts.
const COMMAND_ARG_KEYS = { bash: 'command', shell: 'command', powershell: 'command', cmd: 'command', job_spawn: 'command', schedule_task: 'command' };

/**
 * Roo command deny-list analogue: `.pai/commands.json` `{denyPrefixes:[]}` —
 * workdir-side tightening only. A prefix match blocks before the kernel runs;
 * there is no allow list here because an agent-writable file must never widen.
 * Operator-side allowlists live at <instance>/command-allow.json (kernel dep).
 */
export function commandDenyPrefixes(workdir) {
  try {
    const doc = JSON.parse(readFileSync(join(workdir, '.pai', 'commands.json'), 'utf-8'));
    return (Array.isArray(doc?.denyPrefixes) ? doc.denyPrefixes : [])
      .map((p) => String(p).trim()).filter(Boolean).slice(0, 100);
  } catch { return []; }
}

/**
 * The post-kernel decide chain used by the real composite guard. Extracted so
 * tests can drive it directly instead of treating production wiring as
 * untestable internals.
 *
 * Order: kernel deny (terminate → deny→hide) → loop detector (warn/block/
 * operator-escalate on stuck repetition) → workspace write-lease mutex
 * (foreground mutation vs held job lease) → FileOpsGuard (backup/recycle)
 * → long-command jobization → admit.
 */
export function makeDecide({ core, executor, fileOps, getSurface, workdir, writeLease = null, classifier = null, getSessionScope = null, loopwatch = null, asks = null, shadowJudge = null, paiignore = null, maxTurnCalls = null, preToolGate = null, worldModelGuard = null, allowedTools = null }) {
  // Qwen MAX_TURNS analogue: hard cap on admitted tool calls per user turn.
  // The refusal reason is the steering channel — it tells the model to stop
  // and report, not to retry.
  const cap = maxTurnCalls ?? (Number(process.env.PAI_MAX_TOOL_CALLS) > 0 ? Number(process.env.PAI_MAX_TOOL_CALLS) : 100);
  let turnCalls = 0;
  // CC blockReadsOutsideWorkingDirectories analogue — session latch:
  // null=not asked yet · 'allowed'=operator permitted all · 'blocked'=deny all.
  let readOutside = null;
  let writeOutside = null;
  const absFor = (p) => resolve(workdir, String(p));
  // Realpath-resolved workdir root, computed lazily — a workdir that itself
  // sits under a symlink/junction must compare real-to-real, or every path
  // would read as "outside".
  let realRoot = null;
  const realWorkdir = () => {
    if (realRoot === null) {
      try { realRoot = realpathSync(resolve(workdir)); } catch { realRoot = resolve(workdir); }
    }
    return realRoot;
  };
  // Read boundary, realpath-aware: lexical resolve alone cannot see an
  // in-workdir symlink pointing outside (`link -> C:\other` makes
  // `link/secret.txt` lexically inside). Existing targets are compared on
  // their real path; nonexistent ones stand on the lexical check.
  const outsideWorkdir = (p) => {
    const abs = absFor(p);
    if (!pathInsideRoot(workdir, abs)) return true;
    try { return !pathInsideRoot(realWorkdir(), realpathSync(abs)); } catch { return false; }
  };
  // Write boundary: parent-dir realpath + (existing) target realpath inside
  // realpath(root) — defeats symlinked parents and 8.3 aliases that lexical
  // checks cannot see.
  const outsideWriteTarget = (p) => !pathInsideRootForWrite(realWorkdir(), absFor(p));
  // Redirect/device sinks that legitimately resolve outside the worktree —
  // `> NUL`, `> /dev/null` are not file mutations.
  const DEVICE_TARGET_RE = /^(?:nul|con|prn|aux|com\d|lpt\d)(?:\.|:|$)|^\/dev\/(null|zero|stdout|stderr|stdin|tty)/i;
  // Resolve a write target to the path the filesystem will actually write:
  // the target itself may not exist yet, so walk up to the deepest existing
  // ancestor (a symlinked parent is exactly the evasion lane) and rejoin the
  // unresolved tail.
  const realTarget = (p) => {
    const abs = absFor(p);
    const tail = [];
    let cur = abs;
    for (let i = 0; i < 40; i++) {
      try { return join(realpathSync(cur), ...tail); } catch {
        const parent = dirname(cur);
        if (parent === cur) return abs;
        tail.unshift(basename(cur));
        cur = parent;
      }
    }
    return abs;
  };
  const inner = async (ctx, signal) => {
    const toolName = ctx.toolCall?.name ?? ctx.toolName;
    // Invisible-unicode sanitization FIRST (Goose analogue): the kernel must
    // classify the same text that would execute — zero-width chars can spoof
    // both classifier patterns and identifiers. Strict arg keys block;
    // free-text payloads are stripped so model text == executed text.
    const san = sanitizeArgs(ctx.args);
    if (san.blocked.length) {
      core.audit.write({ kind: 'UNICODE_BLOCK', toolName, data: { keys: san.blocked } });
      return {
        block: true,
        rule: 'unicode_invisible',
        reason: `invisible unicode in ${san.blocked.map((k) => `'${k}'`).join(', ')} (zero-width/bidi/format chars) — likely hidden-instruction or identifier spoofing; rewrite with visible characters`,
      };
    }
    if (san.stripped) {
      ctx = { ...ctx, args: san.args };
      core.audit.write({ kind: 'UNICODE_SANITIZED', toolName, data: { stripped: san.stripped } });
    }
    // M83 lazy surface: a deferred tool is hidden from the schema surface,
    // but a model that guesses its name must not execute it — the call
    // blocks with an activation hint instead of running schema-less.
    if (getSurface()?.isLazy?.(toolName)) {
      return {
        block: true,
        rule: 'tool_deferred',
        reason: `'${toolName}' is deferred (lazy surface) — call tool_activate({names:["${toolName}"]}) first, then retry`,
        repair: `activate via tool_activate, then re-issue the call`,
      };
    }
    // dedup-h #1112 — delegate-child tool allowlist (profile `tools:` →
    // PAI_TOOLS_ALLOW): a name-set check, not an enumeration, so tools
    // registered late (async MCP, list_changed) hit the same wall.
    if (allowedTools && !allowedTools(toolName)) {
      core.audit.write({ kind: 'TOOL_ALLOWLIST_BLOCK', toolName, data: { toolCallId: ctx.toolCall?.id ?? null } });
      return {
        block: true,
        rule: 'tool_allowlist',
        reason: `'${toolName}' is not on this session's tool allowlist — work within the allowed set or ask the delegator to widen the profile`,
      };
    }
    // signal rides on ctx so the kernel's ask path can abort a pending
    // operator question when the session is interrupted mid-decision
    const decision = await core.kernel.decideToolCall({ ...ctx, toolName, signal });
    if (decision) {
      // terminate-level denial also removes the tool from the visible
      // surface (deny→hide) so the model stops retrying it — persisted.
      if (decision.terminate) getSurface()?.deny(toolName);
      return decision; // kernel denied — done
    }
    if (turnCalls >= cap) {
      core.audit.write({ kind: 'TURN_CAP_BLOCK', toolName, data: { toolCallId: ctx.toolCall?.id, turnCalls, cap } });
      return {
        block: true,
        rule: 'turn_cap',
        reason: `turn tool-call budget exhausted (${turnCalls}/${cap}) — stop calling tools, report what was accomplished and what remains; the user can send a follow-up to continue`,
      };
    }
    // .pai/commands.json deny prefixes — project-side tightening, checked
    // before the kernel so a matched command never reaches any admit path.
    const cmdKey = COMMAND_ARG_KEYS[toolName];
    if (cmdKey && typeof ctx.args?.[cmdKey] === 'string') {
      const cmdText = ctx.args[cmdKey].trim();
      const hit = commandDenyPrefixes(workdir).find((p) => cmdText.startsWith(p));
      if (hit) {
        core.audit.write({ kind: 'COMMAND_DENYLIST_BLOCK', toolName, data: { prefix: hit } });
        return {
          block: true,
          rule: 'command_denylist',
          reason: `command matches .pai/commands.json denyPrefix '${hit}' — project-level deny`,
        };
      }
    }
    // Mistake-limit stop: the operator answered 'stop' to a consecutive-
    // error escalation — no further tool calls this turn regardless of shape.
    if (loopwatch?.stopped) {
      return {
        block: true,
        rule: 'mistake_limit',
        reason: 'operator stopped this run after consecutive tool errors — report status and wait for a new instruction',
      };
    }
    // .paiignore context exclusion — refused for read AND write families.
    // Patterns can only restrict, never grant, so an agent-writable ignore
    // file cannot loosen the boundary.
    if (paiignore?.loaded && FILE_ACCESS_TOOLS.has(toolName)) {
      const p = ctx.args?.path ?? ctx.args?.file ?? ctx.args?.target;
      if (typeof p === 'string' && paiignore.isIgnored(p)) {
        core.audit.write({ kind: 'PAIIGNORE_BLOCK', toolName, data: { path: p.slice(0, 200) } });
        return {
          block: true,
          rule: 'paiignore',
          reason: `'${p}' is excluded by .paiignore — context-excluded paths are invisible and untouchable`,
        };
      }
    }
    // Read-outside-workspace boundary (CC analogue): the FIRST outside read
    // prompts the operator once; 'deny' latches a session-wide block so the
    // model cannot trickle the filesystem out path by path. No operator
    // channel → fail closed on outside reads (they are never urgent).
    const readPath = ctx.args?.path ?? ctx.args?.dir ?? ctx.args?.file;
    if (typeof readPath === 'string' && READ_PATH_TOOLS.has(toolName) && outsideWorkdir(readPath)) {
      if (readOutside === 'blocked') {
        return { block: true, rule: 'read_outside', reason: `reads outside the workspace are blocked this session (operator choice) — '${readPath}' is outside ${workdir}` };
      }
      if (readOutside !== 'allowed') {
        const answer = asks?.ask
          ? await asks.ask({
              toolName,
              toolCallId: ctx.toolCall?.id ?? null,
              rule: 'read_outside',
              summary: `read outside workspace: ${String(readPath).slice(0, 300)}`,
              detail: `工具 ${toolName} 要读取工作目录之外的路径。允许一次=仅本次；本会话允许=此后越界读不再询问；拒绝=本会话所有越界读直接拦下。`,
              args: { path: readPath },
              argsTruncated: false,
              argsTotalChars: null,
            }, signal)
          : 'deny';
        core.audit.write({ kind: 'READ_OUTSIDE_RESOLVED', toolName, data: { path: String(readPath).slice(0, 300), answer } });
        if (answer === 'deny') {
          readOutside = 'blocked';
          return { block: true, rule: 'read_outside', reason: `operator refused reads outside the workspace — '${readPath}' blocked` };
        }
        if (answer === 'allow_session' || answer === 'always') readOutside = 'allowed';
        // 'allow' = this call proceeds; the next outside read asks again
      }
    }
    // Write-outside-workspace boundary — the missing half of the read gate:
    // file-mutation tools had NO workdir check (protectedRoots only cover
    // instance internals), so `write C:\other\x` or a symlinked parent could
    // persist bytes anywhere without a boundary question. Same latch shape
    // as read_outside; fail-closed when no operator channel exists.
    if (FILE_MUTATION_TOOLS.has(toolName)) {
      const writePaths = toolName === 'multi_edit'
        ? (Array.isArray(ctx.args?.edits) ? ctx.args.edits.map((e) => e?.path).filter(Boolean) : [])
        : [ctx.args?.path ?? ctx.args?.file ?? ctx.args?.target].filter((x) => typeof x === 'string');
      const badWrite = writePaths.find((p) => outsideWriteTarget(p));
      if (badWrite) {
        if (writeOutside === 'blocked') {
          return { block: true, rule: 'write_outside', reason: `writes outside the workspace are blocked this session (operator choice) — '${badWrite}' is outside ${workdir}` };
        }
        if (writeOutside !== 'allowed') {
          const answer = asks?.ask
            ? await asks.ask({
                toolName,
                toolCallId: ctx.toolCall?.id ?? null,
                rule: 'write_outside',
                summary: `write outside workspace: ${String(badWrite).slice(0, 300)}`,
                detail: `工具 ${toolName} 要写入工作目录之外的路径（含符号链接逃逸）。允许一次=仅本次；本会话允许=此后越界写不再询问；拒绝=本会话所有越界写直接拦下。`,
                args: { path: badWrite, paths: writePaths.slice(0, 10) },
                argsTruncated: writePaths.length > 10,
                argsTotalChars: null,
              }, signal)
            : 'deny';
          core.audit.write({ kind: 'WRITE_OUTSIDE_RESOLVED', toolName, data: { path: String(badWrite).slice(0, 300), answer } });
          if (answer === 'deny') {
            writeOutside = 'blocked';
            return { block: true, rule: 'write_outside', reason: `operator refused writes outside the workspace — '${badWrite}' blocked` };
          }
          if (answer === 'allow_session' || answer === 'always') writeOutside = 'allowed';
        }
      }
      // Resolved-path recheck for file tools — the kernel matched the
      // instruction/.git regexes on the LEXICAL arg inside decideToolCall,
      // but `write link/config` where link -> .git carries no '.git' in its
      // string form while the filesystem writes .git/config. The same
      // realTarget walk the shell writeTargets block uses closes the lane
      // here: a realpath hit re-asks because the lexical approval was for
      // a different file than the filesystem will write.
      if (writePaths.length) {
        // Only re-ask when the resolved target DIFFERS from the lexical arg
        // — same-path hits were already adjudicated by the kernel's lexical
        // check, and re-asking them would double-prompt every .pai/ write.
        const realHit = writePaths
          .filter((p) => String(realTarget(p)).toLowerCase() !== String(absFor(p)).toLowerCase())
          .map(realTarget)
          .find((t) => {
            const norm = String(t).replace(/\\/g, '/');
            return GIT_INTERNAL_RE.test(norm) || INSTRUCTION_PATH_RES.some((re) => re.test(norm));
          });
        if (realHit) {
          const rule = GIT_INTERNAL_RE.test(String(realHit).replace(/\\/g, '/')) ? 'git_internal' : 'instruction_file';
          const answer = asks?.ask
            ? await asks.ask({
                toolName,
                toolCallId: ctx.toolCall?.id ?? null,
                rule,
                summary: `write target resolves into ${rule === 'git_internal' ? '.git internals' : 'an agent instruction file'}: ${String(realHit).slice(0, 300)}`,
                detail: `文件工具写目标的真实路径命中 ${rule === 'git_internal' ? '.git 内部（hooks/config/refs 是持久化执行面）' : 'agent 指令文件（standing orders）'}——lexical 路径未命中，是符号链接/别名逃逸。`,
                args: { path: String(realHit).slice(0, 300), requested: writePaths.slice(0, 10) },
                argsTruncated: false,
                argsTotalChars: null,
              }, signal)
            : 'deny';
          core.audit.write({ kind: 'WRITE_OUTSIDE_RESOLVED', toolName, data: { target: String(realHit).slice(0, 300), rule, answer } });
          if (answer !== 'allow' && answer !== 'allow_session' && answer !== 'always') {
            return { block: true, rule, reason: `operator refused this write target — '${realHit}' blocked` };
          }
        }
      }
    }
    // World-model gate (BCC-1 6.3): a consequential mutation in core/full must
    // bind to an open, unevaluated prediction that names the tool and its
    // target; an irreversible payload additionally needs irreversible:true on
    // that prediction. In-process and deterministic, so it runs before the
    // operator's pre_tool hook (which may spawn a process). The guard is a
    // body-supplied function: the chain stays ignorant of the world model.
    if (worldModelGuard) {
      const g = worldModelGuard({ name: toolName, arguments: ctx.args ?? {} });
      if (typeof g === 'string' && g) {
        core.audit.write({ kind: 'WORLD_MODEL_BLOCK', toolName, data: { toolCallId: ctx.toolCall?.id, reason: g.slice(0, 300) } });
        return { block: true, rule: 'world_model_prediction_binding', reason: g };
      }
    }
    // Operator veto hooks (Claude Code PreToolUse analogue): <instance>/
    // hooks.json is operator-private — the agent cannot reach it, so this is
    // a real external gate. Runs after every cheap deterministic refuse so a
    // hook process is never spawned for a call already dead. Fail-closed.
    if (preToolGate) {
      try {
        const g = await preToolGate.fireGate('pre_tool', {
          tool: toolName,
          toolCallId: ctx.toolCall?.id ?? null,
          args: ctx.args ?? {},
        });
        if (g?.deny) {
          core.audit.write({ kind: 'HOOK_VETO', toolName, data: { toolCallId: ctx.toolCall?.id, reason: g.deny.slice(0, 300) } });
          return {
            block: true,
            rule: 'pre_tool_hook',
            reason: `operator pre_tool hook refused: ${g.deny}`,
          };
        }
        // dedup-h #109: the hook asked for operator adjudication — suspend
        // on a real approval ask. A hook can escalate, never self-approve;
        // without an ask channel the escalation fails closed.
        if (g?.requireApproval) {
          core.audit.write({ kind: 'HOOK_ESCALATE', toolName, data: { toolCallId: ctx.toolCall?.id, question: g.requireApproval.slice(0, 300) } });
          if (!asks) {
            return { block: true, rule: 'pre_tool_hook', reason: `operator pre_tool hook requested approval but no operator channel is configured (fail-closed)` };
          }
          const answer = await asks.ask({
            toolName,
            toolCallId: ctx.toolCall?.id,
            rule: 'pre_tool_hook',
            summary: `pre_tool hook requests approval for ${toolName}`,
            detail: g.requireApproval,
            args: ctx.args ?? {},
            argsTruncated: false,
            argsTotalChars: null,
          }, signal);
          core.audit.write({ kind: 'HOOK_ESCALATE_RESOLVED', toolName, data: { toolCallId: ctx.toolCall?.id, answer } });
          if (answer !== 'allow' && answer !== 'allow_session' && answer !== 'always') {
            return { block: true, rule: 'pre_tool_hook', reason: `operator denied the hook-escalated call (${answer})` };
          }
        }
      } catch (err) {
        // A broken gate must never silently pass — fail closed.
        core.audit.write({ kind: 'HOOK_VETO', toolName, data: { toolCallId: ctx.toolCall?.id, error: String(err?.message ?? err).slice(0, 200) } });
        return {
          block: true,
          rule: 'pre_tool_hook',
          reason: `operator pre_tool hook error (fail-closed): ${String(err?.message ?? err).slice(0, 200)}`,
        };
      }
    }
    // Kernel admitted — loop detector scores the call. Only calls that would
    // execute are counted; block reasons are returned as the tool result so
    // the refusal text itself is the steering channel.
    if (loopwatch) {
      const v = loopwatch.observe(toolName, ctx.args ?? {});
      if (v.level === 'warn') {
        core.audit.write({ kind: 'LOOP_DETECT_WARN', toolName, data: { toolCallId: ctx.toolCall?.id, loop: v.kind, count: v.count } });
      } else if (v.level === 'block' || (v.level === 'escalate' && !asks)) {
        core.audit.write({ kind: 'LOOP_DETECT_BLOCK', toolName, data: { toolCallId: ctx.toolCall?.id, loop: v.kind, count: v.count, blocked: v.blocked } });
        return {
          block: true,
          rule: 'loop_detect',
          reason: v.level === 'escalate'
            ? `${v.reason} — no operator channel configured (fail-closed)`
            : v.reason,
        };
      } else if (v.level === 'escalate') {
        // Persistent retry after refusals → the operator adjudicates.
        const answer = await asks.ask({
          toolName,
          toolCallId: ctx.toolCall?.id,
          rule: 'loop_detect',
          summary: `${toolName} repeated ${v.count}× consecutively after ${v.blocked} refusals`,
          detail: v.reason,
          args: { signature: v.signature.slice(0, 80), count: v.count, blocked: v.blocked },
          argsTruncated: false,
          argsTotalChars: null,
        }, signal);
        core.audit.write({ kind: 'LOOP_DETECT_RESOLVED', toolName, data: { toolCallId: ctx.toolCall?.id, answer } });
        // 'always' must count as a grant HERE (batch-9 class): PendingAsks
        // already persisted the pattern — treating it as a refusal kills this
        // call while the next identical one auto-allows.
        if (answer === 'allow' || answer === 'allow_session' || answer === 'always') {
          loopwatch.forgive(v.signature); // operator's allow = scored fresh
        } else {
          return {
            block: true,
            rule: 'loop_detect',
            reason: `loop refusal confirmed by operator (${answer}) — ${v.reason}`,
          };
        }
      }
    }
    // U4 pre-write secret scan: credential-looking content being persisted is
    // an operator question, not a silent write (fixtures/templates are real —
    // the human decides; no ask channel fails closed)
    if (toolName === 'write' || toolName === 'edit' || toolName === 'multi_edit') {
      // multi_edit carries the payload as edits[].new_string — scan them all;
      // without this the batch tool would be a silent bypass around U4.
      const contentToWrite = toolName === 'write'
        ? ctx.args?.content
        : toolName === 'multi_edit'
          ? (Array.isArray(ctx.args?.edits) ? ctx.args.edits.map((e) => e?.new_string ?? '').join('\n') : null)
          : (ctx.args?.newText ?? ctx.args?.new_string);
      const hit = typeof contentToWrite === 'string' ? scanForSecrets(contentToWrite) : null;
      if (hit) {
        const filePath = ctx.args?.path ?? ctx.args?.file ?? ctx.args?.target;
        if (!asks) {
          return {
            block: true,
            rule: 'secret_scan',
            reason: `secret scan: content matches credential pattern '${hit}' — no operator channel (fail-closed)`,
          };
        }
        const answer = await asks.ask({
          toolName,
          toolCallId: ctx.toolCall?.id,
          rule: 'secret_scan',
          summary: `${toolName} ${filePath ?? ''}: content matches credential pattern '${hit}'`,
          detail: 'write it anyway? a real secret persisted here lands in the file AND the transcript',
          args: { path: filePath ?? null, pattern: hit },
          argsTruncated: false,
          argsTotalChars: null,
        }, signal);
        core.audit.write({ kind: 'SECRET_SCAN_RESOLVED', toolName, data: { toolCallId: ctx.toolCall?.id, pattern: hit, answer } });
        // 'always' is a grant (persisted host-side by PendingAsks) — refusing
        // it here would be the batch-9 incoherence: grant recorded, call dead.
        if (answer !== 'allow' && answer !== 'allow_session' && answer !== 'always') {
          return {
            block: true,
            rule: 'secret_scan',
            reason: `secret scan refused by operator (${answer}): content matches '${hit}'`,
          };
        }
      }
    }
    // kernel admitted: long-running commands become durable jobs FIRST —
    // the job acquires its own `job:` write lease, so this path must run
    // before the foreground lease is taken (no fg→job lock handoff).
    const command = ctx.args?.command;
    // job_spawn carries its own spawn semantics (sandbox/worktree params) —
    // auto-converting it here would spawn a job WITHOUT those options.
    if (toolName !== 'job_spawn' && typeof command === 'string' && isLongRunningCommand(command)) {
      const r = await executor.spawnCommandJob({
        command,
        workdir,
        jobType: 'shell_command',
        budgetScope: getSessionScope?.(),
      });
      if (r.refused) {
        return { block: true, rule: 'workspace_lease', reason: `durable job refused: ${r.reason}` };
      }
      return {
        block: true,
        reason:
          `long-running command converted to durable job ${r.job_id} ` +
          `(attempt ${r.attempt_id}) — it survives restarts; poll job_status`,
      };
    }
    // kernel admitted — a mutating call must HOLD the workspace write lease
    // through execution (not just check it): acquire is atomic check-and-set,
    // released by the afterToolCall hook on tool_execution_end. File tools are
    // mutating by name; shell commands are re-classified here (the kernel's
    // parse stays internal to its decision, and re-parsing is cheap and
    // deterministic).
    const commandForLease = ctx.args?.command;
    // mcp__* tools are opaque external effects — they serialize against the
    // workspace lease like local mutations even though they touch no files.
    // job_spawn writes nothing itself — the spawned job serializes via its
    // own `job:` lease inside spawnCommandJob (an fg lease here would make
    // every mutating job_spawn refuse against its own caller's hold).
    let mutating = FILE_MUTATION_TOOLS.has(toolName) || toolName?.startsWith('mcp__') || EXEC_BODY_TOOLS.has(toolName);
    if (toolName === 'job_spawn') mutating = false;
    if (!mutating && typeof commandForLease === 'string' && classifier) {
      try {
        const parsed = await classifier(commandForLease);
        // Deny provably-mutating commands plus unrecognized commands that carry
        // shell write syntax (redirects) — the residual hole the classifier
        // cannot see. Unknown commands without write syntax are read-capable,
        // matching the trust level the kernel already grants them.
        mutating = MUTATING_RISK.has(parsed.risk)
          || (parsed.hasUnknown === true && />>?/.test(commandForLease));
        // writeTargets boundary + resolved-path recheck. The kernel matched
        // instruction/.git regexes on the LEXICAL target; the filesystem
        // resolves the real one — `> link/config` where link -> .git carries
        // no '.git' in its string form, and `> ../out` escapes the worktree
        // without tripping any instruction regex. Device sinks are exempt.
        const wt = (parsed.writeTargets ?? []).filter((t) => !DEVICE_TARGET_RE.test(String(t).trim()));
        // Resolved-vs-lexical divergence filter: when realTarget == the
        // lexical abs path, the kernel's decideToolCall already adjudicated
        // that exact target (its instr/git regexes ran on the same string).
        // Only DIVERGING resolutions are fresh evidence — re-checking a
        // same-path target here would double-ask every approved .git write.
        const diverging = wt.filter((t) => String(realTarget(t)).toLowerCase() !== String(absFor(t)).toLowerCase());
        const realGit = diverging.map(realTarget).find((t) => GIT_INTERNAL_RE.test(String(t).replace(/\\/g, '/')));
        const realInstr = diverging.map(realTarget).find((t) => INSTRUCTION_PATH_RES.some((re) => re.test(String(t).replace(/\\/g, '/'))));
        const outTarget = wt.find((t) => outsideWriteTarget(t));
        // Resolved-path hits on protected files are their own ask — the
        // write_outside latch must not swallow them (different rule, no latch).
        const protectedHit = realGit ?? realInstr;
        if (protectedHit) {
          const rule = realGit ? 'git_internal' : 'instruction_file';
          const answer = asks?.ask
            ? await asks.ask({
                toolName,
                toolCallId: ctx.toolCall?.id ?? null,
                rule,
                summary: `shell write target resolves into ${realGit ? '.git internals' : 'an agent instruction file'}: ${String(protectedHit).slice(0, 300)}`,
                detail: `命令写目标的真实路径命中 ${realGit ? '.git 内部（hooks/config/refs 是持久化执行面）' : 'agent 指令文件（standing orders）'}——lexical 路径未命中，是符号链接/别名逃逸。`,
                args: { command: commandForLease.slice(0, 300), target: String(protectedHit).slice(0, 300) },
                argsTruncated: false,
                argsTotalChars: null,
              }, signal)
            : 'deny';
          core.audit.write({ kind: 'WRITE_OUTSIDE_RESOLVED', toolName, data: { target: String(protectedHit).slice(0, 300), rule, answer } });
          if (answer !== 'allow' && answer !== 'allow_session' && answer !== 'always') {
            return { block: true, rule, reason: `operator refused this write target — '${protectedHit}' blocked` };
          }
        }
        if (outTarget && writeOutside !== 'allowed') {
          if (writeOutside === 'blocked') {
            return { block: true, rule: 'write_outside', reason: `writes outside the workspace are blocked this session (operator choice) — '${outTarget}' is outside ${workdir}` };
          }
          const answer = asks?.ask
            ? await asks.ask({
                toolName,
                toolCallId: ctx.toolCall?.id ?? null,
                rule: 'write_outside',
                summary: `shell write target outside workspace: ${String(outTarget).slice(0, 300)}`,
                detail: `命令的重定向/写目标落在工作目录之外（含符号链接逃逸）。允许一次=仅本次；本会话允许=此后越界写不再询问；拒绝=本会话所有越界写直接拦下。`,
                args: { command: commandForLease.slice(0, 300), target: String(outTarget).slice(0, 300) },
                argsTruncated: false,
                argsTotalChars: null,
              }, signal)
            : 'deny';
          core.audit.write({ kind: 'WRITE_OUTSIDE_RESOLVED', toolName, data: { target: String(outTarget).slice(0, 300), rule: 'write_outside', answer } });
          if (answer === 'deny') {
            writeOutside = 'blocked';
            return { block: true, rule: 'write_outside', reason: `operator refused this write target — '${outTarget}' blocked` };
          }
          if (answer === 'allow_session' || answer === 'always') writeOutside = 'allowed';
        }
      } catch (err) {
        // an aborted ask must propagate — swallowing it would let an
        // interrupted call proceed to lease acquisition and execute.
        if (signal?.aborted || err?.name === 'AbortError') throw err;
        mutating = true;
      }
    }
    const fgHolder = `fg:${ctx.toolCall?.id ?? 'unknown'}`;
    let fgHeld = false;
    // job_spawn never takes the foreground lease even when its command is
    // mutating — the durable job serializes via its own `job:` lease inside
    // spawnCommandJob; an fg hold here deadlocks every mutating spawn against
    // its own caller. The mutating flag above still drives the write-target /
    // protected-path rechecks for the command text.
    if (mutating && toolName !== 'job_spawn' && writeLease) {
      const acq = writeLease.acquire(fgHolder, { tool: toolName });
      if (!acq.ok) {
        core.audit.write({
          kind: 'WORKSPACE_LEASE_DENIED', toolName,
          data: { heldBy: acq.heldBy.holder, fg: fgHolder, reason: 'foreground mutation refused while the workspace write lease is held' },
        });
        return {
          block: true,
          rule: 'workspace_lease',
          reason: `workspace is write-locked by '${acq.heldBy.holder}' — wait for it to finish (job_status), or release via the operator`,
          repair: 'poll job_status and retry after the holder exits',
        };
      }
      fgHeld = true;
    }
    // file mutations route through FileOpsGuard — write/edit get a
    // pre-execution byte backup, delete is performed as a recoverable recycle
    // instead of letting the call destroy bytes.
    const filePath = ctx.args?.path ?? ctx.args?.file ?? ctx.args?.target;
    if (typeof filePath === 'string' && FILE_MUTATION_TOOLS.has(toolName)) {
      if (toolName === 'delete') {
        try {
          const { recycled, receiptId } = await fileOps.delete(filePath, { toolCallId: ctx.toolCall?.id ?? null });
          core.audit.write({ kind: 'FILEOP_RECYCLE', toolName, data: { receiptId, pathHash: hashOf(filePath) } });
          // the mutation already happened synchronously under the lease —
          // release now; there is no real tool execution to cover.
          if (fgHeld) writeLease.release(fgHolder);
          return {
            block: true,
            reason: `moved to recycle instead of destroying: ${recycled} (receipt ${receiptId} — recoverable via fileops restore)`,
          };
        } catch {
          if (fgHeld) { writeLease.release(fgHolder); fgHeld = false; }
          // target already gone — let the tool report it
        }
      } else {
        // A failed backup means the mutation would be UNRECOVERABLE — fail
        // closed. And release the lease FIRST: an uncaught throw here used to
        // strand the fg hold until TTL (180s), wedging every foreground
        // mutation behind one transient backup hiccup (locked file, EBUSY).
        let bk;
        try {
          bk = await fileOps.backup(filePath, { toolCallId: ctx.toolCall?.id ?? null });
        } catch (err) {
          if (fgHeld) { writeLease.release(fgHolder); fgHeld = false; }
          core.audit.write({ kind: 'FILEOP_BACKUP_FAILED', toolName, data: { pathHash: hashOf(filePath), error: String(err?.message ?? err).slice(0, 200) } });
          return {
            block: true,
            rule: 'fileops_backup',
            reason: `pre-write backup failed (${String(err?.message ?? err).slice(0, 200)}) — refusing to mutate without a recoverable snapshot`,
          };
        }
        const { backup, receiptId } = bk;
        if (backup) {
          core.audit.write({ kind: 'FILEOP_BACKUP', toolName, data: { receiptId, pathHash: hashOf(filePath) } });
        } else if (receiptId) {
          core.audit.write({ kind: 'FILEOP_CREATE_TOMBSTONE', toolName, data: { receiptId, pathHash: hashOf(filePath) } });
        }
      }
    }
    turnCalls += 1; // admitted — counts against the per-turn budget
    return undefined;
  };
  // G9: LLM second opinion. shadow mode = post-hoc telemetry only. guard
  // mode (PAI_SHADOW_JUDGE_MODE=guard) = the judge reviews admitted calls
  // before execution — one-way ratchet (escalate-only): 'deny'/'ask' block
  // or route to the operator, 'allow' lets the admit stand. A deterministic
  // deny returns without ever consulting the judge — downgrading a deny is
  // structurally impossible on this path.
  const decideFn = !shadowJudge ? inner : async (ctx, signal) => {
    const toolName = ctx.toolCall?.name ?? ctx.toolName;
    const outcome = await inner(ctx, signal);
    try {
      if (!outcome?.block && shadowJudge.mode === 'guard') {
        const g = await shadowJudge.guard(toolName, ctx.args,
          { asks, signal, toolCallId: ctx.toolCall?.id });
        if (g) return g;
      } else {
        shadowJudge.observe({ toolName, args: ctx.args, outcome });
      }
    } catch { /* a telemetry/guard path must never break the decide chain */ }
    return outcome;
  };
  // A new user message (prompt/steer) starts a fresh turn budget and clears
  // the mistake-limit stop — the operator's 'stop' scoped to that run, not
  // the session.
  decideFn.resetTurn = () => {
    turnCalls = 0;
    if (loopwatch) { loopwatch.stopped = false; loopwatch.errorStreak = 0; }
  };
  return decideFn;
}
