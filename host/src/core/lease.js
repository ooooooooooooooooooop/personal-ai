import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Scoped writer/effect lease store — atomic CAS + fencing, zero-dep via
 * node:sqlite. R9 blocker semantics, frozen:
 *
 *   claim(domain, owner)             — succeeds only when free or expired
 *   renew(lease)                     — owner+generation must match, not expired
 *   release(lease)                   — owner+generation must match
 *   takeoverExpired(expectedGen)     — succeeds only on a stale row at the
 *                                      expected generation (no takeover race)
 *   assertHeld(lease)                — pre-effect fencing check: an old owner
 *                                      revived after takeover fails this
 *
 * Single-statement upserts give real cross-process atomicity (SQLite file
 * locking + WAL). Generation is monotonic per (scope,name) — it is the fencing
 * token every writer must re-verify before each effect.
 */
export class DomainLeaseStore {
  /** @param {import('./contracts.js').InstancePaths} paths */
  constructor(paths, { now = () => Date.now() / 1000 } = {}) {
    mkdirSync(paths.root, { recursive: true });
    this.now = now;
    this.db = new DatabaseSync(join(paths.root, 'leases.db'));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS leases (
      scope TEXT NOT NULL,
      name TEXT NOT NULL,
      owner TEXT NOT NULL,
      generation INTEGER NOT NULL,
      acquired_at REAL NOT NULL,
      expires_at REAL NOT NULL,
      last_renewed_at REAL NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','released')),
      PRIMARY KEY (scope, name)
    )`);
    this._claim = this.db.prepare(`INSERT INTO leases
        (scope, name, owner, generation, acquired_at, expires_at, last_renewed_at, status)
      VALUES (@scope, @name, @owner, 1, @now, @expires, @now, 'active')
      ON CONFLICT(scope, name) DO UPDATE SET
        owner = @owner, generation = leases.generation + 1,
        acquired_at = @now, expires_at = @expires, last_renewed_at = @now,
        status = 'active'
      WHERE leases.status = 'released' OR leases.expires_at < @now`);
    this._renew = this.db.prepare(`UPDATE leases
      SET expires_at = @expires, last_renewed_at = @now
      WHERE scope = @scope AND name = @name AND owner = @owner
        AND generation = @generation AND status = 'active'
        AND expires_at >= @now`);
    this._release = this.db.prepare(`UPDATE leases SET status = 'released'
      WHERE scope = @scope AND name = @name AND owner = @owner
        AND generation = @generation AND status = 'active'`);
    this._takeover = this.db.prepare(`UPDATE leases SET
        owner = @owner, generation = generation + 1,
        acquired_at = @now, expires_at = @expires, last_renewed_at = @now
      WHERE scope = @scope AND name = @name AND status = 'active'
        AND expires_at < @now AND generation = @expectedGeneration`);
    this._get = this.db.prepare(
      'SELECT * FROM leases WHERE scope = ? AND name = ?'
    );
  }

  /**
   * @returns {{ok: boolean, lease?: import('./contracts.js').LeaseRecord, heldBy?: object}}
   */
  claim({ scope, name, owner, ttlSeconds = 30 }) {
    const now = this.now();
    const r = this._claim.run({
      scope, name, owner, now, expires: now + ttlSeconds,
    });
    if (r.changes === 1) return { ok: true, lease: this.heldBy({ scope, name }) };
    return { ok: false, heldBy: this.heldBy({ scope, name }) };
  }

  /** @returns {{ok: boolean, reason?: string}} */
  renew({ scope, name, owner, generation, ttlSeconds = 30 }) {
    const now = this.now();
    const r = this._renew.run({
      scope, name, owner, generation, now, expires: now + ttlSeconds,
    });
    return r.changes === 1
      ? { ok: true }
      : { ok: false, reason: 'lease lost: owner/generation mismatch or expired' };
  }

  /** @returns {{ok: boolean, reason?: string}} */
  release({ scope, name, owner, generation }) {
    const r = this._release.run({ scope, name, owner, generation });
    return r.changes === 1
      ? { ok: true }
      : { ok: false, reason: 'release rejected: owner/generation mismatch' };
  }

  /**
   * Take over ONLY a stale row at the expected generation. A healthy lease or
   * a generation that already moved → fail.
   */
  takeoverExpired({ scope, name, owner, expectedGeneration, ttlSeconds = 30 }) {
    const now = this.now();
    const r = this._takeover.run({
      scope, name, owner, expectedGeneration, now, expires: now + ttlSeconds,
    });
    if (r.changes === 1) return { ok: true, lease: this.heldBy({ scope, name }) };
    return { ok: false, heldBy: this.heldBy({ scope, name }) };
  }

  /** Pre-effect fencing check — call before EVERY governed write. */
  assertHeld({ scope, name, owner, generation }) {
    const row = this._get.get(scope, name);
    return !!row && row.status === 'active' && row.owner === owner &&
      row.generation === generation && row.expires_at > this.now();
  }

  heldBy({ scope, name }) {
    const row = this._get.get(scope, name);
    if (!row) return undefined;
    return {
      scope: row.scope, name: row.name, owner: row.owner,
      generation: row.generation, expiresAt: row.expires_at,
      status: row.status, stale: row.expires_at < this.now(),
    };
  }

  close() { this.db.close(); }
}
