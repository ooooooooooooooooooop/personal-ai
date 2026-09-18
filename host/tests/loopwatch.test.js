/**
 * LoopDetector — stuck-loop scoring on admitted tool calls. Verdict levels
 * escalate warn → block → operator-escalate; nothing auto-terminates, and
 * absent an operator channel the caller must fail closed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LoopDetector } from '../src/core/loopwatch.js';

test('identical consecutive calls warn at warnAt and block at blockAt', () => {
  const d = new LoopDetector({ warnAt: 3, blockAt: 5 });
  const call = () => d.observe('bash', { command: 'grep foo' });
  assert.equal(call().level, 'ok');
  assert.equal(call().level, 'ok');
  const warn = call();
  assert.equal(warn.level, 'warn');
  assert.equal(warn.kind, 'repeat');
  assert.equal(warn.count, 3);
  assert.equal(call().level, 'warn');
  const block = call();
  assert.equal(block.level, 'block');
  assert.equal(block.kind, 'repeat');
  assert.match(block.reason, /identically 5 times/);
});

test('a signature blocked escalateAfter times escalates instead of silent re-block', () => {
  const d = new LoopDetector({ warnAt: 2, blockAt: 3, escalateAfter: 2 });
  const call = () => d.observe('read', { path: 'a.txt' });
  // first block at 3rd call
  call(); call();
  assert.equal(call().level, 'block');
  // keep retrying the identical call → second block
  const b2 = call();
  assert.equal(b2.level, 'block');
  // third retry → escalate
  const e = call();
  assert.equal(e.level, 'escalate');
  assert.equal(e.blocked, 2);
  // still stuck → keeps escalating, never silently admits
  assert.equal(call().level, 'escalate');
});

test('forgive clears the block record after operator approval', () => {
  const d = new LoopDetector({ warnAt: 2, blockAt: 3, escalateAfter: 1 });
  const call = () => d.observe('write', { path: 'x', content: 'y' });
  call(); call();
  const b = call();
  assert.equal(b.level, 'block');
  assert.equal(call().level, 'escalate'); // blocked once, retried → escalate
  d.forgive(b.signature);
  // operator allowed: scored fresh — the long run re-blocks at blockAt, not escalate
  const after = call();
  assert.equal(after.level, 'block');
  assert.equal(after.blocked, 1);
});

test('different args break the identical-run counter', () => {
  const d = new LoopDetector({ warnAt: 2, blockAt: 3 });
  assert.equal(d.observe('bash', { command: 'a' }).level, 'ok');
  assert.equal(d.observe('bash', { command: 'a' }).level, 'warn');
  assert.equal(d.observe('bash', { command: 'b' }).level, 'ok');
  assert.equal(d.observe('bash', { command: 'a' }).level, 'ok');
});

test('A-B ping-pong warns at pingpongWarn and blocks at pingpongBlock', () => {
  const d = new LoopDetector({ pingpongWarn: 4, pingpongBlock: 6, warnAt: 99, blockAt: 99 });
  const a = () => d.observe('read', { path: 'a' });
  const b = () => d.observe('edit', { path: 'b' });
  // A B A B → warn at 4 alternating
  assert.equal(a().level, 'ok');
  assert.equal(b().level, 'ok');
  assert.equal(a().level, 'ok');
  const w = b();
  assert.equal(w.level, 'warn');
  assert.equal(w.kind, 'pingpong');
  // continue to 6 alternating → block
  assert.equal(a().level, 'warn');
  const blk = b();
  assert.equal(blk.level, 'block');
  assert.equal(blk.kind, 'pingpong');
});

test('designated polling tools are exempt', () => {
  const d = new LoopDetector();
  for (let i = 0; i < 10; i++) {
    assert.equal(d.observe('job_status', { job_id: 'j-1' }).level, 'ok');
  }
});

test('window eviction bounds memory; reset clears all state', () => {
  const d = new LoopDetector({ windowSize: 4, warnAt: 2, blockAt: 3 });
  for (let i = 0; i < 10; i++) d.observe('t', { i });
  assert.equal(d.window.length, 4);
  d.observe('bash', { command: 'x' });
  d.observe('bash', { command: 'x' });
  d.reset();
  assert.equal(d.window.length, 0);
  assert.equal(d.observe('bash', { command: 'x' }).level, 'ok');
});

test('argument key order does not change the signature', () => {
  const d = new LoopDetector();
  const s1 = d.signature('write', { path: 'a', content: 'c' });
  const s2 = d.signature('write', { content: 'c', path: 'a' });
  assert.equal(s1, s2);
});
