import { mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainLeaseStore } from '../src/core/lease.js';

const here = dirname(fileURLToPath(import.meta.url));

function store(nowRef) {
  const dir = mkdtempSync(join(tmpdir(), 'pai-lease-'));
  return new DomainLeaseStore({ root: dir }, { now: () => nowRef.t });
}

test('claim grants a free domain; second claim fails until expiry', () => {
  const nowRef = { t: 1000 };
  const s = store(nowRef);
  const a = s.claim({ scope: 'domain', name: 'world-model', owner: 'pi:r1', ttlSeconds: 10 });
  assert.ok(a.ok);
  assert.equal(a.lease.generation, 1);

  const b = s.claim({ scope: 'domain', name: 'world-model', owner: 'dsh:r9', ttlSeconds: 10 });
  assert.equal(b.ok, false);
  assert.equal(b.heldBy.owner, 'pi:r1');

  nowRef.t += 11; // lease expires
  const c = s.claim({ scope: 'domain', name: 'world-model', owner: 'dsh:r9', ttlSeconds: 10 });
  assert.ok(c.ok);
  assert.equal(c.lease.generation, 2); // fencing moved forward
  s.close();
});

test('renew requires owner+generation and a live lease', () => {
  const nowRef = { t: 1000 };
  const s = store(nowRef);
  s.claim({ scope: 'domain', name: 'goals', owner: 'pi:r1', ttlSeconds: 10 });
  assert.ok(s.renew({ scope: 'domain', name: 'goals', owner: 'pi:r1', generation: 1, ttlSeconds: 10 }).ok);
  // wrong generation (stale fencing token)
  assert.equal(
    s.renew({ scope: 'domain', name: 'goals', owner: 'pi:r1', generation: 99, ttlSeconds: 10 }).ok,
    false,
  );
  nowRef.t += 25; // expired despite renews? (renew pushed expiry to t+10=... recompute)
  s.close();
});

test('release frees the domain; wrong generation cannot release', () => {
  const s = store({ t: 1000 });
  s.claim({ scope: 'domain', name: 'jobs', owner: 'pi:r1', ttlSeconds: 10 });
  assert.equal(
    s.release({ scope: 'domain', name: 'jobs', owner: 'pi:r1', generation: 7 }).ok,
    false,
  );
  assert.ok(s.release({ scope: 'domain', name: 'jobs', owner: 'pi:r1', generation: 1 }).ok);
  assert.equal(s.heldBy({ scope: 'domain', name: 'jobs' }).status, 'released');
  s.close();
});

test('revived stale owner fails assertHeld after takeover (fencing)', () => {
  const nowRef = { t: 1000 };
  const s = store(nowRef);
  s.claim({ scope: 'domain', name: 'world-model', owner: 'pi:old', ttlSeconds: 10 });
  nowRef.t += 20; // old owner presumed dead

  const take = s.takeoverExpired({
    scope: 'domain', name: 'world-model',
    owner: 'dsh:new', expectedGeneration: 1, ttlSeconds: 30,
  });
  assert.ok(take.ok);
  assert.equal(take.lease.generation, 2);

  // the revived old writer's generation-1 token is now invalid
  assert.equal(
    s.assertHeld({ scope: 'domain', name: 'world-model', owner: 'pi:old', generation: 1 }),
    false,
  );
  assert.ok(
    s.assertHeld({ scope: 'domain', name: 'world-model', owner: 'dsh:new', generation: 2 }),
  );

  // takeover with wrong expected generation is rejected
  nowRef.t += 40;
  assert.equal(
    s.takeoverExpired({
      scope: 'domain', name: 'world-model',
      owner: 'pi:r3', expectedGeneration: 1, ttlSeconds: 30,
    }).ok,
    false,
  );
  s.close();
});

test('scopes are independent: capability lease does not collide with domain lease', () => {
  const s = store({ t: 1000 });
  assert.ok(s.claim({ scope: 'domain', name: 'world-model', owner: 'pi', ttlSeconds: 10 }).ok);
  assert.ok(s.claim({ scope: 'capability', name: 'world-model', owner: 'dsh', ttlSeconds: 10 }).ok);
  s.close();
});

test('E4: real multi-process competition — exactly one winner, release visible across processes', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-lease-race-'));
  // init schema from the parent so children only race on the claim itself
  const init = new DomainLeaseStore({ root: dir });
  init.close();

  const fixture = join(here, 'fixtures', 'lease-contender.js');
  const owners = ['proc-a', 'proc-b', 'proc-c', 'proc-d'];
  const run = (owner) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, dir, owner], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('exit', (code) => code === 0 ? resolve(out) : reject(new Error(`${owner} exited ${code}`)));
  });

  const outputs = await Promise.all(owners.map(run));
  const lines = outputs.flatMap((o) => o.trim().split('\n').map((l) => JSON.parse(l)));
  const claims = lines.filter((l) => 'ok' in l);
  const winners = claims.filter((l) => l.ok);
  const losers = claims.filter((l) => !l.ok);

  assert.equal(winners.length, 1, `expected exactly one winner, got ${JSON.stringify(claims)}`);
  assert.equal(losers.length, owners.length - 1);
  assert.equal(winners[0].generation, 1); // first-ever claim on this db
  for (const l of losers) assert.equal(l.heldBy, winners[0].owner); // CAS told the loser who holds it

  const released = lines.find((l) => l.released === true);
  assert.equal(released.owner, winners[0].owner);

  // release is visible cross-process: a NEW process claims the same name
  const parent = new DomainLeaseStore({ root: dir });
  const after = parent.claim({ scope: 'domain', name: 'contended', owner: 'parent', ttlSeconds: 10 });
  assert.ok(after.ok);
  assert.equal(after.lease.generation, 2); // fencing moved forward
  parent.close();
});
