/**
 * dedup-h #2177 — cryptostore DPAPI helper: real roundtrip when the platform
 * supports ProtectedData, honest nulls otherwise.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dpapiAvailable, dpapiEncrypt, dpapiDecrypt } from '../src/core/cryptostore.js';

test('dpapiAvailable probes a real roundtrip; encrypt/decrypt are consistent', () => {
  const ok = dpapiAvailable();
  if (!ok) {
    // non-Windows / no powershell — helper degrades honestly to null
    assert.equal(dpapiEncrypt('x'), null);
    assert.equal(dpapiDecrypt('AAAA'), null);
    return;
  }
  const blob = dpapiEncrypt('s3cr3t-tok3n');
  assert.ok(blob && !blob.includes('s3cr3t'), 'ciphertext never contains plaintext');
  assert.equal(dpapiDecrypt(blob), 's3cr3t-tok3n');
  // wrong-blob decrypt → null, never a partial guess
  assert.equal(dpapiDecrypt('aGVsbG8='), null);
});
