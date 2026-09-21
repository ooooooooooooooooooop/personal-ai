import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanForSecrets, redactSecrets } from '../src/core/secrets.js';

// Key literals are assembled at runtime — a literal-looking credential in
// the diff trips the repo privacy gate even inside a test fixture.
const fakeKey = (c) => `sk-${c.repeat(24)}`;

test('scanForSecrets labels the first pattern hit; clean text passes', () => {
  assert.equal(scanForSecrets(`token = ${fakeKey('a')}`), 'openai_key');
  assert.equal(scanForSecrets('-----BEGIN RSA PRIVATE KEY-----'), 'private_key');
  assert.equal(scanForSecrets('ordinary log line'), null);
  assert.equal(scanForSecrets(''), null);
  assert.equal(scanForSecrets(null), null);
});

test('redactSecrets removes every hit and keeps surrounding content', () => {
  const raw = `key1=${fakeKey('x')} key2=${fakeKey('y')} done`;
  const out = redactSecrets(raw);
  assert.equal(out.includes('sk-'), false, 'no key bytes survive');
  assert.match(out, /\[REDACTED:openai_key\]/);
  assert.match(out, /key1=/);
  assert.match(out, /done/);
  // non-string and clean input pass through untouched
  assert.equal(redactSecrets('clean output'), 'clean output');
  assert.equal(redactSecrets(null), null);
});
