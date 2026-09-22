/**
 * js_repl — M114 persistent JavaScript REPL tool.
 *
 * A single node child (`jsrepl-worker.js`) per session keeps a vm context
 * alive across calls: variables, functions, imports declared in one call are
 * visible to the next — the difference between a REPL and `node -e`.
 *
 * Governance: js_repl is exec-class by construction — its whole payload is
 * code. decide.js maps it onto the policy's `exec` risk action and takes the
 * write lease, the same posture `bash` gets; no tool-specific carve-out.
 * The child's env is secret-scrubbed (same discipline as observational
 * hooks): model-authored code must not read operator credentials out of
 * process.env and print them into the transcript.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubHookEnv } from '../../../host/src/core/hooks.js';

const WORKER = join(dirname(fileURLToPath(import.meta.url)), 'jsrepl-worker.js');
const RESULT_CAP = 32 * 1024;
const CALL_TIMEOUT_MS = 20_000;

const err = (text) => ({ content: [{ type: 'text', text }], isError: true });
const ok = (text, details) => ({ content: [{ type: 'text', text }], details });

export function jsReplTool({ workdir, env = process.env, envOverlay = null } = {}) {
  let child = null;
  let seq = 0;
  let restarts = 0;
  const pending = new Map();
  let buf = '';

  const spawnWorker = () => {
    // Scrub FIRST, overlay second (M121): an operator-set env key is
    // intentional and applies; ambient secrets never reach model code.
    const childEnv = { ...scrubHookEnv(env), ...(envOverlay?.() ?? {}), PAI_REPL_WORKDIR: workdir };
    const c = spawn(process.execPath, [WORKER], {
      cwd: workdir,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    c.stdout.setEncoding('utf-8');
    c.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); p.resolve(msg); }
      }
    });
    c.stderr.on('data', () => {});
    // An unhandled 'error' on the child or its stdin CRASHES THE HOST (Node
    // throws unhandled EventEmitter errors) — a spawn failure (EACCES) or an
    // EPIPE writing to a dying worker must degrade to a dead-REPL respawn.
    c.on('error', () => {});
    c.stdin.on('error', () => {});
    c.on('exit', () => {
      // fail-closed per call: every in-flight eval answers an honest error
      // instead of hanging; the next call respawns the worker fresh.
      // Only flush pending when the dead child is still the CURRENT one —
      // a restart's old child exits after its replacement took over, and
      // must not resolve the new worker's calls as died.
      if (child !== c) return;
      child = null;
      for (const [, p] of pending) p.resolve({ died: true });
      pending.clear();
    });
    child = c;
    return c;
  };

  return {
    name: 'js_repl',
    label: 'JS REPL',
    description:
      'Evaluate JavaScript in a PERSISTENT node session — declarations and imports ' +
      'survive between calls (vs one-shot bash node -e). Runs in the workspace with ' +
      'a scrubbed environment. Exec-class: governed like bash.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript to evaluate (expressions print their value)' },
        restart: { type: 'boolean', description: 'kill and restart the REPL session first (clears state)' },
      },
      required: ['code'],
    },
    async execute(_id, params) {
      const code = String(params?.code ?? '');
      if (!code.trim()) return err('js_repl: code is required');
      if (params?.restart === true && child) { child.kill(); child = null; }
      // spawnWorker() sets `child` as a side effect, so `child ?? spawnWorker()`
      // followed by `if (child == null) restarts++` could never count — test
      // BEFORE spawning.
      let c = child;
      if (!c) { restarts++; c = spawnWorker(); }
      const id = ++seq;
      const reply = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (pending.delete(id)) {
            // the worker may be wedged on sync code the vm timeout cannot
            // interrupt (atomics, infinite native loop) — kill it; next call
            // respawns fresh rather than queuing behind a dead REPL
            c.kill();
            resolve({ timedOut: true });
          }
        }, CALL_TIMEOUT_MS);
        pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); } });
        try { c.stdin.write(JSON.stringify({ id, code }) + '\n'); }
        catch (e) { pending.delete(id); clearTimeout(timer); resolve({ died: true, err: String(e?.message ?? e) }); }
      });
      if (reply.died || reply.timedOut) {
        return err(`js_repl worker ${reply.timedOut ? `timed out (> ${CALL_TIMEOUT_MS}ms) — killed; next call starts a fresh session` : `died mid-eval${reply.err ? ` (${reply.err})` : ''} — next call respawns it`}`);
      }
      const parts = [];
      if (reply.stdout) parts.push(reply.stdout.trimEnd());
      if (reply.ok === false) parts.push(`ERROR: ${reply.result}`);
      else if (reply.result !== undefined) parts.push(`=> ${reply.result}`);
      if (reply.stderr) parts.push(`stderr: ${reply.stderr.trimEnd()}`);
      const text = parts.join('\n') || '(no output)';
      return ok(text.length > RESULT_CAP ? text.slice(0, RESULT_CAP) + `\n[result capped at ${RESULT_CAP} chars]` : text,
        { evalId: id, restarts, ok: reply.ok !== false });
    },
    dispose() { child?.kill(); child = null; },
  };
}
