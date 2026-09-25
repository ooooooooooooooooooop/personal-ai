/**
 * cryptostore.js — at-rest encryption helper (dedup-h #2177: upstream
 * "encrypted local storage for CLI/MCP OAuth credentials").
 *
 * DPAPI `CurrentUser`-scope encrypt/decrypt via PowerShell's
 * System.Security.Cryptography.ProtectedData — zero npm deps on Windows;
 * `dpapiAvailable()` is false on platforms without it so callers can fall
 * back honestly instead of pretending encryption.
 *
 * Secrets ride the PAI_DPAPI_INPUT env var, never argv — command lines are
 * world-readable in process listings, env is not (same-uid only).
 *
 * Contract: every function is best-effort null on failure — the CALLER
 * decides whether a missing ciphertext means "store plaintext" or "refuse
 * to write" (fail-closed is the caller's posture, not this helper's).
 */
import { spawnSync } from 'node:child_process';

const PS_BIN = process.env.PAI_DPAPI_PS
  ?? (process.platform === 'win32' ? 'powershell.exe' : 'pwsh');
const ENC_SCRIPT =
  '[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect(' +
  '[System.Text.Encoding]::UTF8.GetBytes($env:PAI_DPAPI_INPUT), $null, \'CurrentUser\'))';
const DEC_SCRIPT =
  '[System.Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect(' +
  '[Convert]::FromBase64String($env:PAI_DPAPI_INPUT), $null, \'CurrentUser\'))';
const TIMEOUT_MS = 8_000;
const MAX_BUFFER = 4 * 1024 * 1024;

const run = (script, input) => {
  try {
    const r = spawnSync(PS_BIN, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, PAI_DPAPI_INPUT: String(input) },
      encoding: 'utf-8', timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_BUFFER,
    });
    if (r.error || r.status !== 0) return null;
    return r.stdout.trim();
  } catch { return null; }
};

let probe = null;
/** True when a ProtectedData roundtrip actually works on this platform. */
export function dpapiAvailable() {
  if (probe === null) {
    const blob = run(ENC_SCRIPT, 'cryptostore-probe');
    probe = blob != null && run(DEC_SCRIPT, blob) === 'cryptostore-probe';
  }
  return probe;
}

/** @returns {string|null} base64 ciphertext, or null when DPAPI is absent/failed. */
export function dpapiEncrypt(plaintext) {
  return dpapiAvailable() ? run(ENC_SCRIPT, plaintext) : null;
}

/** @returns {string|null} decrypted plaintext, or null on failure/wrong user. */
export function dpapiDecrypt(b64) {
  return dpapiAvailable() ? run(DEC_SCRIPT, b64) : null;
}

/** Test seam — reset the cached platform probe (e.g. after env change). */
export function _resetProbeForTests() { probe = null; }
