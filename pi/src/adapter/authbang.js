// dedup-h #1293 — `!command` credentials in auth.json: an api_key entry whose
// `key` starts with '!' is shell-evaluated at session build and the resolved
// value is injected via setRuntimeApiKey — the runtime credential wins over
// the stored one, so the plaintext secret never lands in auth.json.
//
// Trust posture: auth.json is operator-owned (same domain as hooks.json), so
// the command runs through the real shell — but with the hook-scrubbed env
// (no session/injected secrets leak into the eval), a 15s timeout and a
// 64KB output cap. A failed or empty eval is fail-closed honest: the literal
// '!cmd' stays stored and provider calls 401 visibly — we audit, we never
// silently substitute anything.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scrubHookEnv } from '../../../host/src/core/hooks.js';

const BANG_TIMEOUT_MS = 15_000;
const BANG_MAX_OUTPUT = 64 * 1024;

export function evalBangCommand(command, { spawnFn = spawnSync, env = process.env } = {}) {
  const cmd = String(command ?? '').trim();
  if (!cmd) throw new Error('empty !command');
  const shell = process.platform === 'win32' ? (env.ComSpec ?? 'cmd.exe') : '/bin/sh';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', cmd] : ['-c', cmd];
  const r = spawnFn(shell, args, {
    env: scrubHookEnv(env), timeout: BANG_TIMEOUT_MS, maxBuffer: BANG_MAX_OUTPUT,
    windowsHide: true, encoding: 'utf-8',
  });
  if (r?.error) throw r.error;
  if (r?.status !== 0) throw new Error(`!command exited ${r?.status ?? 'unknown'}: ${String(r?.stderr ?? '').slice(0, 200)}`);
  const out = String(r?.stdout ?? '').trim();
  if (!out) throw new Error('!command produced empty output');
  return out;
}

/** Resolve every `!` credential ref into the runtime. Two operator-owned
 * files are scanned (dedup-h #1294 added the models.json provider surface):
 *   - auth.json:   { <providerId>: { type:'api_key', key:'!cmd' } }
 *   - models.json: { providers: { <providerId>: { apiKey:'!cmd' } } }
 * `!` wins over `$ENV` semantics for that entry — a '!' prefix is never a
 * valid literal key anyway. */
export async function applyBangAuth(agentDir, modelRuntime, audit, { spawnFn, env } = {}) {
  let resolved = 0, failed = 0;
  const evalInto = async (providerId, command) => {
    try {
      const value = evalBangCommand(command, { spawnFn, env });
      await modelRuntime?.setRuntimeApiKey?.(providerId, value);
      resolved += 1;
      audit?.write({ kind: 'AUTH_BANG_RESOLVED', data: { provider: providerId, command: command.slice(0, 120) } });
    } catch (e) {
      failed += 1;
      // fail-closed loud: the literal '!cmd' stays stored, calls 401 visibly
      audit?.write({ kind: 'AUTH_BANG_FAILED', data: { provider: providerId, command: command.slice(0, 120), error: String(e?.message ?? e).slice(0, 200) } });
    }
  };
  // auth.json — credential store
  const authPath = join(agentDir, 'auth.json');
  if (existsSync(authPath)) {
    let doc = null;
    try { doc = JSON.parse(readFileSync(authPath, 'utf-8')); } catch { doc = null; }
    for (const [providerId, cred] of Object.entries(doc ?? {})) {
      const key = cred?.type === 'api_key' ? cred.key : null;
      if (typeof key !== 'string' || !key.startsWith('!')) continue;
      await evalInto(providerId, key.slice(1).trim());
    }
  }
  // models.json — provider-config apiKey field (#1294)
  const modelsPath = join(agentDir, 'models.json');
  if (existsSync(modelsPath)) {
    let doc = null;
    try { doc = JSON.parse(readFileSync(modelsPath, 'utf-8')); } catch { doc = null; }
    for (const [providerId, spec] of Object.entries(doc?.providers ?? {})) {
      const key = spec?.apiKey;
      if (typeof key !== 'string' || !key.startsWith('!')) continue;
      await evalInto(providerId, key.slice(1).trim());
    }
  }
  return { resolved, failed };
}
