/**
 * dedup-h #1937 — `@diagnostics` context form: the operator's mention
 * expands into a <diagnostics> block on the outgoing request only.
 * Provider registry is the lsp extension's live-diagnostics seam.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerContextProvider, collectContext } from '../src/adapter/context-providers.js';
import { atMentionExtension } from '../src/adapter/index.js';

const fakePi = () => {
  const handlers = new Map();
  return { handlers, on: (e, h) => handlers.set(e, h) };
};
const userMsg = (text) => ({ role: 'user', content: [{ type: 'text', text }] });

test('registry: register/collect/unregister; throwing provider degrades to null', () => {
  const un = registerContextProvider('probe-x', () => 'CTX');
  assert.equal(collectContext('probe-x'), 'CTX');
  un();
  assert.equal(collectContext('probe-x'), null);
  registerContextProvider('boom', () => { throw new Error('provider exploded'); });
  assert.equal(collectContext('boom'), null, 'a broken provider never bricks the prompt');
});

test('@diagnostics expands: token stripped, <diagnostics> appended, original message object untouched', () => {
  const pi = fakePi();
  atMentionExtension().factory(pi);
  const ctx = pi.handlers.get('context');
  const un = registerContextProvider('diagnostics', () => 'a.ts:3:1 error: unused variable');
  try {
    const orig = userMsg('fix these @diagnostics please');
    const r = ctx({ type: 'context', messages: [orig] });
    const stripped = r.messages[0];
    assert.equal(stripped.content[0].text, 'fix these  please');
    assert.equal(orig.content[0].text, 'fix these @diagnostics please', 'session text untouched — transient expansion');
    const diag = r.messages.at(-1);
    assert.equal(diag.role, 'user');
    assert.match(diag.content[0].text, /<diagnostics>\na\.ts:3:1 error: unused variable\n<\/diagnostics>/);
  } finally { un(); }
});

test('no provider → honest unavailable note; absent token → no-op (returns undefined)', () => {
  const pi = fakePi();
  atMentionExtension().factory(pi);
  const ctx = pi.handlers.get('context');
  // no provider registered for this test
  const r = ctx({ type: 'context', messages: [userMsg('@diagnostics')] });
  assert.match(r.messages.at(-1).content[0].text, /no diagnostics available/);
  // absent token → undefined (no rewrite)
  const r2 = ctx({ type: 'context', messages: [userMsg('plain prompt')] });
  assert.equal(r2, undefined);
  // embedded token is NOT a mention — email-style text stays untouched
  const r3 = ctx({ type: 'context', messages: [userMsg('mail me at x@diagnostics.y')] });
  assert.equal(r3, undefined, 'x@diagnostics.y must not expand');
  // tool-role text can never trigger it
  const r4 = ctx({ type: 'context', messages: [
    { role: 'toolResult', content: [{ type: 'text', text: '@diagnostics' }] },
    userMsg('clean'),
  ] });
  assert.equal(r4, undefined, 'only user-role text is scanned');
});

test('#2144 @diff expands: ref reaches provider, token stripped, <branch-diff> appended', () => {
  const pi = fakePi();
  atMentionExtension().factory(pi);
  const ctx = pi.handlers.get('context');
  const seen = [];
  const un = registerContextProvider('diff', (ref) => { seen.push(ref); return `diff of HEAD vs '${ref}'`; });
  try {
    const orig = userMsg('review @diff:main please');
    const r = ctx({ type: 'context', messages: [orig] });
    assert.equal(r.messages[0].content[0].text, 'review  please');
    assert.equal(orig.content[0].text, 'review @diff:main please', 'session text untouched');
    assert.deepEqual(seen, ['main']);
    assert.match(r.messages.at(-1).content[0].text, /<branch-diff ref="main">\ndiff of HEAD vs 'main'\n<\/branch-diff>/);
    // bare @diff defaults to main
    const r2 = ctx({ type: 'context', messages: [userMsg('check @diff')] });
    assert.deepEqual(seen, ['main', 'main']);
    assert.match(r2.messages.at(-1).content[0].text, /<branch-diff ref="main">/);
  } finally { un(); }
});

test('#2144 @diff edge cases: no provider → honest note; @diff:bad! chars untouched; absent → no-op', () => {
  const pi = fakePi();
  atMentionExtension().factory(pi);
  const ctx = pi.handlers.get('context');
  const r = ctx({ type: 'context', messages: [userMsg('@diff:feature/x')] });
  assert.match(r.messages.at(-1).content[0].text, /branch diff unavailable/);
  // ref charset bound: `@diff:foo;rm` — `;` outside the class means the whole
  // token fails the lookahead, so nothing expands
  const r2 = ctx({ type: 'context', messages: [userMsg('run @diff:foo;rm now')] });
  assert.equal(r2, undefined);
  const r3 = ctx({ type: 'context', messages: [userMsg('plain')] });
  assert.equal(r3, undefined);
});
