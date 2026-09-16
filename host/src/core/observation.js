import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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
 */
export class ObservationStore {
  constructor(canonicalDir) {
    this.dir = join(canonicalDir, 'observations');
    mkdirSync(this.dir, { recursive: true });
    this.path = join(this.dir, 'observations.jsonl');
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
    return readFileSync(this.path, 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  /** The context projection window — most recent N observations. */
  recent(limit = 20) {
    return this.list().slice(-limit);
  }
}
