/**
 * Loop detector — harness-neutral stuck-loop telemetry on admitted tool calls.
 *
 * Layered verdicts (OpenClaw's warn→intervene→terminate shape, Roo/Cline's
 * small repeat thresholds):
 *  - identical-signature run ≥ warnAt      → 'warn'    (audit-visible; admitted)
 *  - identical-signature run ≥ blockAt     → 'block'   (refusal text is the
 *    steering channel — the model sees it as the tool result)
 *  - same signature blocked ≥ escalateAfter → 'escalate' (caller should put the
 *    question to the operator; absent a responder the caller must still
 *    resolve it to a refusal — nothing here answers on the operator's behalf)
 *  - strict A/B alternation ≥ pingpongWarn / pingpongBlock tail entries →
 *    'warn' / 'block'
 *
 * Counters are session-scoped: construct one detector per session. Only calls
 * that reached admission are observed — policy-denied retries are refused by
 * the kernel itself and never enter this window.
 */
import { hashOf } from './audit.js';

/** Canonical args digest — key order must not change the signature. */
const stableJson = (v) => JSON.stringify(v, (_k, x) => (
  x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : x
));

export class LoopDetector {
  /**
   * @param {object} [opts]
   * @param {number} [opts.windowSize=24]      sliding window of recent calls
   * @param {number} [opts.warnAt=3]           consecutive identical calls → warn
   * @param {number} [opts.blockAt=5]          consecutive identical calls → block
   * @param {number} [opts.pingpongWarn=6]     alternating tail length → warn (3 cycles)
   * @param {number} [opts.pingpongBlock=8]    alternating tail length → block (4 cycles)
   * @param {number} [opts.escalateAfter=2]    a signature blocked this many
   *        times is retried anyway → 'escalate' instead of another silent block
   * @param {string[]} [opts.ignoreTools]      designated polling surfaces
   *        (job_status) are exempt — repeated polling is their contract
   */
  constructor({ windowSize = 24, warnAt = 3, blockAt = 5, pingpongWarn = 6, pingpongBlock = 8, escalateAfter = 2, ignoreTools = ['job_status'] } = {}) {
    this.windowSize = windowSize;
    this.warnAt = warnAt;
    this.blockAt = blockAt;
    this.pingpongWarn = pingpongWarn;
    this.pingpongBlock = pingpongBlock;
    this.escalateAfter = escalateAfter;
    this.ignoreTools = new Set(ignoreTools);
    this.reset();
  }

  reset() {
    this.window = [];
    this.blocked = new Map(); // signature → times a block was issued
  }

  signature(toolName, args) {
    return `${toolName}:${hashOf(stableJson(args ?? {}))}`;
  }

  /**
   * Operator allowed a previously blocked signature — clear its block record.
   * Subsequent identical calls are scored fresh (they will re-block at blockAt
   * and re-escalate if the pattern really is stuck).
   */
  forgive(signature) {
    this.blocked.delete(signature);
  }

  /**
   * Record one admitted call and classify the tail of the window.
   * @returns {{level:'ok'|'warn'|'block'|'escalate', kind?:string,
   *            signature?:string, count?:number, blocked?:number, reason?:string}}
   */
  observe(toolName, args = {}) {
    if (this.ignoreTools.has(toolName)) return { level: 'ok' };
    const signature = this.signature(toolName, args);
    this.window.push(signature);
    if (this.window.length > this.windowSize) this.window.shift();

    const run = this.#tailRun(signature);
    const blocked = this.blocked.get(signature) ?? 0;

    // Persistently retried after refusals → the operator must adjudicate
    if (blocked >= this.escalateAfter) {
      return {
        level: 'escalate', kind: 'repeat', signature, count: run, blocked,
        reason: `tool '${toolName}' repeated ${run}× in a row after ${blocked} refusals — agent appears stuck`,
      };
    }
    if (run >= this.blockAt) {
      this.blocked.set(signature, blocked + 1);
      return {
        level: 'block', kind: 'repeat', signature, count: run, blocked: blocked + 1,
        reason: `loop detector: '${toolName}' invoked identically ${run} times consecutively — refused; change the approach or ask the operator instead of retrying the same call`,
      };
    }
    const alternation = this.#alternation();
    if (alternation >= this.pingpongBlock) {
      this.blocked.set(signature, blocked + 1);
      return {
        level: 'block', kind: 'pingpong', signature, count: alternation, blocked: blocked + 1,
        reason: `loop detector: ping-pong between two tool calls (${alternation} alternating calls) — refused; the pair is not making progress, pick a different approach`,
      };
    }
    if (run >= this.warnAt) {
      return { level: 'warn', kind: 'repeat', signature, count: run };
    }
    if (alternation >= this.pingpongWarn) {
      return { level: 'warn', kind: 'pingpong', signature, count: alternation };
    }
    return { level: 'ok' };
  }

  /** Consecutive run length of `signature` at the window tail. */
  #tailRun(signature) {
    let n = 0;
    for (let i = this.window.length - 1; i >= 0; i--) {
      if (this.window[i] !== signature) break;
      n++;
    }
    return n;
  }

  /**
   * Length of the strict A-B-A-B… alternation at the window tail. The scan
   * verifies links for i ≥ 2; when any alternation exists (n > 1) the two
   * anchor elements also participate, so the span is n + 1.
   */
  #alternation() {
    const w = this.window;
    let n = 1;
    for (let i = w.length - 1; i >= 2; i--) {
      if (w[i] === w[i - 2] && w[i] !== w[i - 1]) n++;
      else break;
    }
    return n === 1 ? 1 : n + 1;
  }
}
