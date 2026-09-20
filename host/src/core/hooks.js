/**
 * Typed lifecycle hooks (G5) — operator-configured commands fired at
 * whitelisted lifecycle events.
 *
 * Deliberate boundary: hooks are OBSERVATIONAL ONLY. They never sit in the
 * decide path — hook config lives in the workdir (.pai/hooks.json), which
 * the agent itself can write; letting a workdir file veto tool calls would
 * make the agent its own gatekeeper. Blocking policy stays in the canonical
 * kernel, hooks stay a notification edge.
 *
 * Config: <workdir>/.pai/hooks.json
 *   { "hooks": { "session_start": [{ "command": "...", "timeoutMs": 8000 }],
 *                "prompt_submit": [...], "tool_end": [...], "session_end": [...] } }
 *
 * Each fire: spawn via the platform shell in the workdir, JSON event payload
 * on stdin, timeout, audit HOOK_FIRE / HOOK_RESULT / HOOK_ERROR. Unknown
 * event names in config are refused at load (typo = silently dead hook is
 * worse than a loud error). Failures never block the lifecycle — a broken
 * hook must not wedge the session.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const HOOK_EVENTS = new Set(['session_start', 'prompt_submit', 'tool_end', 'session_end']);
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_CHARS = 4000;

export class HookRunner {
  /**
   * @param {string} workdir
   * @param {object} [deps.audit]  AuditWriter
   * @param {object} [deps.env]    base environment (test injection)
   */
  constructor(workdir, { audit = null, env = process.env } = {}) {
    this.workdir = workdir;
    this.audit = audit;
    this.env = env;
    this.configPath = join(workdir, '.pai', 'hooks.json');
    this.hooks = this.#load();
  }

  #load() {
    if (!existsSync(this.configPath)) return {};
    const doc = JSON.parse(readFileSync(this.configPath, 'utf-8')); // throws = loud, operator's file
    const hooks = doc?.hooks ?? {};
    for (const name of Object.keys(hooks)) {
      if (!HOOK_EVENTS.has(name)) {
        throw new Error(`hooks.json: unknown lifecycle event '${name}' — valid: ${[...HOOK_EVENTS].join(', ')}`);
      }
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

  #closed = false;
  #children = new Set();

  #run(command, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, {
        cwd: this.workdir,
        shell: true,
        windowsHide: true,
        env: { ...this.env, PAI_HOOK_EVENT: payload.event ?? '' },
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
      const timer = setTimeout(() => {
        killTree();
        dropPipes();
        reject(new Error(`hook timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      child.on('error', (e) => { clearTimeout(timer); this.#children.delete(child); dropPipes(); reject(e); });
      child.on('exit', (code) => { clearTimeout(timer); this.#children.delete(child); dropPipes(); resolve({ code, tail: out }); });
      child.unref?.();
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
