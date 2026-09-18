/**
 * Bounded autonomy — cumulative spend gate (harness-neutral, zero-dep).
 *
 * Why this exists: governance must be body-portable. A session that can issue
 * unbounded provider calls has an unbounded blast radius no per-call lattice
 * can see. The gate closes three properties the reviewer required:
 *
 *  - consumed is a MONOTONIC ledger, not a recomputation from the live
 *    session head — session rewind must never un-spend tokens
 *  - admission happens BEFORE the expensive call; every usage-bearing event
 *    (turn / auto-retry / compaction / delegated job) is billed onto the
 *    same append-only ledger
 *  - unknown/misconfigured gate = fail-closed deny; the agent cannot extend
 *    its own budget (limits come from the attested policy or operator env)
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const BUDGET_SOURCES = ['turn', 'retry', 'compaction', 'subagent', 'job'];

export class BudgetGovernor {
  /**
   * @param {string} ledgerPath  append-only JSONL, e.g. <instance>/budget-ledger.jsonl
   * @param {object|null} limits {maxTokensPerSession?, maxCostPerSessionUsd?, maxCallsPerSession?}
   *        — from policy.doc.budget; absent/empty = observe-only (still records)
   * @param {object} [audit]     AuditWriter — BUDGET_DENIED / BUDGET_EXCEEDED rows
   */
  constructor({ ledgerPath, limits = null, audit = null }) {
    this.ledgerPath = ledgerPath;
    this.limits = limits && typeof limits === 'object' ? limits : null;
    this.audit = audit;
    this.broken = false;
    try {
      mkdirSync(dirname(ledgerPath), { recursive: true });
      appendFileSync(ledgerPath, JSON.stringify({ at: Date.now(), kind: 'ledger_open' }) + '\n');
    } catch {
      this.broken = true; // limits configured + unwritable ledger → admit denies (fail-closed)
    }
  }

  get configured() {
    const l = this.limits ?? {};
    return Boolean(l.maxTokensPerSession || l.maxCostPerSessionUsd || l.maxCallsPerSession);
  }

  /**
   * Append one usage record. Throws when the ledger is unwritable.
   * `countCall` — a provider request is counted at the admission gate (one
   * HTTP request = one call); usage-billing events pass countCall:false so a
   * turn's retries/compaction don't double-count.
   */
  record({ scope, runId = null, source = 'turn', usage = {}, countCall = true }) {
    const row = {
      at: Date.now(), scope, runId, source,
      tokens: Number(usage.input ?? 0) + Number(usage.output ?? 0)
        + Number(usage.cacheRead ?? 0) + Number(usage.cacheWrite ?? 0)
        + Number(usage.total && !usage.input && !usage.output ? usage.total : 0),
      cost: Number(usage.cost?.total ?? usage.cost ?? 0),
      // usage.calls overrides (delegation commits charge the child's whole
      // call slice; refunds charge negative); default = one call per record
      calls: usage.calls != null ? Number(usage.calls) : (countCall ? 1 : 0),
    };
    appendFileSync(this.ledgerPath, JSON.stringify(row) + '\n');
    return this.consumed(scope);
  }

  /** Monotonic cumulative spend for a scope (session id or run id). */
  consumed(scope) {
    if (!existsSync(this.ledgerPath)) return { tokens: 0, cost: 0, calls: 0 };
    const out = { tokens: 0, cost: 0, calls: 0 };
    for (const line of readFileSync(this.ledgerPath, 'utf-8').split('\n')) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.scope !== scope || r.kind) continue;
      out.tokens += r.tokens ?? 0;
      out.cost += r.cost ?? 0;
      out.calls += r.calls ?? 0;
    }
    return out;
  }

  /** First breached limit for a scope, or null. */
  breach(scope, consumed = null) {
    const l = this.limits ?? {};
    const c = consumed ?? this.consumed(scope);
    if (l.maxTokensPerSession && c.tokens >= l.maxTokensPerSession)
      return { rule: 'max_tokens', consumed: c.tokens, limit: l.maxTokensPerSession };
    if (l.maxCostPerSessionUsd && c.cost >= l.maxCostPerSessionUsd)
      return { rule: 'max_cost', consumed: c.cost, limit: l.maxCostPerSessionUsd };
    if (l.maxCallsPerSession && c.calls >= l.maxCallsPerSession)
      return { rule: 'max_calls', consumed: c.calls, limit: l.maxCallsPerSession };
    return null;
  }

  /**
   * Admission BEFORE an expensive call. Fail-closed: configured limits with a
   * broken ledger deny rather than open an un-metered run.
   */
  admit(scope) {
    if (this.broken && this.configured) {
      const reason = 'budget ledger unwritable — configured limits cannot be enforced (fail-closed)';
      this.audit?.write({ kind: 'BUDGET_DENIED', data: { scope, reason, rule: 'ledger_broken' } });
      return { ok: false, reason, rule: 'ledger_broken' };
    }
    const consumed = this.consumed(scope);
    const breach = this.breach(scope, consumed);
    if (breach) {
      const reason = `budget exceeded: ${breach.rule} ${breach.consumed} >= ${breach.limit}`;
      this.audit?.write({ kind: 'BUDGET_DENIED', data: { scope, reason, rule: breach.rule, consumed } });
      return { ok: false, reason, rule: breach.rule, consumed };
    }
    return { ok: true, consumed };
  }

  status(scope) {
    return {
      configured: this.configured,
      limits: this.limits,
      consumed: this.consumed(scope),
      breach: this.breach(scope),
      ledgerBroken: this.broken,
    };
  }

  /**
   * Atomic commit: charge `usage` to scope NOW (before the work exists).
   * Used by delegation so the child's budget slice is owned, not merely
   * copied — without this, concurrent delegates (or the parent itself)
   * could each spend the same remaining headroom (double-spend).
   *
   * Race discipline: append then re-check. The record() is synchronous so
   * same-process callers serialize; a cross-process interleave is caught by
   * the post-commit breach check, which appends an algebraic refund row —
   * fail-safe direction is over-accounting, never under.
   *
   * The charge is never refunded automatically on child completion
   * (committed model): the slice is spent whether the child used it or not.
   * Refund exists only for the caller to undo a charge when the child never
   * spawned (admission rolled back).
   */
  tryCommit(scope, usage, source = 'delegate_commit') {
    this.record({ scope, source, usage, countCall: false });
    // post-commit overshoot check uses STRICTLY-greater: consuming exactly
    // to the limit is legal (the child may spend its whole slice), unlike
    // admit() where reaching the limit means no headroom remains.
    const c = this.consumed(scope);
    const l = this.limits ?? {};
    const over =
      (l.maxTokensPerSession && c.tokens > l.maxTokensPerSession && { rule: 'max_tokens', consumed: c.tokens, limit: l.maxTokensPerSession })
      || (l.maxCostPerSessionUsd && c.cost > l.maxCostPerSessionUsd && { rule: 'max_cost', consumed: c.cost, limit: l.maxCostPerSessionUsd })
      || (l.maxCallsPerSession && c.calls > l.maxCallsPerSession && { rule: 'max_calls', consumed: c.calls, limit: l.maxCallsPerSession })
      || null;
    if (!over) return { ok: true };
    this.refund(scope, usage, `${source}:rollback`);
    const reason = `budget exceeded on commit: ${over.rule} ${over.consumed} > ${over.limit}`;
    this.audit?.write({ kind: 'BUDGET_DENIED', data: { scope, reason, rule: over.rule } });
    return { ok: false, reason, rule: over.rule };
  }

  /** Append an algebraic refund row canceling a previous charge. */
  refund(scope, usage, source = 'delegate_refund') {
    this.record({
      scope, source, countCall: false,
      usage: {
        total: -(usage.total ?? usage.tokens ?? 0),
        cost: -(usage.cost ?? 0),
        calls: -(usage.calls ?? 0),
      },
    });
  }

  /**
   * Remaining headroom per configured dimension, or null per dimension when
   * unconfigured. Used by delegation admission to issue a child budget that
   * cannot exceed what the parent scope has left (bounded subdivision).
   */
  remaining(scope) {
    const c = this.consumed(scope);
    const l = this.limits ?? {};
    const rem = (cap, used) => (cap ? Math.max(0, cap - used) : null);
    return {
      tokens: rem(l.maxTokensPerSession, c.tokens),
      costUsd: rem(l.maxCostPerSessionUsd, c.cost),
      calls: rem(l.maxCallsPerSession, c.calls),
    };
  }
}
