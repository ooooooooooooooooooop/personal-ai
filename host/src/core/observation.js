import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactSecrets, scrubSecretsDeep } from './secrets.js';

/**
 * Observation store — world-model observation lifecycle.
 *
 * Observations are what the body actually observed (tool results, compaction
 * events, runtime facts). They are durable INSTANCE RUNTIME state (stored under
 * the instance's world-model dir, NOT the governed canonical dir — boundary
 * adjudicated by owner 2026-10-10): append-only, they survive
 * compaction and body switches, and the live context provider re-reads them on
 * every context event so a post-compaction turn re-receives the observation
 * projection — same preservation mechanism as open predictions.
 *
 * Layout inside the instance world-model dir:
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
  constructor(baseDir) {
    this.dir = join(baseDir, 'observations');
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
      // M5 parity: details carry tool-result content into a durable append-only
      // JSONL — scrub known credential shapes BEFORE the bytes land.
      kind, subject: redactSecrets(String(subject)), detail: scrubSecretsDeep(detail), actor, at: Date.now(),
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

  /**
   * The context projection window — most recent N observations.
   *
   * TAIL-READ, not a full scan. The context provider calls this EVERY turn, and
   * the loop records one row per tool result — so the file changes on every
   * turn, the (size, mtimeMs) fingerprint misses every turn, and `list()` would
   * put an O(entire file) SYNCHRONOUS read+parse on the hot path. Measured cost
   * of that (rows / file / ms per call): 1k/120KB/1.3 · 20k/2.4MB/25 · 100k/12MB/66
   * · 300k/36MB/190. Since this call only ever needs the last `limit` rows, read
   * a bounded tail window instead.
   *
   * `list()` deliberately keeps the full scan: it is the total-count path
   * (compaction audit) and needs the exact length.
   */
  recent(limit = 20) {
    if (!existsSync(this.path)) return [];
    const st = statSync(this.path);
    // Rows are small in practice but not bounded by contract (a verify_fail
    // detail can carry a ~2 KB output tail), so grow the window until it yields
    // `limit` rows or covers the whole file.
    let window = 64 * 1024;
    for (;;) {
      const start = Math.max(0, st.size - window);
      let text = '';
      if (st.size > 0) {
        const fd = openSync(this.path, 'r');
        try {
          const len = st.size - start;
          const buf = Buffer.alloc(len);
          readSync(fd, buf, 0, len, start);
          text = buf.toString('utf-8');
        } finally {
          closeSync(fd);
        }
      }
      // A window starting mid-file begins mid-row — drop that partial head line.
      // (It may also be split mid-multibyte; the head is discarded either way.)
      if (start > 0) {
        const nl = text.indexOf('\n');
        text = nl >= 0 ? text.slice(nl + 1) : '';
      }
      const rows = text.split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      if (rows.length >= limit || start === 0) return rows.slice(-limit);
      window *= 4;
    }
  }
}
