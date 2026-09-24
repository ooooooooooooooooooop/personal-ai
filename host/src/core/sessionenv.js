/**
 * Session-scoped environment overlay (M121) + shell env snapshot (M122).
 *
 * The overlay is consulted by every child process WE spawn — durable jobs,
 * hooks, verifier commands, delegate bridges. It never reaches inside the
 * engine's own tool processes (bash tool spawns are engine-internal); that
 * boundary is honest: session env shapes our children, not the engine's.
 *
 * Safety: env keys that bootstrap code into a runtime or hijack resolution
 * (NODE_OPTIONS, PATH, LD_PRELOAD, proxy vars, GIT_SSH_COMMAND…) are a hard
 * refuse — the same injection vector the MCP adapter strips at its spawn
 * boundary. A session overlay must not reopen it. Setting ordinary keys
 * (including credentials for child tools) is allowed, audited, and masked
 * in list output.
 */
export const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Injection-vector keys — keep in step with pi/extensions/mcp/index.js
// ENV_INJECT_RE (separate layers, same policy primitive).
export const ENV_INJECT_RE = /^(?:NODE_OPTIONS|NODE_EXTRA_CA_CERTS|NODE_PATH|PATH|PATHEXT|COMSPEC|LD_[A-Z0-9_]+|DYLD_[A-Z0-9_]+|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PYTHONINSPECT|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|BASH_ENV|ENV|CDPATH|GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|SSH_ASKPASS|GIT_EXTERNAL_DIFF|GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS|GIT_EDITOR|EDITOR|VISUAL|PAGER|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|NPM_CONFIG_[A-Z0-9_]*)$/i;

const SECRET_ENV_RE = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|(?:^|_)AUTH(?:_|$)/i;

export class SessionEnv {
  constructor({ audit = null } = {}) {
    this.audit = audit;
    this.vars = new Map();
    this.secrets = new Set(); // keys masked unconditionally (credential_request path)
  }

  set(key, value) {
    const k = String(key ?? '');
    if (!KEY_RE.test(k)) return { ok: false, reason: `invalid env key '${k.slice(0, 40)}'` };
    if (ENV_INJECT_RE.test(k)) {
      this.audit?.write({ kind: 'ENV_SET_REFUSED', data: { key: k, rule: 'env_injection' } });
      return { ok: false, reason: `'${k}' is a code-injection/hijack vector — session env cannot set loader, path-resolution, proxy, or shell-startup keys` };
    }
    this.vars.set(k, String(value ?? ''));
    this.audit?.write({ kind: 'ENV_SET', data: { key: k, sensitive: SECRET_ENV_RE.test(k) } });
    return { ok: true };
  }

  /**
   * setSecret — credential_request channel: the operator typed the value
   * into a masked card; it must NEVER be readable back through list(),
   * whatever the key is named. The value itself is never audited.
   */
  setSecret(key, value) {
    const r = this.set(key, value);
    if (!r.ok) return r;
    this.secrets.add(key);
    return r;
  }

  unset(key) {
    const k = String(key ?? '');
    const had = this.vars.delete(k);
    this.secrets.delete(k);
    if (had) this.audit?.write({ kind: 'ENV_UNSET', data: { key: k } });
    return { ok: true, removed: had };
  }

  clear() {
    const n = this.vars.size;
    this.vars.clear();
    this.secrets.clear();
    if (n) this.audit?.write({ kind: 'ENV_CLEARED', data: { count: n } });
    return { ok: true, removed: n };
  }

  /** list() masks secret-looking values — the read surface never leaks them. */
  list() {
    return [...this.vars.entries()].map(([key, value]) => ({
      key,
      value: SECRET_ENV_RE.test(key) || this.secrets.has(key) ? '[REDACTED]' : value,
      sensitive: SECRET_ENV_RE.test(key) || this.secrets.has(key),
    }));
  }

  /** view() — the real values, for spawn-time merge only. */
  view() {
    return Object.fromEntries(this.vars);
  }
}

/**
 * M122 shell env snapshot: capture the effective child-process environment
 * (operator env + session overlay) with credential values masked. The
 * snapshot is diagnostic/shareable evidence — secrets never leave as
 * plaintext. `redacted` names which keys were masked — a consumer sees
 * "unset" vs "set but hidden" distinctly.
 */
export function captureEnvSnapshot({ env = {}, overlay = {}, platform = process.platform, cwd = null, at = null } = {}) {
  const merged = { ...env, ...overlay };
  const vars = {};
  const redacted = [];
  for (const [k, v] of Object.entries(merged)) {
    if (SECRET_ENV_RE.test(k)) { vars[k] = '[REDACTED]'; redacted.push(k); }
    else vars[k] = String(v);
  }
  return {
    capturedAt: at ?? new Date().toISOString(),
    platform,
    cwd,
    overlayKeys: Object.keys(overlay).sort(),
    count: Object.keys(vars).length,
    redacted: redacted.sort(),
    vars,
  };
}
