import { isLongRunningCommand } from '../adapter/jobs.js';
import { hashOf } from '../../../host/src/core/audit.js';
import { scanForSecrets } from '../adapter/secrets.js';

const FILE_MUTATION_TOOLS = new Set(['write', 'edit', 'delete']);
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
export function makeDecide({ core, executor, fileOps, getSurface, workdir, writeLease = null, classifier = null, getSessionScope = null, loopwatch = null, asks = null, shadowJudge = null, paiignore = null, maxTurnCalls = null }) {
  // Qwen MAX_TURNS analogue: hard cap on admitted tool calls per user turn.
  // The refusal reason is the steering channel — it tells the model to stop
  // and report, not to retry.
  const cap = maxTurnCalls ?? (Number(process.env.PAI_MAX_TOOL_CALLS) > 0 ? Number(process.env.PAI_MAX_TOOL_CALLS) : 100);
  let turnCalls = 0;
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
        if (answer === 'allow' || answer === 'allow_session') {
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
    if (toolName === 'write' || toolName === 'edit') {
      const contentToWrite = toolName === 'write'
        ? ctx.args?.content
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
        if (answer !== 'allow' && answer !== 'allow_session') {
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
    if (typeof command === 'string' && isLongRunningCommand(command)) {
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
    let mutating = FILE_MUTATION_TOOLS.has(toolName) || toolName?.startsWith('mcp__');
    if (!mutating && typeof commandForLease === 'string' && classifier) {
      try {
        const parsed = await classifier(commandForLease);
        // Deny provably-mutating commands plus unrecognized commands that carry
        // shell write syntax (redirects) — the residual hole the classifier
        // cannot see. Unknown commands without write syntax are read-capable,
        // matching the trust level the kernel already grants them.
        mutating = MUTATING_RISK.has(parsed.risk)
          || (parsed.hasUnknown === true && />>?/.test(commandForLease));
      } catch { mutating = true; }
    }
    const fgHolder = `fg:${ctx.toolCall?.id ?? 'unknown'}`;
    let fgHeld = false;
    if (mutating && writeLease) {
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
          const { recycled, receiptId } = await fileOps.delete(filePath);
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
        const { backup, receiptId } = await fileOps.backup(filePath);
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
  // A new user message (prompt/steer) starts a fresh turn budget.
  decideFn.resetTurn = () => { turnCalls = 0; };
  return decideFn;
}
