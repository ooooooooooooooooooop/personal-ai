/**
 * Typed lifecycle hooks (G5) — operator-configured commands fired at
 * whitelisted lifecycle events.
 *
 * Deliberate boundary: the workdir file (.pai/hooks.json) is OBSERVATIONAL
 * ONLY — the agent can write it, so it must never veto its own calls.
 * Blocking policy stays in the canonical kernel.
 *
 * Gate mode (Claude Code PreToolUse analogue): a second runner pointed at the
 * OPERATOR-PRIVATE file <instance>/hooks.json with { gate: true }. Gate mode
 * unlocks one extra event, 'pre_tool', fired inside the decide chain — a hook
 * exit≠0, or stdout JSON {"deny":"reason"}, refuses the call. The agent cannot
 * reach the instance dir, so this gate is a real operator veto, not self-
 * gatekeeping. Gate hooks re-read the file per fire (operator edits apply
 * live) and fail CLOSED: timeout/spawn error denies the call.
 *
 * Trust asymmetry between the two configs:
 *  - the observational file is agent-REACHABLE (a .pai/ write escalates to one
 *    operator ask — an approval under prompt-injection pressure is plausible),
 *    so it is treated as untrusted input: (a) hook processes get a SCRUBBED
 *    environment — keys matching KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL/AUTH are
 *    removed, because an approved hook has no legitimate need for provider
 *    credentials and a full-env spawn is an exfiltration channel; (b) a
 *    malformed/unrecognized config is audited (HOOK_CONFIG_ERROR) and skipped,
 *    never thrown — one approved bad write must not brick the next bootstrap.
 *  - the gate file is operator-private: full environment, malformed config
 *    throws loud at load and fails closed per fire.
 *
 * Config: <workdir>/.pai/hooks.json  (observational)
 *         <instance>/hooks.json      (gate, operator-private)
 *   { "hooks": { "session_start": [{ "command": "...", "timeoutMs": 8000 }],
 *                "prompt_submit": [...], "tool_end": [...], "session_end": [...],
 *                "pre_tool": [{ "command": "...", "match": "bash", "timeoutMs": 5000 }] } }
 *   'match' (gate only): optional tool-name prefix filter — hook only runs
 *   for tools whose name starts with it.
 *
 * Each fire: spawn via the platform shell in the workdir, JSON event payload
 * on stdin, timeout, audit HOOK_FIRE / HOOK_RESULT / HOOK_ERROR. Unknown
 * event names in config are refused at load (typo = silently dead hook is
 * worse than a loud error). Observational failures never block the lifecycle.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const HOOK_EVENTS = new Set([
  'session_start', 'prompt_submit', 'session_end',
  'tool_start', 'tool_end', 'agent_stop',
  'compact_start', 'compact_end',
]);
export const GATE_EVENTS = new Set(['pre_tool']);
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_CHARS = 4000;

// Secret-looking environment keys withheld from OBSERVATIONAL hook processes.
// The workdir config is agent-reachable (one approved .pai/ write away); a
// full-env spawn turns it into a credential-exfiltration channel. Gate hooks
// (operator-private file) keep the full environment — the operator owns both
// the config and the consequences. GIT_AUTHOR_* survives: 'AUTHOR' is not
// matched by the AUTH alternative (requires _ or end after AUTH).
const SECRET_ENV_RE = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|(?:^|_)AUTH(?:_|$)/i;

export function scrubHookEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (!SECRET_ENV_RE.test(k)) out[k] = v;
  }
  return out;
}

export class HookRunner {
  /**
   * @param {string} workdir
   * @param {object} [deps.audit]      AuditWriter
   * @param {object} [deps.env]        base environment (test injection)
   * @param {string} [deps.configPath] override config location (gate runners
   *                                   point at the operator-private instance file)
   * @param {boolean} [deps.gate]      enable the 'pre_tool' veto event
   */
  constructor(workdir, { audit = null, env = process.env, configPath = null, gate = false } = {}) {
    this.workdir = workdir;
    this.audit = audit;
    this.env = env;
    this.gate = gate;
    this.configPath = configPath ?? join(workdir, '.pai', 'hooks.json');
    this.hooks = this.#load();
  }

  #load() {
    if (!existsSync(this.configPath)) return {};
    let doc;
    try {
      doc = JSON.parse(readFileSync(this.configPath, 'utf-8'));
    } catch (err) {
      if (this.gate) throw err; // operator's own file — loud at load
      // Agent-reachable config is untrusted input: a bad write must not
      // brick the next bootstrap. Audit and run with no hooks.
      this.audit?.write({ kind: 'HOOK_CONFIG_ERROR', data: { error: String(err?.message ?? err).slice(0, 300), ignored: true } });
      return {};
    }
    const hooks = doc?.hooks ?? {};
    const allowed = this.gate ? new Set([...HOOK_EVENTS, ...GATE_EVENTS]) : HOOK_EVENTS;
    const bad = Object.keys(hooks).filter((name) => !allowed.has(name));
    if (bad.length) {
      if (this.gate) {
        throw new Error(`hooks.json: unknown lifecycle event '${bad[0]}' — valid: ${[...allowed].join(', ')}`);
      }
      // Untrusted config: reject the unknown events (a 'pre_tool' entry here
      // is an agent trying to veto itself), keep the valid ones, stay loud
      // in the audit trail instead of crashing the lifecycle.
      this.audit?.write({ kind: 'HOOK_CONFIG_ERROR', data: { rejectedEvents: bad, valid: [...HOOK_EVENTS].join(',') } });
      for (const name of bad) delete hooks[name];
    }
    return hooks;
  }

  /** Configured event names — for surfaces that report hook coverage. */
  get events() { return Object.keys(this.hooks); }

  /**
   * Fire all hooks for an event. Async, never throws, never blocks results.
   * @returns {Promise<number>} how many hook commands ran
   */
  async fire(event, payload = {}) {
    const entries = this.hooks[event] ?? [];
    if (!entries.length || this.#closed) return 0;
    let ran = 0;
    for (const h of entries) {
      if (typeof h?.command !== 'string' || !h.command.trim()) continue;
      ran++;
      const timeoutMs = h.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      this.audit?.write({ kind: 'HOOK_FIRE', data: { event, command: h.command.slice(0, 200) } });
      try {
        const r = await this.#run(h.command, { event, ...payload }, timeoutMs);
        this.audit?.write({ kind: 'HOOK_RESULT', data: { event, exitCode: r.code, tail: r.tail.slice(0, 500) } });
      } catch (err) {
        this.audit?.write({ kind: 'HOOK_ERROR', data: { event, error: String(err?.message ?? err).slice(0, 300) } });
      }
    }
    return ran;
  }

  /**
   * Gate fire (pre_tool veto). Returns { deny: reason } on refusal, null when
   * the call may proceed. Fails CLOSED — a broken/timed-out veto hook denies,
   * never silently passes. Config is re-read per fire so operator edits apply
   * without a session rebuild.
   */
  async fireGate(event, payload = {}) {
    if (!this.gate) throw new Error('fireGate on a non-gate HookRunner — observational hooks cannot veto');
    this.hooks = this.#load(); // live re-read: operator edits apply immediately
    const entries = (this.hooks[event] ?? []).filter((h) =>
      typeof h?.command === 'string' && h.command.trim()
      && (typeof h.match !== 'string' || String(payload.tool ?? '').startsWith(h.match)));
    for (const h of entries) {
      const timeoutMs = h.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      this.audit?.write({ kind: 'HOOK_FIRE', data: { event, gate: true, command: h.command.slice(0, 200) } });
      try {
        const r = await this.#run(h.command, { event, ...payload }, timeoutMs);
        this.audit?.write({ kind: 'HOOK_RESULT', data: { event, gate: true, exitCode: r.code, tail: r.tail.slice(0, 500) } });
        // stdout JSON {"deny":"reason"} is the structured refusal; a bare
        // non-zero exit refuses with the output tail as the reason.
        let structured = null;
        try { structured = JSON.parse(r.tail.trim().split('\n').pop() ?? ''); } catch { /* not JSON */ }
        if (structured && typeof structured.deny === 'string' && structured.deny.trim()) {
          return { deny: structured.deny.slice(0, 500) };
        }
        if (r.code !== 0) {
          return { deny: `pre_tool hook exited ${r.code}: ${r.tail.trim().slice(0, 300) || 'no output'}` };
        }
      } catch (err) {
        this.audit?.write({ kind: 'HOOK_ERROR', data: { event, gate: true, error: String(err?.message ?? err).slice(0, 300) } });
        return { deny: `pre_tool hook failed closed: ${String(err?.message ?? err).slice(0, 200)}` };
      }
    }
    return null;
  }

  #closed = false;
  #children = new Set();

  #run(command, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, {
        cwd: this.workdir,
        shell: true,
        windowsHide: true,
        env: { ...(this.gate ? this.env : scrubHookEnv(this.env)), PAI_HOOK_EVENT: payload.event ?? '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.#children.add(child);
      let out = '';
      child.stdout.on('data', (c) => { if (out.length < MAX_OUTPUT_CHARS) out += c; });
      child.stderr.on('data', (c) => { if (out.length < MAX_OUTPUT_CHARS) out += c; });
      const dropPipes = () => { child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy(); };
      // shell:true spawns cmd.exe; killing it alone orphans the real command
      // (which holds our pipes). Kill the whole tree: taskkill /T on Windows.
      const killTree = () => {
        if (process.platform === 'win32') {
          try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).unref(); }
          catch { try { child.kill(); } catch { /* gone */ } }
        } else {
          try { child.kill('SIGKILL'); } catch { /* gone */ }
        }
      };
      // The timeout timer owns this pending Promise: keep the event loop
      // alive until it fires or the child exits. Unref'ing timer/child lets
      // the loop drain while the caller is still suspended (win32: unref on
      // the child also drops its stdio pipes).
      const timer = setTimeout(() => {
        killTree();
        dropPipes();
        reject(new Error(`hook timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.on('error', (e) => { clearTimeout(timer); this.#children.delete(child); dropPipes(); reject(e); });
      child.on('exit', (code) => { clearTimeout(timer); this.#children.delete(child); dropPipes(); resolve({ code, tail: out }); });
      child.stdin.on('error', () => {});
      try {
        child.stdin.write(JSON.stringify(payload));
        child.stdin.end();
      } catch { /* stdin gone — exit/error path handles */ }
    });
  }

  /** Kill in-flight hooks (session teardown). */
  close() {
    this.#closed = true;
    for (const c of this.#children) {
      if (process.platform === 'win32') {
        try { spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).unref(); }
        catch { try { c.kill(); } catch { /* gone */ } }
      } else {
        try { c.kill('SIGKILL'); } catch { /* gone */ }
      }
      c.stdout?.destroy(); c.stderr?.destroy(); c.stdin?.destroy();
    }
    this.#children.clear();
  }
}
