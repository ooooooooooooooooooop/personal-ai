import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Observation store — canonical world-model observation lifecycle.
 *
 * Observations are what the body actually observed (tool results, compaction
 * events, runtime facts). They are canonical state: append-only, they survive
 * compaction and body switches, and the live context provider re-reads them on
 * every context event so a post-compaction turn re-receives the observation
 * projection — same preservation mechanism as open predictions.
 *
 * Layout inside the canonical dir:
 *   observations/observations.jsonl — append-only observation records
 *
 * Read-path discipline (budget.js precedent): the context provider calls
 * recent() EVERY turn, and the loop extension records one row per tool
 * result — an uncached full-file scan per turn turns a long-lived instance
 * into a synchronous read of an ever-larger JSONL on the hot path. The file
 * is append-only, so (size, mtimeMs) is a sound fingerprint: every append
 * grows size; external rewrite/truncate changes both. Cross-process writers
 * (delegate children share the instance) are caught by the same stat check.
 */
export class ObservationStore {
  constructor(canonicalDir) {
    this.dir = join(canonicalDir, 'observations');
    mkdirSync(this.dir, { recursive: true });
    this.path = join(this.dir, 'observations.jsonl');
    this._cacheFp = null;
    this._cacheRows = null;
  }

  /** Append an observation. Returns the stored record. */
  record({ kind, subject, detail = null, actor = 'host' }) {
    if (!kind || !subject) throw new Error('observation requires kind and subject');
    const rec = {
      id: `obs-${randomUUID().slice(0, 12)}`,
      kind, subject, detail, actor, at: Date.now(),
    };
    appendFileSync(this.path, `${JSON.stringify(rec)}\n`);
    return rec;
  }

  list() {
    if (!existsSync(this.path)) return [];
    const st = statSync(this.path);
    const fp = `${st.size}:${st.mtimeMs}`;
    if (this._cacheFp === fp && this._cacheRows) return this._cacheRows;
    const rows = readFileSync(this.path, 'utf-8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    this._cacheFp = fp;
    this._cacheRows = rows;
    return rows;
  }

  /** The context projection window — most recent N observations. */
  recent(limit = 20) {
    return this.list().slice(-limit);
  }
}
