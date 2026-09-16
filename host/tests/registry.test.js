import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BodyRegistry } from '../src/core/registry.js';

function reg() {
  return new BodyRegistry({ root: mkdtempSync(join(tmpdir(), 'pai-reg-')) });
}

const PI_FACTS = {
  body_id: 'pi',
  adapter_version: '0.85.1',
  capabilities: { final_post_extension_guard: 'supported', mcp_native: 'unsupported' },
  supported_effect_domains: ['tools', 'filesystem'],
};

test('register validates and persists body facts', () => {
  const r = reg();
  const b = r.register(PI_FACTS);
  assert.equal(b.body_id, 'pi');
  assert.ok(b.registered_at);
  assert.ok(b.last_verified_at);
  // reload from disk — persisted
  const r2 = new BodyRegistry({ root: join(r.file, '..') });
  assert.equal(r2.get('pi').adapter_version, '0.85.1');
});

test('registration requires identity + well-formed capabilities', () => {
  const r = reg();
  assert.throws(() => r.register({ adapter_version: '1' }), /body_id/);
  assert.throws(() => r.register({ body_id: 'x', adapter_version: '1' }), /capabilities/);
  assert.throws(
    () => r.register({ body_id: 'x', adapter_version: '1', capabilities: { a: 'magic' } }),
    /bad level/,
  );
});

test('facts only: no selection state is stored', () => {
  const r = reg();
  r.register(PI_FACTS);
  const raw = JSON.parse(readFileSync(r.file, 'utf-8'));
  assert.equal(raw.bodies.pi.default, undefined);
  assert.equal(raw.bodies.pi.role, undefined);
});
