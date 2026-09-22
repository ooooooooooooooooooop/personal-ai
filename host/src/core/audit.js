import { appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { redactSecrets } from './secrets.js';

const SECRET_KEY = /authorization|api[-_]?key|token|secret|password|credential|cookie|bearer/i;

/**
 * Redaction policy (R9): provider headers/payloads may carry Authorization,
 * API keys and user text — NONE may land in the long-lived audit JSONL.
 * Key-name matches → 'REDACTED'; values wrapped as {hash:'sha256'} by callers
 * that need correlation without content.
 */
export function redact(value, depth = 0) {
  if (depth > 12) return '[REDACTED:depth]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? 'REDACTED' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Correlation without content: use for payload bodies/user text. */
export function hashOf(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return `sha256:${createHash('sha256').update(s).digest('hex')}`;
}

/**
 * Append-only JSONL audit writer. Lives in core: audit schema is a Personal AI
 * contract, not a harness concern. Writes go to the instance root, never the
 * source tree (resolveInstanceRoot enforces that upstream).
 *
 * Contract: events land in `<instance>/audit/<YYYY-MM-DD>.jsonl` (UTC date,
 * resolved per write so rotation is free) and carry the session-level
 * annotations (runId / actor / governance_coverage) merged top-level.
 */
export class AuditWriter {
  /**
   * @param {import('./contracts.js').InstancePaths} paths
   * @param {{name?: string, annotations?: Record<string, unknown>}} [opts]
   *        name overrides the date-based file name (tests/tools only)
   */
  constructor(paths, { name = null, annotations = {} } = {}) {
    this.dir = paths.auditDir;
    this.name = name;
    this.annotations = annotations;
    mkdirSync(this.dir, { recursive: true });
  }

  _file() {
    const name = this.name ?? new Date().toISOString().slice(0, 10);
    return join(this.dir, `${name}.jsonl`);
  }

  get file() { return this._file(); }

  /** @param {import('./contracts.js').AuditEvent} event */
  write(event) {
    const safe = { ...this.annotations, ...event };
    if (safe.data !== undefined) safe.data = redact(safe.data);
    // Value-level backstop: key-name redaction can't see a bearer token inside
    // an innocent field (args.command carrying `curl -H "Authorization: ..."`,
    // a paste into a prompt preview). The ledger is the LONG-LIVED artifact —
    // known credential shapes are span-redacted here regardless of caller
    // discipline, same pattern set as the write-path scan (one source of truth).
    const line = redactSecrets(JSON.stringify({ ts: new Date().toISOString(), ...safe }));
    appendFileSync(this._file(), line + '\n');
  }

  /** Fail-closed convenience: an audit write failure is itself surfaced. */
  writeOrThrow(event) {
    try {
      this.write(event);
    } catch (err) {
      throw new Error(`audit write failed (fail-closed): ${err.message}`);
    }
  }
}
