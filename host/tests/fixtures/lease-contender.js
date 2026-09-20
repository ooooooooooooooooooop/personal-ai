/**
 * E4 fixture — one lease contender per OS process. Claims the same lease the
 * other contenders are racing for. IPC barriers let the parent hold the
 * winner until every process has attempted its claim, regardless of load.
 *
 * Usage: node host/tests/fixtures/lease-contender.js <dbDir> <owner>
 * IPC: ready -> claim -> claimed -> release -> released -> disconnect
 */
import { DomainLeaseStore } from '../../src/core/lease.js';

const [dir, owner] = process.argv.slice(2);
if (!dir || !owner || !process.send) {
  console.error('usage: node lease-contender.js <dbDir> <owner>');
  process.exit(2);
}

const s = new DomainLeaseStore({ root: dir });
let result;
process.on('message', (message) => {
  if (message.type === 'claim' && !result) {
    result = s.claim({ scope: 'domain', name: 'contended', owner, ttlSeconds: 60 });
    process.send({
      type: 'claimed', owner, ok: result.ok,
      generation: result.lease?.generation ?? result.heldBy?.generation,
      heldBy: result.heldBy?.owner,
    });
  } else if (message.type === 'release' && result?.ok) {
    const released = s.release({ scope: 'domain', name: 'contended', owner, generation: result.lease.generation });
    process.send({ type: 'released', owner, released: released.ok });
  }
});
process.once('disconnect', () => s.close());
process.send({ type: 'ready', owner });
