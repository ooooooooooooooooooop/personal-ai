import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * BodyRegistry — the FACTS face of body selection (R8). Records what each
 * body verifiably can and cannot do; never stores selection state (that is
 * SelectorPolicy's job, M3+). Persisted at <instance>/registry.json, atomic
 * tmp+rename writes.
 */
export class BodyRegistry {
  /** @param {import('./contracts.js').InstancePaths} paths */
  constructor(paths) {
    this.file = join(paths.root, 'registry.json');
    // torn store (crash mid-write before the atomic tmp+rename landed, or
    // disk failure) must not brick bootstrap — bodies re-register at boot,
    // so degrading to an empty map loses nothing durable. A HARD throw here
    // is the batch-5 deny-memory brick class.
    try {
      this.data = existsSync(this.file)
        ? JSON.parse(readFileSync(this.file, 'utf-8'))
        : { version: 1, bodies: {} };
      if (typeof this.data !== 'object' || this.data === null || typeof this.data.bodies !== 'object') {
        this.data = { version: 1, bodies: {} };
      }
    } catch {
      this.data = { version: 1, bodies: {} };
    }
  }

  /**
   * @param {import('./contracts.js').BodyFacts} facts
   */
  register(facts) {
    if (!facts?.body_id || !facts?.adapter_version) {
      throw new Error('body registration requires body_id + adapter_version');
    }
    const caps = facts.verified_capabilities ?? facts.capabilities;
    if (typeof caps !== 'object' || caps === null) {
      throw new Error('body registration requires verified_capabilities map');
    }
    for (const group of ['verified_capabilities', 'capabilities', 'governance_coverage', 'handoff_capabilities']) {
      if (typeof facts[group] !== 'object' || facts[group] === null) continue;
      for (const [cap, level] of Object.entries(facts[group])) {
        if (!['supported', 'partial', 'unsupported'].includes(level)) {
          throw new Error(`${group}.${cap}: bad level ${level}`);
        }
      }
    }
    this.data.bodies[facts.body_id] = {
      ...facts,
      registered_at: new Date().toISOString(),
      last_verified_at: new Date().toISOString(),
    };
    this._save();
    return this.data.bodies[facts.body_id];
  }

  markVerified(bodyId) {
    const b = this.data.bodies[bodyId];
    if (!b) throw new Error(`unknown body: ${bodyId}`);
    b.last_verified_at = new Date().toISOString();
    this._save();
  }

  get(bodyId) { return this.data.bodies[bodyId]; }
  list() { return Object.values(this.data.bodies); }

  _save() {
    // pid-suffixed: a shared bare .tmp races a second writer (app + CLI)
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}
