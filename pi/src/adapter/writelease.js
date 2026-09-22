/**
 * Workspace write mutex — closes the foreground-agent × background-job race.
 *
 * A durable job whose command can mutate the workspace takes this lease; while
 * it is held, foreground mutating calls are refused with a reason naming the
 * holder. Stale leases die two ways: expiry, or the holder pid being dead —
 * never silently honored. The lease file lives in the instance root, not the
 * workspace, so workspace writes can't clobber it.
 *
 * Write discipline: every mutation is tmp+rename (a TORN lease read as absent
 * would silently drop the mutex — fail-open on the exact path it exists to
 * close), and acquire() claims via hard-link create-or-fail so two processes
 * cannot both win a same-instant claim on a free/stale slot.
 */
import { existsSync, linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

export class WorkspaceWriteLease {
  /**
   * @param {string} filePath  <instance>/workspace-write-lease.json
   * @param {object} [opts]    {ttlMs, isAlive}
   */
  constructor(filePath, { ttlMs = 180_000, isAlive = null } = {}) {
    this.file = filePath;
    this.ttlMs = ttlMs;
    this.isAlive = isAlive ?? ((pid) => {
      if (typeof pid !== 'number' || pid <= 0) return true; // unknown pid → conservative
      try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
    });
  }

  #read() {
    try {
      if (!existsSync(this.file)) return null;
      const r = JSON.parse(readFileSync(this.file, 'utf-8'));
      return r && r.holder ? r : null;
    } catch { return null; }
  }

  /** Atomic write: a torn lease must never read as "slot free". */
  #write(obj) {
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(obj, null, 2));
    renameSync(tmp, this.file);
  }

  /** Live lease record or null — expired and dead-pid leases are dead. */
  held() {
    const r = this.#read();
    if (!r) return null;
    if (r.expires && r.expires < Date.now()) return null;
    if (r.pid && !this.isAlive(r.pid)) return null;
    return r;
  }

  acquire(holder, meta = {}) {
    const mk = () => ({ holder, pid: meta.pid ?? process.pid, expires: Date.now() + this.ttlMs, meta, acquiredAt: Date.now() });
    for (let attempt = 0; attempt < 2; attempt++) {
      const cur = this.held();
      if (cur && cur.holder !== holder) return { ok: false, heldBy: cur };
      const lease = mk();
      if (cur && cur.holder === holder) {
        this.#write(lease); // re-acquire by the live holder: plain rewrite
        return { ok: true, lease };
      }
      // Free/stale slot: claim atomically. link(2) fails with EEXIST when the
      // target exists, so a same-instant competitor cannot both win. A stale
      // row is unlinked first; if a competitor claims the gap, our link fails
      // and we re-read their live lease on the retry.
      try {
        try { unlinkSync(this.file); } catch { /* absent or raced away */ }
        const tmp = `${this.file}.claim-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
        writeFileSync(tmp, JSON.stringify(lease, null, 2));
        try {
          linkSync(tmp, this.file);
        } finally {
          try { unlinkSync(tmp); } catch { /* claimed or raced */ }
        }
        return { ok: true, lease };
      } catch (e) {
        if (e.code === 'EEXIST') continue;
        throw e;
      }
    }
    const cur = this.held();
    return { ok: false, heldBy: cur ?? { holder: 'unknown (claim race)' } };
  }

  renew(holder) {
    const cur = this.#read();
    if (!cur || cur.holder !== holder) return false;
    cur.expires = Date.now() + this.ttlMs;
    this.#write(cur);
    return true;
  }

  release(holder) {
    const cur = this.#read();
    if (!cur || cur.holder !== holder) return false;
    try { this.#write({ released: holder, at: Date.now() }); } catch { /* ignore */ }
    return true;
  }
}
