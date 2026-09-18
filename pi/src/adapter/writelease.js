/**
 * Workspace write mutex — closes the foreground-agent × background-job race.
 *
 * A durable job whose command can mutate the workspace takes this lease; while
 * it is held, foreground mutating calls are refused with a reason naming the
 * holder. Stale leases die two ways: expiry, or the holder pid being dead —
 * never silently honored. The lease file lives in the instance root, not the
 * workspace, so workspace writes can't clobber it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

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

  /** Live lease record or null — expired and dead-pid leases are dead. */
  held() {
    const r = this.#read();
    if (!r) return null;
    if (r.expires && r.expires < Date.now()) return null;
    if (r.pid && !this.isAlive(r.pid)) return null;
    return r;
  }

  acquire(holder, meta = {}) {
    const cur = this.held();
    if (cur && cur.holder !== holder) return { ok: false, heldBy: cur };
    const lease = { holder, pid: meta.pid ?? process.pid, expires: Date.now() + this.ttlMs, meta, acquiredAt: Date.now() };
    writeFileSync(this.file, JSON.stringify(lease, null, 2));
    return { ok: true, lease };
  }

  renew(holder) {
    const cur = this.#read();
    if (!cur || cur.holder !== holder) return false;
    cur.expires = Date.now() + this.ttlMs;
    writeFileSync(this.file, JSON.stringify(cur, null, 2));
    return true;
  }

  release(holder) {
    const cur = this.#read();
    if (!cur || cur.holder !== holder) return false;
    try { writeFileSync(this.file, JSON.stringify({ released: holder, at: Date.now() })); } catch { /* ignore */ }
    return true;
  }
}
