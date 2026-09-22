import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * HandoffContract — body-switching as a first-class Host lifecycle (R8).
 * Seven-phase machine:
 *
 *   prepared → quiesced → checkpointed → released → acquired → resumed → verified
 *
 * First implementation is COLD handoff: every transition is a file under
 * <instance>/checkpoints/, so a dead source body still leaves a resumable
 * envelope. Context translation is an ADAPTER responsibility — the contract
 * only defines the Portable Continuity Envelope shape (Personal AI-owned
 * continuity, never harness-internal session state).
 */
const STATES = [
  'prepared', 'quiesced', 'checkpointed', 'released',
  'acquired', 'resumed', 'verified', 'failed',
];

const ENVELOPE_REQUIRED = [
  'kind', 'goalIdentity', 'canonicalCursor', 'soulIdentity',
  'openPredictions', 'jobCursors', 'policyIdentity',
  'provenanceChain', 'source',
];

/** The five verify() gates — all required, none skippable. */
export const VERIFY_CHECKS = [
  'policyIdentity', 'stateCursor', 'provenanceParent',
  'writerLease', 'capabilityCoverage',
];

export function makePortableContinuityEnvelope(fields) {
  const env = { kind: 'PortableContinuityEnvelope', version: 1, ...fields };
  const missing = ENVELOPE_REQUIRED.filter((k) => env[k] === undefined);
  if (missing.length) {
    throw new Error(`envelope missing required fields: ${missing.join(', ')}`);
  }
  if (env.kind !== 'PortableContinuityEnvelope') {
    throw new Error(`bad envelope kind: ${env.kind}`);
  }
  for (const k of ['body', 'session', 'run']) {
    if (!env.source?.[k]) throw new Error(`envelope source.${k} required`);
  }
  return env;
}

export class HandoffStore {
  /** @param {import('./contracts.js').InstancePaths} paths */
  constructor(paths) {
    this.dir = paths.checkpointsDir;
    mkdirSync(this.dir, { recursive: true });
  }

  _file(id) { return join(this.dir, `${id}.json`); }

  _read(id) {
    const f = this._file(id);
    if (!existsSync(f)) throw new Error(`unknown handoff: ${id}`);
    return JSON.parse(readFileSync(f, 'utf-8'));
  }

  _write(rec) {
    const tmp = `${this._file(rec.id)}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec, null, 2));
    renameSync(tmp, this._file(rec.id));
  }

  _transition(id, to, patch = {}) {
    const rec = this._read(id);
    const i = STATES.indexOf(rec.state);
    const j = STATES.indexOf(to);
    if (j !== i + 1) {
      throw new Error(`illegal handoff transition ${rec.state} → ${to}`);
    }
    Object.assign(rec, patch, { state: to, [`${to}_at`]: new Date().toISOString() });
    this._write(rec);
    return rec;
  }

  /** Source body declares intent + what it currently holds. */
  begin({ handoffId, fromBody, toBody, report = {} }) {
    if (this._exists(handoffId)) throw new Error(`handoff exists: ${handoffId}`);
    const rec = {
      id: handoffId, fromBody, toBody, report,
      state: 'prepared', prepared_at: new Date().toISOString(),
    };
    this._write(rec);
    return rec;
  }

  _exists(id) { return existsSync(this._file(id)); }

  /** Old writer authority stops; session may stay SUSPENDED/READ_ONLY. */
  quiesce(id, report = {}) {
    return this._transition(id, 'quiesced', { quiesceReport: report });
  }

  /** Persist the portable continuity envelope (validated shape). */
  checkpoint(id, envelope) {
    const env = makePortableContinuityEnvelope(envelope);
    return this._transition(id, 'checkpointed', { envelope: env });
  }

  /** Old body releases domain leases — MUST precede acquire (no dual-write window). */
  release(id, released = []) {
    return this._transition(id, 'released', { releasedLeases: released });
  }

  acquire(id, { byBody, leases = [] }) {
    const rec = this._transition(id, 'acquired', { acquiredBy: byBody, acquiredLeases: leases });
    return rec;
  }

  /** New adapter builds body-local context from the envelope. */
  resume(id) {
    const rec = this._read(id);
    if (rec.state !== 'acquired') {
      throw new Error(`resume requires acquired state, got ${rec.state}`);
    }
    return this._transition(id, 'resumed');
  }

  /**
   * Gate before the new body's first mutation. The five checks are
   * REQUIRED — a missing check is a failed check (fail-closed); the caller
   * cannot skip a gate by omitting its key:
   *   policyIdentity     — target-loaded policy hash === envelope policyIdentity
   *   stateCursor        — recomputed canonical cursor === envelope canonicalCursor
   *   provenanceParent   — provenance chain's parent is the source run
   *   writerLease        — target body holds the domain writer lease
   *   capabilityCoverage — target body is eligible for the handoff task profile
   * Any failure → fail-closed (rollback/BLOCKED), never continue.
   */
  verify(id, checks = {}) {
    const rec = this._read(id);
    const failures = VERIFY_CHECKS.filter((name) => checks[name] !== true);
    if (failures.length) {
      rec.state = 'failed';
      rec.failures = failures;
      rec.failed_at = new Date().toISOString();
      this._write(rec);
      return { ok: false, failures, record: rec };
    }
    return { ok: true, record: this._transition(id, 'verified') };
  }

  status(id) { return this._read(id); }

  /** Resumable cold handoffs: any record not yet verified/failed. */
  pending() {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(readFileSync(join(this.dir, f), 'utf-8')); } catch { return null; } })
      .filter((r) => r && !['verified', 'failed'].includes(r.state));
  }
}
