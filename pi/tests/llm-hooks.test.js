/**
 * dedup-h #1698 — llm_input/llm_output hook payloads: the assembled
 * provider request fires an observational 'llm_input' hook pre-send and
 * the response envelope fires 'llm_output' post-receive, bridged from the
 * pi before_provider_request / after_provider_response lifecycle events.
 * Observational only — hooks never rewrite what the model is sent or told.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { providerAuditExtension } from '../src/adapter/index.js';
import { HOOK_EVENTS, GATE_EVENTS } from '../../host/src/core/hooks.js';

const makePi = () => {
  const handlers = new Map();
  return {
    on: (name, fn) => handlers.set(name, fn),
    emit: (name, event) => handlers.get(name)?.(event),
  };
};

const makeAudit = () => ({ lines: [], write(e) { this.lines.push(e); } });
const makeHooks = () => ({ calls: [], fire(name, payload) { this.calls.push({ name, payload }); } });

test('#1698 — before_provider_request fires llm_input with bounded payload evidence', () => {
  const audit = makeAudit();
  const hooks = makeHooks();
  const pi = makePi();
  providerAuditExtension(audit, () => hooks).factory(pi);

  const payload = {
    model: 'gpt-x',
    messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u'.repeat(40000) }],
  };
  pi.emit('before_provider_request', { type: 'before_provider_request', payload });

  const call = hooks.calls.find((c) => c.name === 'llm_input');
  assert.ok(call, 'llm_input hook fired');
  assert.equal(call.payload.seq, 1);
  assert.equal(call.payload.model, 'gpt-x');
  assert.equal(call.payload.messages, 2);
  assert.equal(typeof call.payload.payloadHash, 'string');
  assert.equal(call.payload.bytes, JSON.stringify(payload).length);
  assert.equal(call.payload.preview.length, 16384, 'preview capped at 16KB');
  assert.equal(call.payload.preview, JSON.stringify(payload).slice(0, 16384));
  // audit probe still ran alongside the hook
  assert.equal(audit.lines.at(-1).kind, 'PROVIDER_REQUEST');
});

test('#1698 — after_provider_response fires llm_output with status + headers', () => {
  const audit = makeAudit();
  const hooks = makeHooks();
  const pi = makePi();
  providerAuditExtension(audit, () => hooks).factory(pi);

  pi.emit('before_provider_request', { type: 'before_provider_request', payload: { messages: [] } });
  pi.emit('after_provider_response', {
    type: 'after_provider_response', status: 429,
    headers: { 'retry-after': '3', 'x-ratelimit-remaining': '0' },
  });

  const call = hooks.calls.find((c) => c.name === 'llm_output');
  assert.ok(call, 'llm_output hook fired');
  assert.equal(call.payload.seq, 1, 'seq pairs with the preceding llm_input');
  assert.equal(call.payload.status, 429);
  assert.deepEqual(call.payload.headers, { 'retry-after': '3', 'x-ratelimit-remaining': '0' });
  assert.equal(audit.lines.at(-1).kind, 'PROVIDER_RESPONSE');
});

test('#1698 — no hooks accessor degrades to audit-only, never throws', () => {
  const audit = makeAudit();
  const pi = makePi();
  providerAuditExtension(audit).factory(pi); // getHooks omitted
  pi.emit('before_provider_request', { type: 'before_provider_request', payload: {} });
  pi.emit('after_provider_response', { type: 'after_provider_response', status: 200, headers: {} });
  assert.deepEqual(audit.lines.map((l) => l.kind), ['PROVIDER_REQUEST', 'PROVIDER_RESPONSE']);

  // a throwing hook must never break the provider path either
  const pi2 = makePi();
  providerAuditExtension(audit, () => ({ fire() { throw new Error('boom'); } })).factory(pi2);
  pi2.emit('before_provider_request', { type: 'before_provider_request', payload: {} });
  pi2.emit('after_provider_response', { type: 'after_provider_response', status: 200, headers: {} });
});

test('#1698 — llm_input/llm_output are observational, never gate-capable', () => {
  assert.ok(HOOK_EVENTS.has('llm_input'));
  assert.ok(HOOK_EVENTS.has('llm_output'));
  assert.ok(!GATE_EVENTS.has('llm_input'), 'llm_input must not be a gate event');
  assert.ok(!GATE_EVENTS.has('llm_output'), 'llm_output must not be a gate event');
});
