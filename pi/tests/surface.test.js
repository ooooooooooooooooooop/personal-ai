/**
 * ToolSurface durability: deny-memory must survive crashes atomically and a
 * torn store must never brick bootstrap.
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolSurface } from '../src/adapter/surface.js';

const rig = (dir, initialDeny = []) => {
  let active = ['bash', 'read', 'write'];
  const session = {
    getActiveToolNames: () => [...active],
    setActiveToolsByName: (n) => { active = [...n]; },
  };
  const surface = new ToolSurface({ session, denyMemoryPath: join(dir, 'deny-memory.json'), initialDeny });
  return { session, surface };
};

test('a torn deny-memory store degrades to initialDeny instead of throwing at construction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-surf-'));
  writeFileSync(join(dir, 'deny-memory.json'), '["deploy", "depl'); // crash mid-write
  const { session, surface } = rig(dir, ['bash']);
  assert.ok(surface.isDenied('bash'), 'initialDeny still honored');
  assert.ok(!surface.isDenied('deploy'), 'torn row not recoverable — visibility fails open, execution stays kernel-gated');
  surface.reconcile();
  assert.deepEqual(session.getActiveToolNames(), ['read', 'write']);
});

test('deny persists atomically — no tmp debris, store parseable, survives reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-surf-'));
  const { surface } = rig(dir);
  surface.deny('deploy');
  surface.deny('bash');
  assert.ok(!readdirSync(dir).some((f) => f.includes('.tmp-')), 'no tmp debris');
  const raw = JSON.parse(readFileSync(join(dir, 'deny-memory.json'), 'utf-8'));
  assert.deepEqual(raw, ['bash', 'deploy']);
  const { surface: s2 } = rig(dir);
  assert.ok(s2.isDenied('deploy') && s2.isDenied('bash'), 'deny set survives reopen');
});

test('non-array corrupt store is tolerated (shape drift fails safe)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-surf-'));
  writeFileSync(join(dir, 'deny-memory.json'), '{"oops": true}');
  const { surface } = rig(dir, ['write']);
  assert.deepEqual([...surface.denied], ['write']);
});

// dedup-h #1112 — delegate-child `tools:` allowlist: only listed names
// (incl. prefix*) may be visible/activatable; not persisted to deny-memory.
test('allowedTools: unlisted tools hidden at reconcile; lazy non-allowed not activatable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-surf-'));
  let active = ['read', 'write', 'mcp__gh__pr', 'mcp__gh__issue'];
  const session = {
    getActiveToolNames: () => [...active],
    setActiveToolsByName: (n) => { active = [...n]; },
  };
  const surface = new ToolSurface({
    session,
    denyMemoryPath: join(dir, 'deny-memory.json'),
    allowedTools: ['read', 'mcp__gh__*'],
  });
  surface.reconcile();
  assert.deepEqual(session.getActiveToolNames(), ['read', 'mcp__gh__pr', 'mcp__gh__issue']);
  // a late-registered tool is hidden by the same re-filter
  active.push('mcp__evil__x');
  surface.reconcile();
  assert.deepEqual(session.getActiveToolNames(), ['read', 'mcp__gh__pr', 'mcp__gh__issue']);
  // a deferred tool off the allowlist cannot be activated through it either
  surface.defer(['mcp__evil__x']);
  assert.equal(surface.activatable('mcp__evil__x'), false);
  assert.deepEqual(surface.activate(['mcp__evil__x']), []);
  // allowlist hides are session-scoped — deny-memory is never written
  assert.equal(existsSync(join(dir, 'deny-memory.json')), false);
});
