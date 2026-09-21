/**
 * Post-write verify reflection loop (Aider lint/test analogue):
 * `.pai/verify.json` `{ "onWrite": "npm run lint", "timeoutMs": 60000 }` arms a
 * project verifier — every successful write/edit/delete runs it once (burst-
 * coalesced), and a non-zero exit lands in the observation stream so the
 * failure reflects back into the model's context on the next turn.
 *
 * Security: the config file is agent-writable, so the configured command is
 * classified with the SAME shell classifier + policy riskActions as a model
 * tool call — a verifier whose command would be denied or need an ask is
 * refused at arm time (VERIFY_REFUSED audit). Self-authored configs can never
 * exec more than policy already allows.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BURST_MS = 5_000;
const OUT_CAP = 64 * 1024;

function runBounded(command, cwd, timeoutMs) {
  return new Promise((resolveP) => {
    let child;
    try {
      child = spawn(command, { shell: true, cwd, windowsHide: true });
    } catch (e) {
      resolveP({ code: -1, output: String(e?.message ?? e) });
      return;
    }
    let out = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGTERM'); }, timeoutMs);
    const eat = (d) => { if (out.length < OUT_CAP) out += d.toString('utf-8'); };
    child.stdout.on('data', eat);
    child.stderr.on('data', eat);
    child.on('error', (e) => { clearTimeout(timer); resolveP({ code: -1, output: String(e?.message ?? e) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveP({ code: killed ? -9 : (code ?? -1), output: out + (killed ? '\n[killed: verify timeout]' : '') });
    });
  });
}

export function createVerifier({ workdir, classify, riskActions, audit = null, emit = null, observations = null }) {
  const configPath = join(workdir, '.pai', 'verify.json');
  let lastRun = 0;

  return {
    configPath,
    /** Read the armed command without running anything (UI/debug surface). */
    status() {
      let cfg = null;
      try { cfg = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { /* absent/invalid */ }
      return { armed: Boolean(cfg?.onWrite), command: cfg?.onWrite ?? null };
    },
    /** Run the verifier once after a successful write-family tool call. */
    async afterWrite() {
      const now = Date.now();
      if (now - lastRun < BURST_MS) return; // one verify per write burst, not per file
      return run(now, 'auto');
    },

    /**
     * Operator-initiated run (`/verify`, Aider /lint /test analogue) — the
     * burst throttle does not apply to an explicit ask; the arm-check does
     * (an agent-written config still can't smuggle a gated command).
     */
    async runNow() {
      return run(Date.now(), 'manual');
    },
  };

  async function run(now, origin) {
      let cfg = null;
      try { cfg = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { return { ran: false, reason: 'no .pai/verify.json onWrite configured' }; }
      const command = String(cfg?.onWrite ?? '').trim();
      if (!command) return { ran: false, reason: 'no .pai/verify.json onWrite configured' };

      const parsed = await classify(command).catch((e) => ({ parseError: String(e?.message ?? e) }));
      const actions = [parsed.risk, ...(parsed.hasUnknown ? ['unknown'] : [])]
        .map((c) => riskActions?.[c] ?? 'allow');
      if (parsed.parseError || actions.some((a) => a !== 'allow')) {
        audit?.write({
          kind: 'VERIFY_REFUSED',
          data: { command: command.slice(0, 200), risk: parsed.risk ?? null, parseError: parsed.parseError ?? null, origin },
        });
        return { ran: false, refused: true, reason: 'configured command is not policy-allowable — verify refused to arm it' };
      }

      lastRun = now;
      const timeoutMs = Number(cfg.timeoutMs) > 0 ? Math.min(Number(cfg.timeoutMs), 300_000) : 60_000;
      const r = await runBounded(command, workdir, timeoutMs);
      audit?.write({ kind: 'VERIFY_RUN', data: { command: command.slice(0, 200), code: r.code, origin } });
      emit?.({ type: 'verify_result', command, ok: r.code === 0 });
      if (r.code !== 0) {
        observations?.record({
          kind: 'verify_fail',
          subject: command.slice(0, 120),
          detail: { exit: r.code, tail: r.output.slice(-2000) },
          actor: 'host',
        });
      }
      return { ran: true, ok: r.code === 0, code: r.code, outputTail: r.output.slice(-4000) };
  }
}
