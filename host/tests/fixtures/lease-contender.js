/**
 * E4 fixture — one lease contender per OS process. Claims the same lease the
 * other contenders are racing for, prints the outcome as a JSON line, holds
 * briefly, releases.
 *
 * Usage: node host/tests/fixtures/lease-contender.js <dbDir> <owner>
 * stdout: {"owner","ok","generation","heldBy"} then {"owner","released":true}
 */
import { DomainLeaseStore } from '../../src/core/lease.js';

const [dir, owner] = process.argv.slice(2);
if (!dir || !owner) {
  console.error('usage: node lease-contender.js <dbDir> <owner>');
  process.exit(2);
}

const s = new DomainLeaseStore({ root: dir });
const r = s.claim({ scope: 'domain', name: 'contended', owner, ttlSeconds: 30 });
console.log(JSON.stringify({
  owner, ok: r.ok,
  generation: r.lease?.generation ?? r.heldBy?.generation,
  heldBy: r.heldBy?.owner,
}));
if (r.ok) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  const rel = s.release({ scope: 'domain', name: 'contended', owner, generation: r.lease.generation });
  console.log(JSON.stringify({ owner, released: rel.ok }));
}
s.close();
