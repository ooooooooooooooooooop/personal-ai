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
 */
export function loopGovernanceExtension({ continuation = null, contextEnvelope = null, predictions = null, audit }) {
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

      pi.on('agent_start', () => {
        if (pendingSteer) {
          pendingSteer = false; // continuation run — same task, keep transcript
        } else {
          transcript = freshTranscript();
        }
      });

      pi.on('turn_end', (event) => {
        for (const r of event.toolResults ?? []) {
          transcript.toolCalls.push({ name: r.toolName, isError: Boolean(r.isError) });
        }
        const text = extractText(event.message);
        if (text) transcript.assistantText += (transcript.assistantText ? '\n' : '') + text;
      });

      pi.on('agent_end', (_event, ctx) => {
        if (!continuation) return;
        const decision = continuation.evaluate(transcript);
        if (decision.action === 'continue' && decision.steerText) {
          pendingSteer = true;
          ctx.sendUserMessage(decision.steerText);
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
