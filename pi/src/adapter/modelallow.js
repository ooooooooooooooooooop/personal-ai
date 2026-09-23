// dedup-h #282 — operator model allowlist for automatic failover.
//
// <instance>/models-allow.json:
//   { "allow": [ {"provider":"cpa","model":"vision-x"},
//                {"provider":"*","model":"gpt-*"} ] }
//
// Semantics (operator-private file — the agent cannot widen its own
// failover surface):
//   - absent file            → unrestricted (same posture as egress-allow:
//                              governance ask is the baseline gate)
//   - entries                → an automatic fallback (provider-error walk,
//                              media capability switch) may only select a
//                              chain entry matching some allow row; `*` in
//                              either field is a wildcard
//   - malformed / non-object → FAIL-CLOSED: every automatic fallback is
//                              refused. A typo in an enforcement file must
//                              not silently open the surface; the denial is
//                              audited by each call site.
//
// The predicate re-reads the file on every call — operator edits take
// effect on the next failover decision without a restart, identical to
// sandbox-exclude.json's live posture.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function modelsAllowPredicate(instanceRoot) {
  const path = join(instanceRoot, 'models-allow.json');
  return (entry) => {
    let doc;
    try {
      doc = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (e) {
      if (e?.code === 'ENOENT') return true; // absent = unrestricted
      return false; // malformed → fail closed
    }
    const rows = Array.isArray(doc?.allow) ? doc.allow : [];
    return rows.some((r) => {
      if (!r || typeof r !== 'object') return false;
      const p = r.provider ?? '*';
      const m = r.model ?? '*';
      return (p === '*' || p === entry?.provider) && (m === '*' || m === entry?.model);
    });
  };
}
