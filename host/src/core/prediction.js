import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/**
 * Prediction store — canonical world-model lifecycle.
 *
 * Predictions are canonical state: they survive compaction, handoff, and body
 * switches (they ride the PortableContinuityEnvelope's openPredictions field).
 * Every world-model mutation must bind to an open prediction — the bind record
 * is append-only so provenance is reconstructable after the fact.
 *
 * Layout inside the canonical dir:
 *   predictions/index.json    — {id: prediction record} (open + closed)
 *   predictions/bindings.jsonl— append-only mutation→prediction bindings
 *
 * Invariant: close() never deletes; state transitions are open→confirmed|refuted.
 */

const OPEN = 'open';
const TERMINAL = new Set(['confirmed', 'refuted']);

export class PredictionStore {
  constructor(canonicalDir) {
    this.dir = join(canonicalDir, 'predictions');
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
    // file and a corrupt index would brick every later bootstrap.
    const tmp = `${this.indexPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.index, null, 2));
    renameSync(tmp, this.indexPath);
  }

  /** Open a prediction. Mutations against the world model bind to its id. */
  open({ claim, horizon = null, confidence = null, actor = 'host', tags = [] }) {
    if (!claim) throw new Error('prediction requires a claim');
    const id = `pred-${randomUUID().slice(0, 12)}`;
    this.index[id] = {
      id, claim, status: OPEN, horizon, confidence, actor, tags,
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
    p.outcome = outcome ?? null;
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
    return this.list(OPEN);
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
