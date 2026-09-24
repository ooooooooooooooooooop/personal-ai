/**
 * Pluggable secret sources (dedup-h #820 — Hermes-style Bitwarden/1Password
 * integration): a value written as `op://<vault>/<item>/<field>` or
 * `bw://<item>[/<field>]` is resolved through the operator's password-manager
 * CLI instead of living in plaintext config/.env.
 *
 * Fail-closed contract:
 * - a scheme resolves ONLY when <instance>/secrets.json enables it:
 *     {"sources": {"op": {"bin": "op"}, "bw": {"bin": "bw", "items": ["prod/"]}}}
 *   `bin` defaults to the scheme name; `items` is an optional allowlist of
 *   item-path prefixes (op: "<vault>/<item>", bw: "<item>") — without it any
 *   item the CLI can read is resolvable, which is the operator's choice.
 * - the resolved value is returned for the caller to store as a SECRET —
 *   this module never echoes it into a reason/log string itself.
 * - CLI is spawned via execFileSync with an args array (no shell), a 15s
 *   timeout, a 256KB output cap, and a minimized environment (PATH/HOME and
 *   the CLIs' own session vars only).
 * - unknown scheme, missing config, missing CLI, nonzero exit, timeout, or a
 *   field absent from the Bitwarden item all resolve to {ok:false} — never
 *   to a guessed plaintext value.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMES = new Set(['op', 'bw']);
const REF_RE = /^(op|bw):\/\/([^/\s]+)(?:\/([^/\s]+))?(?:\/([^/\s]+))?$/;
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 256 * 1024;
const ENV_KEYS = [
  'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME',
  'BW_SESSION', 'BW_CLIENTID', 'BW_CLIENTSECRET',
  'OP_SERVICE_ACCOUNT_TOKEN', 'OP_CONNECT_HOST', 'OP_CONNECT_TOKEN', 'OP_ACCOUNT',
];

export function parseSecretRef(value) {
  if (typeof value !== 'string') return null;
  const m = REF_RE.exec(value.trim());
  if (!m) return null;
  const [, scheme, a, b, c] = m;
  if (!SCHEMES.has(scheme)) return null;
  if (scheme === 'op') {
    if (!a || !b || !c) return null; // op://vault/item/field — all three required
    return { scheme, vault: a, item: b, field: c, itemKey: `${a}/${b}` };
  }
  // bw://<item> or bw://<item>/<field>; nested item names keep the middle.
  return { scheme, item: a, field: [b, c].filter(Boolean).join('/') || null, itemKey: a };
}

export function loadSecretSources(instanceRoot) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(join(instanceRoot, 'secrets.json'), 'utf-8'));
  } catch (e) {
    if (e?.code === 'ENOENT') return {};
    throw new Error(`secrets.json: ${e.message}`);
  }
  const out = {};
  for (const [scheme, cfg] of Object.entries(doc?.sources ?? {})) {
    if (!SCHEMES.has(scheme) || !cfg || cfg.enabled === false) continue;
    out[scheme] = {
      bin: typeof cfg.bin === 'string' && cfg.bin ? cfg.bin : scheme,
      items: Array.isArray(cfg.items) ? cfg.items.map(String) : null,
    };
  }
  return out;
}

const minimalEnv = () => {
  const env = {};
  for (const k of ENV_KEYS) if (process.env[k]) env[k] = process.env[k];
  return env;
};

const runCli = (bin, args, spawnFn) => {
  const fn = spawnFn ?? execFileSync;
  return fn(bin, args, {
    encoding: 'utf-8', timeout: TIMEOUT_MS, maxBuffer: MAX_BYTES,
    env: minimalEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
};

const fail = (reason, meta = {}) => ({ ok: false, reason, ...meta });

/**
 * Resolve `op://`/`bw://` refs through the configured CLI.
 * @returns {{ok:true, value:string, scheme:string, item:string} | {ok:false, reason:string}}
 */
export function resolveSecretRef(ref, { instanceRoot, spawnFn = null, sources = null } = {}) {
  const parsed = parseSecretRef(ref);
  if (!parsed) return fail('not a secret reference');
  const srcs = sources ?? (instanceRoot ? loadSecretSources(instanceRoot) : {});
  const cfg = srcs[parsed.scheme];
  if (!cfg) {
    return fail(`secret source '${parsed.scheme}' is not enabled in secrets.json`, { scheme: parsed.scheme });
  }
  if (cfg.items && !cfg.items.some((p) => parsed.itemKey.startsWith(p))) {
    return fail(`item '${parsed.itemKey.slice(0, 80)}' is not in the secrets.json allowlist`, { scheme: parsed.scheme, item: parsed.itemKey });
  }
  try {
    if (parsed.scheme === 'op') {
      const out = runCli(cfg.bin, ['read', ref.trim()], spawnFn);
      const value = String(out).trim();
      if (!value) return fail('op read returned an empty secret', { scheme: 'op', item: parsed.itemKey });
      return { ok: true, value, scheme: 'op', item: parsed.itemKey };
    }
    const out = runCli(cfg.bin, ['get', 'item', parsed.item], spawnFn);
    const item = JSON.parse(String(out));
    const field = parsed.field ?? 'password';
    let value;
    if (field === 'password' || field === 'username') value = item?.login?.[field];
    else if (field === 'notes' || field === 'note') value = item?.notes;
    else value = (item?.fields ?? []).find((f) => f?.name === field)?.value;
    if (!value) return fail(`bitwarden item '${parsed.item}' has no field '${field}'`, { scheme: 'bw', item: parsed.itemKey });
    return { ok: true, value, scheme: 'bw', item: parsed.itemKey };
  } catch (e) {
    if (e?.code === 'ENOENT') return fail(`secret CLI '${cfg.bin}' not found on PATH`, { scheme: parsed.scheme });
    if (e?.killed || e?.signal === 'SIGTERM' || /timed out/i.test(String(e?.message))) {
      return fail(`secret CLI '${cfg.bin}' timed out after ${TIMEOUT_MS / 1000}s`, { scheme: parsed.scheme });
    }
    return fail(`secret CLI '${cfg.bin}' failed: ${String(e?.message).slice(0, 200)}`, { scheme: parsed.scheme });
  }
}
