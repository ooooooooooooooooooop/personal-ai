import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Generated-policy attestation.
 *
 * The canonical governance block (<canonical>/policy.json) is the single source
 * of runtime authority rules. It carries a content checksum; the InstructionEnvelope
 * pins that checksum so every body, every turn, can prove it is acting under the
 * SAME policy generation — non-negotiable invariant #4 (policy drift → FAIL_CLOSED).
 *
 * NAME, so nobody has to re-derive it: "policy" here means ENFORCEMENT policy —
 * which actions are denied, which need approval, what the risk posture is. It is
 * governance content (the U domain). It is NOT the world-model theory's "compiled
 * policy" (Π), which is a different thing entirely: learned decision heuristics
 * that survive as a fast path. Same word, different object. The generated artifact
 * that renders this block into the instruction channel is therefore named
 * `instruction/generated.md`, not `policy/…` — the U domain does not get to borrow
 * Π's word. Renaming this file (e.g. to governance.json) would be cleaner still,
 * but it is an existing contract read by attestation and the channel, so the
 * clarification is written here instead of a silent rename.
 *
 * Attestation model:
 *  - loadPolicy() reads the canonical block and computes its checksum once.
 *  - assertFresh() re-reads the canonical file and compares — a canonical block
 *    that drifted under a live session means either an unauthorized writer or
 *    a stale snapshot; both are fail-closed, never "degraded-continue".
 */

export function policyChecksum(policyDoc) {
  return createHash('sha256').update(JSON.stringify(policyDoc)).digest('hex');
}

/** @returns {{doc:object, checksum:string, path:string}} */
export function loadPolicy(canonicalDir, filename = 'policy.json') {
  const path = join(canonicalDir, filename);
  if (!existsSync(path)) {
    throw new Error(`policy attestation failed: canonical policy missing at ${path}`);
  }
  const doc = JSON.parse(readFileSync(path, 'utf-8'));
  return { doc, checksum: policyChecksum(doc), path };
}

/**
 * Verify the canonical policy on disk still matches the attested checksum.
 * @returns {{fresh:true}|{fresh:false, onDisk:string}}
 */
export function assertFresh(attested) {
  if (!existsSync(attested.path)) return { fresh: false, onDisk: 'missing' };
  const onDisk = policyChecksum(JSON.parse(readFileSync(attested.path, 'utf-8')));
  return onDisk === attested.checksum ? { fresh: true } : { fresh: false, onDisk };
}

/**
 * A live policy handle the kernel re-attests against. Construction throws when
 * the canonical block is absent — a kernel without policy is a kernel that
 * cannot prove invariant #4, so it must not exist.
 */
export class AttestedPolicy {
  constructor(canonicalDir, filename) {
    const { doc, checksum, path } = loadPolicy(canonicalDir, filename);
    this.doc = doc;
    this.checksum = checksum;
    this.path = path;
  }

  /** Re-read canonical and detect drift. Throws (fail-closed) on drift. */
  assertFresh() {
    const r = assertFresh(this);
    if (!r.fresh) {
      const err = new Error(`policy drift detected: attested=${this.checksum} onDisk=${r.onDisk}`);
      err.code = 'POLICY_DRIFT';
      throw err;
    }
    return true;
  }

  get denyRules() {
    return Array.isArray(this.doc?.deny) ? this.doc.deny : [];
  }

  get toolPolicy() {
    return this.doc?.tools ?? {};
  }
}
