/**
 * P3 LLM Judge — SHADOW/SECONDARY advisor only (web-review ruling):
 * the static governance kernel stays the ONLY authority. The judge may
 * attach a second opinion to an operator ASK card and every opinion is
 * audited so the advisory-vs-human correlation can be evaluated later.
 * It can never allow a call — there is no path from an opinion to a
 * verdict. Unconfigured/error → the card is simply shown without advice
 * (fail-open to the human, never fail-open to the model).
 *
 * The `call` seam is injected so host stays dependency-free; pi wires a
 * real provider POST behind an explicit PAI_JUDGE opt-in.
 */

const JUDGE_TIMEOUT_MS = 8000;
const MAX_ARG_CHARS = 4000;

export class JudgeAdvisor {
  /**
   * @param {object} deps
   * @param {object|null} [deps.audit] audit sink — JUDGE_OPINION events
   * @param {(system:string, user:string) => Promise<string|null>} [deps.call]
   *        provider text completion; absent → advisor disabled
   * @param {number} [deps.timeoutMs]
   */
  constructor({ audit = null, call = null, timeoutMs = JUDGE_TIMEOUT_MS } = {}) {
    this.audit = audit;
    this.call = call;
    this.timeoutMs = timeoutMs;
  }

  get enabled() { return typeof this.call === 'function'; }

  /**
   * @param {object} pending the same bounded shape the operator card gets —
   *   {toolName, toolCallId, rule, summary, detail, risk, args(sanitized)}
   * @returns {Promise<{risk:string, suggest:'allow'|'deny', why:string}|null>}
   */
  async assess(pending) {
    if (!this.enabled) return null;
    const t0 = Date.now();
    let raw = null;
    try {
      raw = await Promise.race([
        this.call(SYSTEM, userOf(pending)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('judge timeout')), this.timeoutMs)),
      ]);
    } catch (e) {
      this.#audit(pending, null, String(e?.message ?? e), Date.now() - t0);
      return null;
    }
    const opinion = parseOpinion(raw);
    this.#audit(pending, opinion ?? { raw: String(raw ?? '').slice(0, 500) }, null, Date.now() - t0);
    return opinion;
  }

  #audit(pending, opinion, error, ms) {
    try {
      this.audit?.write({
        kind: 'JUDGE_OPINION', toolName: pending?.toolName ?? null,
        data: {
          toolCallId: pending?.toolCallId ?? null,
          opinion, error, ms,
        },
      });
    } catch { /* advisory telemetry must never break governance */ }
  }
}

const SYSTEM = [
  'You are a SECOND-OPINION reviewer for a tool-call approval card.',
  'A static policy engine already decided this call needs a human. Your job',
  'is to give that human a compact second read — you cannot approve or deny.',
  'Answer with EXACTLY three lines:',
  'RISK: low|medium|high',
  'SUGGEST: allow|deny',
  'WHY: <one sentence, concrete, about THIS call>',
].join('\n');

function userOf(p) {
  const parts = [
    `tool: ${p?.toolName ?? '?'}`,
    `policy_rule: ${p?.rule ?? '?'}`,
  ];
  if (p?.risk?.class) parts.push(`static_risk: ${p.risk.class} [${(p.risk.units ?? []).join(', ')}]`);
  if (p?.detail) parts.push(`why_asked: ${String(p.detail).slice(0, 300)}`);
  if (p?.summary) parts.push(`summary: ${String(p.summary).slice(0, 300)}`);
  if (p?.args) {
    let a; try { a = JSON.stringify(p.args); } catch { a = null; }
    if (a) parts.push(`args: ${a.slice(0, MAX_ARG_CHARS)}`);
  }
  return parts.join('\n');
}

function parseOpinion(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const risk = /RISK:\s*(low|medium|high)/i.exec(raw)?.[1]?.toLowerCase();
  const suggest = /SUGGEST:\s*(allow|deny)/i.exec(raw)?.[1]?.toLowerCase();
  const why = /WHY:\s*(.+)/i.exec(raw)?.[1]?.trim().slice(0, 200);
  if (!risk || !suggest) return null;
  return { risk, suggest, why: why ?? '' };
}
