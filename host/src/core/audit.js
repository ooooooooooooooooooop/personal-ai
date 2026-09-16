import { appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

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
 */
export class AuditWriter {
  /** @param {import('./contracts.js').InstancePaths} paths */
  constructor(paths, name = 'host-audit') {
    this.file = join(paths.auditDir, `${name}.jsonl`);
    mkdirSync(paths.auditDir, { recursive: true });
  }

  /** @param {import('./contracts.js').AuditEvent} event */
  write(event) {
    const safe = { ...event };
    if (safe.data !== undefined) safe.data = redact(safe.data);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...safe });
    appendFileSync(this.file, line + '\n');
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
