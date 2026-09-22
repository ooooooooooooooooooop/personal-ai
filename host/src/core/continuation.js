import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { evaluateEvidence, renderGap } from './evidence.js';

/**
 * Governed continuation queue — evidence-gated loop control.
 *
 * When a turn ends, the host evaluates the task's evidence contract. Three
 * terminal/intermediate outcomes:
 *   complete — evidence sufficient
 *   continue — gaps exist and budget remains: persist the structured gap and
 *              hand the caller a steer text to inject (the loop keeps running
 *              under governance, not the model's own optimism)
 *   blocked  — budget exhausted or same gap repeating with no progress:
 *              terminal state, audited, no further automatic turns
 *
 * Loop-breaker: identical gap sets repeating `noProgressLimit` times → blocked.
 * The ledger (<instance>/continuation.jsonl) is durable so a restart sees the
 * same budget position — continuation state is canonical-adjacent, not volatile.
 *
 * Budget scope is the TASK, not the instance lifetime: both counters walk back
 * from the ledger tail and stop at the first terminal row (complete/blocked),
 * so a finished task frees the budget while a mid-task restart keeps it (the
 * anti-bypass property durability exists for). Counting ALL historical
 * 'continue' rows instead would permanently brick evidence-gated tasks after
 * the first few — the governor would become a lifetime blocker.
 */

export class ContinuationGovernor {
  /**
   * @param {object} deps
   * @param {string} deps.ledgerPath        <instance>/continuation.jsonl
   * @param {object} deps.audit
   * @param {object[]} deps.requirements    EvidenceRequirement[]
   * @param {number} [deps.maxContinuations=8]
   * @param {number} [deps.noProgressLimit=3]
   */
  constructor({ ledgerPath, audit, requirements = [], maxContinuations = 8, noProgressLimit = 3 }) {
    this.ledgerPath = ledgerPath;
    this.audit = audit;
    this.requirements = requirements;
    this.maxContinuations = maxContinuations;
    this.noProgressLimit = noProgressLimit;
    mkdirSync(dirname(ledgerPath), { recursive: true });
    this.history = existsSync(ledgerPath)
      ? readFileSync(ledgerPath, 'utf-8').split('\n').filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } }) // torn tail row (crash mid-append) must not brick bootstrap
          .filter(Boolean)
      : [];
  }

  /** Continuations spent on the CURRENT task — trailing 'continue' rows. */
  #continuations() {
    let n = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].action !== 'continue') break; // terminal row = task boundary
      n++;
    }
    return n;
  }

  #repeatCount(gaps) {
    const key = JSON.stringify([...gaps].sort());
    let n = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const h = this.history[i];
      if (h.action !== 'continue') break;
      if (JSON.stringify([...h.gaps].sort()) !== key) break;
      n++;
    }
    return n;
  }

  /**
   * Evaluate a finished turn. Returns the governed decision; the caller
   * (adapter) performs the steer injection for 'continue'.
   * @param {import('./evidence.js').TurnRecord} turn
   */
  evaluate(turn) {
    const { sufficient, gaps } = evaluateEvidence(this.requirements, turn);

    if (sufficient) {
      this.#record({ action: 'complete', gaps: [] });
      this.audit.write({ kind: 'CONTINUATION_COMPLETE', data: { turns: this.#continuations() } });
      return { action: 'complete' };
    }

    if (this.#continuations() >= this.maxContinuations) {
      this.#record({ action: 'blocked', gaps, reason: 'max_continuations' });
      this.audit.write({ kind: 'CONTINUATION_BLOCKED', data: { reason: 'max_continuations', gaps } });
      return { action: 'blocked', reason: 'max_continuations', gaps };
    }

    const repeats = this.#repeatCount(gaps);
    if (repeats + 1 >= this.noProgressLimit) {
      this.#record({ action: 'blocked', gaps, reason: 'no_progress', repeats });
      this.audit.write({ kind: 'CONTINUATION_BLOCKED', data: { reason: 'no_progress', gaps, repeats } });
      return { action: 'blocked', reason: 'no_progress', gaps };
    }

    const steerText = renderGap(this.requirements, gaps);
    this.#record({ action: 'continue', gaps });
    this.audit.write({ kind: 'CONTINUATION_STEER', data: { gaps, count: this.#continuations() } });
    return { action: 'continue', gaps, steerText };
  }

  #record(entry) {
    this.history.push({ ...entry, at: Date.now() });
    appendFileSync(this.ledgerPath, `${JSON.stringify({ ...entry, at: Date.now() })}\n`);
  }

  /** Goal-contract posture for the UI surface (Qwen goals-panel analogue). */
  status() {
    const last = this.history[this.history.length - 1] ?? null;
    return {
      requirements: this.requirements.map((r) => ({ id: r.id, kind: r.kind, tool: r.tool ?? null })),
      continuations: this.#continuations(),
      maxContinuations: this.maxContinuations,
      lastAction: last?.action ?? null,
      lastGaps: last?.gaps ?? [],
    };
  }
}
