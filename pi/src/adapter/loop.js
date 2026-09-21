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

const PATH_TOOLS = new Set(['read', 'ls', 'edit', 'write', 'delete', 'grep', 'glob']);
const HINT_CAP = 30;

export function loopGovernanceExtension({ continuation = null, contextEnvelope = null, predictions = null, observations = null, audit, workdir = null, fallbacks = null }) {
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
        if (pendingSteer || pendingFallback) {
          pendingSteer = false; // continuation run — same task, keep transcript
          pendingFallback = false;
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
        const cur = ctx.model;
        const idx = chain.findIndex((e) => e.provider === cur?.provider && e.model === cur?.id);
        for (let i = idx >= 0 ? idx + 1 : 0; i < chain.length && fallbackHops < chain.length; i += 1) {
          const e = chain[i];
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
