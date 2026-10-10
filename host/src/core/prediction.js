import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { redactSecrets, scrubSecretsDeep } from './secrets.js';

/**
 * Prediction store — world-model prediction lifecycle.
 *
 * Predictions are durable INSTANCE RUNTIME state (stored under the instance's
 * world-model dir, NOT the governed canonical dir — boundary adjudicated by
 * owner 2026-10-10): they survive compaction, handoff, and body
 * switches (they ride the PortableContinuityEnvelope's openPredictions field).
 * Every world-model mutation must bind to an open prediction — the bind record
 * is append-only so provenance is reconstructable after the fact.
 *
 * Layout inside the instance world-model dir:
 *   predictions/index.json    — {id: prediction record} (open + closed)
 *   predictions/bindings.jsonl— append-only mutation→prediction bindings
 *
 * Invariant: close() never deletes; state transitions are open→confirmed|refuted.
 */

const OPEN = 'open';
const TERMINAL = new Set(['confirmed', 'refuted']);

const REL_HORIZON = /^\+(\d+)\s*([smhdw])$/i;
const REL_UNIT_MS = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 };

/**
 * Parse a time horizon into an absolute deadline (ms epoch). Accepted forms:
 *   ISO-8601 date/datetime  ("2026-10-15", "2026-10-15T12:00:00Z")
 *   relative shorthand      ("+30m", "+12h", "+3d", "+2w")
 * Anything else returns null — an unparseable horizon stays recorded as text
 * but cannot produce a deadline, so nothing is silently mechanized.
 */
export function parseHorizonDeadline(horizon, baseMs = Date.now()) {
  if (horizon == null) return null;
  const raw = String(horizon).trim();
  if (!raw) return null;
  const rel = REL_HORIZON.exec(raw);
  if (rel) return baseMs + Number(rel[1]) * REL_UNIT_MS[rel[2].toLowerCase()];
  const ts = Date.parse(raw);
  // Date-only ISO strings parse to UTC midnight — a same-day deadline expiring
  // at 00:00 would mark predictions stale before the day ends. Treat a bare
  // date as "end of that day UTC", matching the common reading of a date
  // horizon ("by Oct 15" = through Oct 15).
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return ts + 86400e3 - 1;
  return Number.isNaN(ts) ? null : ts;
}

/** The effective deadline for a record — stored field first, lazy parse of
 *  legacy records (horizon text written before this field existed) second. */
function deadlineOf(p, baseMs) {
  if (p.horizon_deadline != null) return p.horizon_deadline;
  return p.horizon ? parseHorizonDeadline(p.horizon, baseMs ?? p.createdAt) : null;
}

export class PredictionStore {
  constructor(baseDir) {
    this.dir = join(baseDir, 'predictions');
    mkdirSync(this.dir, { recursive: true });
    this.indexPath = join(this.dir, 'index.json');
    this.bindingsPath = join(this.dir, 'bindings.jsonl');
    this.index = existsSync(this.indexPath)
      ? JSON.parse(readFileSync(this.indexPath, 'utf-8'))
      : {};
  }

  #persist() {
    // Atomic via tmp+rename (identity.js/handoff.js precedent): a crash mid-
    // write must not leave a truncated index — the constructor parses this
    // file and a corrupt index would brick every later bootstrap. The pid
    // suffix keeps two live writers from sharing one tmp name.
    const tmp = `${this.indexPath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.index, null, 2));
    renameSync(tmp, this.indexPath);
  }

  /** Open a prediction. Mutations against the world model bind to its id. */
  open({ claim, horizon = null, confidence = null, actor = 'host', tags = [] }) {
    if (!claim) throw new Error('prediction requires a claim');
    const id = `pred-${randomUUID().slice(0, 12)}`;
    this.index[id] = {
      // M5 parity (goals.js): the claim is durable AND re-injected into every
      // context envelope as openPredictions — scrub credential shapes first.
      id, claim: redactSecrets(String(claim)), status: OPEN, horizon, confidence, actor, tags,
      // 04[msg 7]「时间失效」: an observation that should have arrived by the
      // horizon and did not IS negative evidence. horizon_deadline makes that
      // checkable; stale_notified marks that the lapse has already been
      // emitted as evidence once (dedup across restarts).
      horizon_deadline: parseHorizonDeadline(horizon),
      stale_notified: false,
      createdAt: Date.now(), closedAt: null, outcome: null,
      bindingCount: 0,
    };
    this.#persist();
    return this.index[id];
  }

  /** Resolve a prediction; terminal states are immutable. */
  close(id, outcome, status = 'confirmed') {
    const p = this.index[id];
    if (!p) throw new Error(`unknown prediction ${id}`);
    if (TERMINAL.has(p.status)) return p;
    if (!TERMINAL.has(status)) throw new Error(`invalid terminal status ${status}`);
    p.status = status;
    p.outcome = scrubSecretsDeep(outcome) ?? null;
    p.closedAt = Date.now();
    this.#persist();
    return p;
  }

  /**
   * Bind a world-model mutation to a prediction. Append-only; returns the
   * binding record. Binding to a closed prediction is a governance error.
   */
  bindMutation(predictionId, mutationRef, actor = 'host') {
    const p = this.index[predictionId];
    if (!p) throw new Error(`cannot bind to unknown prediction ${predictionId}`);
    if (TERMINAL.has(p.status)) {
      const err = new Error(`cannot bind mutation to closed prediction ${predictionId}`);
      err.code = 'PREDICTION_CLOSED';
      throw err;
    }
    const record = {
      bindingId: `bind-${randomUUID().slice(0, 12)}`,
      predictionId, mutationRef, actor, at: Date.now(),
      mutationHash: createHash('sha256').update(JSON.stringify(mutationRef)).digest('hex'),
    };
    appendFileSync(this.bindingsPath, `${JSON.stringify(record)}\n`);
    p.bindingCount += 1;
    this.#persist();
    return record;
  }

  list(status = null) {
    const all = Object.values(this.index);
    return status ? all.filter((p) => p.status === status) : all;
  }

  openPredictions() {
    const now = Date.now();
    // The overdue flag rides the context-envelope projection — a prediction
    // past its horizon reaches the model as negative evidence every turn,
    // not only at the one moment the stale event was emitted.
    return this.list(OPEN).map((p) => {
      const dl = deadlineOf(p);
      return dl != null && dl <= now ? { ...p, overdue: true, horizon_deadline: dl } : p;
    });
  }

  /**
   * Open predictions whose horizon deadline has passed. "should have happened
   * by now and didn't" is negative evidence — this surfaces it; it does not
   * refute (that verdict still belongs to evaluate).
   */
  stale(now = Date.now()) {
    return this.list(OPEN).filter((p) => {
      const dl = deadlineOf(p);
      return dl != null && dl <= now;
    });
  }

  /** Mark predictions' lapse as already emitted — restart-safe dedup. */
  markStaleNotified(ids) {
    let changed = false;
    for (const id of ids) {
      const p = this.index[id];
      if (p && !p.stale_notified) { p.stale_notified = true; changed = true; }
    }
    if (changed) this.#persist();
  }

  /** Bindings for handoff audit — read-only stream of the append log. */
  bindings(predictionId = null) {
    if (!existsSync(this.bindingsPath)) return [];
    return readFileSync(this.bindingsPath, 'utf-8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }) // one torn tail row must not hide the ledger
      .filter((b) => b && (!predictionId || b.predictionId === predictionId));
  }
}
