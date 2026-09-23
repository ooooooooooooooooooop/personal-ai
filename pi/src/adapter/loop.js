/**
 * Loop governance extension — host-owned inline extension for M3.
 *
 * Wires the harness-neutral ContinuationGovernor + world-model lifecycle into
 * Pi's real event seams:
 *  - turn_end      → assemble TurnRecord (tool calls + assistant text)
 *  - agent_end     → governor.evaluate(): 'continue' injects the structured
 *                    gap as a user message (sendUserMessage always triggers a
 *                    new turn — governed continuation, not model optimism);
 *                    'blocked'/'complete' are terminal + audited
 *  - session_before_compact / session_compact(_failed) → audit + world-model
 *                    survival assertion: open predictions ride the
 *                    ContextEnvelope which is re-injected EVERY turn via the
 *                    context seam — compaction can erase the transcript but
 *                    not the canonical projection (verified shape note: Pi's
 *                    auto-compaction calls _runDefaultCompaction with
 *                    customInstructions=undefined; SessionBeforeCompactResult
 *                    only offers {cancel, compaction} — so canonical
 *                    re-injection is the correct preservation mechanism,
 *                    not instruction mutation)
 *  - model_select  → audit (model switches are governance-visible events)
 *  - turn_end      → subdirectory hints (U15): the first time a path-arg tool
 *                    touches a directory inside workdir, record a bounded
 *                    dir-listing observation — Goose SubdirectoryHintTracker
 *                    analogue riding the canonical observation channel
 *                    (persistent, cache-friendly, never a tool-result rewrite)
 */
import { readdirSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { validateJsonSchema, parseJsonReply } from '../../../host/src/core/jsonschema.js';

const PATH_TOOLS = new Set(['read', 'ls', 'edit', 'write', 'delete', 'grep', 'glob']);
const HINT_CAP = 30;

/**
 * M100 fallback gate — error-class discrimination. Walking the chain is only
 * rational when the NEXT provider might succeed where this one failed:
 * rate limits (429), 5xx/overload, network resets, auth failures (the next
 * entry carries its OWN credentials), and context overflow (the operator-
 * ordered chain may hold a bigger-window model — chain order is the
 * operator's capacity preference, so we honor it).
 *
 * A REQUEST-INVARIANT error is different: the provider parsed our envelope
 * and rejected its SHAPE (400 invalid_request, 422, validation/schema
 * errors). That envelope is ours — the next provider fails on it identically,
 * so falling back just burns a hop, silently switches the session model, and
 * confuses the operator. Skipped with an audit row; the chain stays armed
 * for real faults.
 */
export function isRequestInvariantError(message) {
  const m = String(message ?? '');
  return /\binvalid[_ -]?request/i.test(m)
    || /\bmalformed\b/i.test(m)
    || /\bstatus(?:\s*code)?\s*4(?:00|22)\b/i.test(m)
    || /\b4(?:00|22)\s*[(:–-]?\s*(bad request|unprocessable)/i.test(m)
    || /\b(?:payload|request|body)\b[^.]{0,80}\b(?:fails?|failed)?\s*validation\b/i.test(m)
    || /\bvalidation (?:error|failed)\b/i.test(m);
}

export function loopGovernanceExtension({ continuation = null, contextEnvelope = null, predictions = null, observations = null, audit, workdir = null, fallbacks = null, structured = null }) {
  return {
    name: 'pai-loop-governance',
    factory: (pi) => {
      // Evidence is cumulative across the whole TASK — one user prompt plus
      // every governed continuation steer. Per-turn evaluation would forget
      // evidence produced in earlier turns and re-gap forever. `pendingSteer`
      // marks that the next agent run was triggered by our own continuation
      // injection (same task); any other agent_start opens a fresh transcript.
      const freshTranscript = () => ({ toolCalls: [], assistantText: '', fileChanges: [] });
      let transcript = freshTranscript();
      let pendingSteer = false;
      // M100 provider fallback: `pendingFallback` marks a run triggered by our
      // own fallback steer (same task); `fallbackHops` bounds how many chain
      // hops a single task may consume so a broken provider set can't loop.
      let pendingFallback = false;
      let fallbackHops = 0;
      // dedup-h #238 structured output: a schema-conformance retry is a run
      // of the SAME task — like a fallback steer it must not reset the
      // transcript or the hop budgets.
      let pendingSchemaRetry = false;
      // Stale-event defense (upstream residual): a duplicated/late agent_end
      // must not double-trigger continuation or fallback. Every legitimate
      // run passes agent_start first, which re-arms this flag.
      let agentEnded = false;
      // U15: directories already hinted this session — hint once, not per touch
      const hintedDirs = new Set();
      const wd = workdir ? resolve(workdir) : null;
      const argOf = (ctx, callId) => {
        for (const m of ctx?.messages ?? []) {
          for (const b of m.content ?? m.blocks ?? []) {
            if ((b?.type === 'toolCall' || b?.type === 'tool_use') && b?.id === callId) {
              return b.args ?? b.input ?? null;
            }
          }
        }
        return null;
      };
      const hintDir = (dirPath) => {
        if (!wd || hintedDirs.has(dirPath)) return;
        hintedDirs.add(dirPath);
        try {
          const rel = relative(wd, dirPath);
          if (rel.startsWith('..') || rel.includes(`..${sep}`) || resolve(dirPath) === wd) return;
          const entries = readdirSync(dirPath, { withFileTypes: true }).slice(0, HINT_CAP)
            .map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`);
          observations.record({
            kind: 'subdirectory_hint',
            subject: rel || '.',
            detail: { entries, truncated: entries.length === HINT_CAP },
            actor: 'pi',
          });
        } catch { /* unreadable dir — hint is best-effort */ }
      };

      pi.on('agent_start', () => {
        agentEnded = false; // fresh run — re-arm the end-of-run latch
        if (pendingSteer || pendingFallback || pendingSchemaRetry) {
          pendingSteer = false; // continuation run — same task, keep transcript
          pendingFallback = false;
          pendingSchemaRetry = false;
        } else {
          transcript = freshTranscript();
          fallbackHops = 0; // a genuinely new task gets a fresh fallback budget
        }
      });

      pi.on('turn_end', (event) => {
        for (const r of event.toolResults ?? []) {
          transcript.toolCalls.push({ name: r.toolName, isError: Boolean(r.isError) });
          // Canonical observation feed: every tool result the body observed is
          // world-model state — append-only, survives compaction, re-injected
          // into context on every turn via the live provider.
          observations?.record({
            kind: 'tool_result',
            subject: r.toolName ?? 'unknown',
            detail: { isError: Boolean(r.isError) },
            actor: 'pi',
          });
          // U15 subdirectory hint: first touch of a new dir inside workdir
          // records a bounded listing into the observation stream
          if (observations && PATH_TOOLS.has(r.toolName)) {
            const args = argOf(event.context, r.toolCallId);
            const p = args?.path ?? args?.file ?? args?.target ?? args?.dir;
            if (typeof p === 'string' && p) {
              const abs = resolve(wd ?? process.cwd(), p);
              hintDir(r.toolName === 'ls' ? abs : dirname(abs));
            }
          }
        }
        const text = extractText(event.message);
        if (text) transcript.assistantText += (transcript.assistantText ? '\n' : '') + text;
      });

      pi.on('agent_end', async (event, ctx) => {
        if (agentEnded) {
          audit.write({ kind: 'STALE_AGENT_END', data: { dropped: true } });
          return;
        }
        agentEnded = true;
        // dedup-h #238 structured output (--output-schema analogue): an
        // armed schema turns agent_end into a conformance gate — the last
        // assistant reply must parse as JSON and validate. Violations get a
        // bounded re-steer (the model's own answer stays in the transcript);
        // a conforming or exhausted verdict disarms and falls through to
        // continuation/fallback normally.
        if (structured?.schema) {
          const last = [...(event?.messages ?? [])].reverse().find((m) => m?.role === 'assistant');
          const reply = parseJsonReply(extractText(last));
          const errors = reply.ok ? validateJsonSchema(structured.schema, reply.value) : ['not a JSON reply'];
          if (!errors.length) {
            structured.schema = null;
            structured.retries = 0;
            audit.write({ kind: 'STRUCTURED_OUTPUT', data: { ok: true } });
          } else if ((structured.retries ?? 0) < (structured.maxRetries ?? 2)) {
            structured.retries = (structured.retries ?? 0) + 1;
            pendingSchemaRetry = true;
            audit.write({
              kind: 'STRUCTURED_OUTPUT',
              data: { ok: false, retry: structured.retries, errors: errors.slice(0, 5) },
            });
            ctx.sendUserMessage(
              `[structured-output] 上一条回复不符合约定 schema（${errors.slice(0, 3).join('；')}）。` +
              `请只回复一个符合 schema 的 JSON 对象——不要解释、不要围栏。`,
            );
            return; // schema retry owns the next run
          } else {
            const r = structured.retries ?? 0;
            structured.schema = null;
            structured.retries = 0;
            audit.write({
              kind: 'STRUCTURED_OUTPUT',
              data: { ok: false, exhausted: true, retries: r, errors: errors.slice(0, 5) },
            });
          }
        }
        if (continuation) {
          const decision = continuation.evaluate(transcript);
          if (decision.action === 'continue' && decision.steerText) {
            pendingSteer = true;
            ctx.sendUserMessage(decision.steerText);
            return; // governed continuation owns the next run — no fallback
          }
        }
        // M100 provider fallback chain: a run that ended on a terminal
        // provider error walks <instance>/model-fallbacks.json — session model
        // switches to the next entry the registry can resolve + authenticate,
        // then a steer re-triggers the task. Aborted runs never fall back;
        // a chain is consumed at most once per task (fallbackHops cap).
        const chain = fallbacks?.chain ?? [];
        if (!chain.length || !ctx?.modelRegistry?.find || typeof pi.setModel !== 'function') return;
        const last = [...(event?.messages ?? [])].reverse().find((m) => m?.role === 'assistant');
        if (last?.stopReason !== 'error') return;
        // request-invariant errors (our envelope's shape, not the provider's
        // health) fail identically at every chain entry — don't walk
        if (isRequestInvariantError(last.errorMessage)) {
          audit.write({
            kind: 'MODEL_FALLBACK_SKIPPED',
            data: {
              from: `${ctx.model?.provider}/${ctx.model?.id}`,
              reason: 'request-invariant error — the next provider rejects this envelope identically',
              error: String(last.errorMessage ?? '').slice(0, 300),
            },
          });
          return;
        }
        const cur = ctx.model;
        const idx = chain.findIndex((e) => e.provider === cur?.provider && e.model === cur?.id);
        for (let i = idx >= 0 ? idx + 1 : 0; i < chain.length && fallbackHops < chain.length; i += 1) {
          const e = chain[i];
          // dedup-h #282: operator models-allow.json bounds the automatic
          // failover surface — a chain entry outside the allowlist is
          // skipped with an audit row, never selected.
          if (fallbacks?.allowed && !fallbacks.allowed(e)) {
            audit.write({ kind: 'MODEL_FALLBACK', data: { skip: `${e.provider}/${e.model}`, reason: 'not-in-models-allow' } });
            continue;
          }
          const model = ctx.modelRegistry.find(e.provider, e.model);
          if (!model) {
            audit.write({ kind: 'MODEL_FALLBACK', data: { skip: `${e.provider}/${e.model}`, reason: 'unregistered' } });
            continue;
          }
          const ok = await pi.setModel(model).catch(() => false);
          if (!ok) {
            audit.write({ kind: 'MODEL_FALLBACK', data: { skip: `${e.provider}/${e.model}`, reason: 'no-auth' } });
            continue;
          }
          fallbackHops += 1;
          pendingFallback = true;
          audit.write({
            kind: 'MODEL_FALLBACK',
            data: {
              from: `${cur?.provider}/${cur?.id}`, to: `${e.provider}/${e.model}`,
              hop: fallbackHops, error: String(last.errorMessage ?? 'provider error').slice(0, 300),
            },
          });
          ctx.sendUserMessage(
            `[model-fallback] 上一模型请求失败（${cur?.provider}/${cur?.id}：${String(last.errorMessage ?? 'provider error').slice(0, 200)}）。` +
            `会话模型已切换到 ${e.provider}/${e.model} ——请继续完成刚才未完成的任务。`,
          );
          return;
        }
        if (last) {
          audit.write({ kind: 'MODEL_FALLBACK', data: { exhausted: true, from: `${cur?.provider}/${cur?.id}`, error: String(last.errorMessage ?? '').slice(0, 200) } });
        }
      });

      pi.on('session_before_compact', (event) => {
        const open = predictions ? predictions.openPredictions() : [];
        audit.write({
          kind: 'COMPACT_BEFORE',
          data: {
            reason: event.reason,
            willRetry: event.willRetry,
            branchEntries: event.branchEntries?.length ?? 0,
            openPredictions: open.length,
            observations: observations ? observations.list().length : 0,
            worldModelProjection: contextEnvelope ? 'context-seam re-injection' : 'absent',
          },
        });
        return undefined; // never cancel — preservation rides the context seam
      });

      pi.on('session_compact', (event) => {
        audit.write({
          kind: 'COMPACT_DONE',
          data: { reason: event.reason, willRetry: event.willRetry, fromExtension: event.fromExtension },
        });
      });

      pi.on('session_compact_failed', (event) => {
        audit.write({
          kind: 'COMPACT_FAILED',
          data: { reason: event.reason, aborted: event.aborted, errorMessage: event.errorMessage },
        });
      });

      pi.on('model_select', (event) => {
        audit.write({
          kind: 'MODEL_SELECT',
          data: {
            model: event.model?.id,
            previous: event.previousModel?.id ?? null,
            source: event.source,
          },
        });
      });
    },
  };
}

function extractText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
  }
  return '';
}
