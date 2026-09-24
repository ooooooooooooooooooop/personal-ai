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
import { join, resolve, isAbsolute } from 'node:path';
import { scrubHookEnv } from '../../../host/src/core/hooks.js';

const BURST_MS = 5_000;
const OUT_CAP = 64 * 1024;
const LINT_TIMEOUT_MS = 10_000;

// dedup-h #2132 — built-in post-write delta lint (roo/aider auto-syntax
// analogue): a successful write/edit on a lintable file gets its syntax
// checked WITHOUT operator config — the failure reflects back through the
// observation stream just like verify_fail. Checker coverage is honest:
// .json is always checked (JSON.parse); .py/.toml/.yaml ride the system
// python ONLY when a probe proves it exists (py_compile, stdlib tomllib,
// pyyaml respectively). No interpreter → JSON still checks, the rest are
// skipped honestly (never a fake hand-rolled "parser").
const pyProbe = { bin: null, checked: false, toml: false, yaml: false };
async function pythonBin(envOverlay) {
  if (pyProbe.checked) return pyProbe.bin;
  pyProbe.checked = true;
  for (const cand of (process.platform === 'win32' ? ['python', 'py -3'] : ['python3', 'python'])) {
    const r = await runBounded(`${cand} --version`, undefined, 5_000, envOverlay);
    if (r.code === 0) {
      pyProbe.bin = cand;
      // Probe stdlib tomllib (3.11+) and pyyaml once — stderr-free exit = usable.
      pyProbe.toml = (await runBounded(`${cand} -c "import tomllib"`, undefined, 5_000, envOverlay)).code === 0;
      pyProbe.yaml = (await runBounded(`${cand} -c "import yaml"`, undefined, 5_000, envOverlay)).code === 0;
      break;
    }
  }
  return pyProbe.bin;
}

/** @returns {Promise<{path, checked:boolean, ok:boolean, detail:string|null}>} */
async function lintOne(path, envOverlay) {
  const ext = (path.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  try {
    if (ext === 'json') {
      JSON.parse(readFileSync(path, 'utf-8'));
      return { path, checked: true, ok: true, detail: null };
    }
    if (ext === 'py' || ext === 'toml' || ext === 'yaml' || ext === 'yml') {
      const bin = await pythonBin(envOverlay);
      if (!bin) return { path, checked: false, ok: true, detail: 'no python interpreter — syntax check skipped' };
      if ((ext === 'toml' && !pyProbe.toml) || ((ext === 'yaml' || ext === 'yml') && !pyProbe.yaml)) {
        return { path, checked: false, ok: true, detail: `no ${ext} module in probed python — syntax check skipped` };
      }
      // The path rides the env, never argv — a shell-metachar filename must
      // not break out of the -c string (same injection class as {task}).
      const snippet = ext === 'py'
        ? `import py_compile,os; py_compile.compile(os.environ['PAI_LINT_PATH'],doraise=True)`
        : ext === 'toml'
          ? `import tomllib,os; tomllib.load(open(os.environ['PAI_LINT_PATH'],'rb'))`
          : `import yaml,os; yaml.safe_load(open(os.environ['PAI_LINT_PATH'],encoding='utf-8'))`;
      const lintEnv = () => ({ ...(envOverlay?.() ?? {}), PAI_LINT_PATH: path });
      const r = await runBounded(`${bin} -c "${snippet}"`, undefined, LINT_TIMEOUT_MS, lintEnv);
      return { path, checked: true, ok: r.code === 0, detail: r.code === 0 ? null : r.output.slice(-2000) };
    }
    return { path, checked: false, ok: true, detail: null };
  } catch (e) {
    return { path, checked: true, ok: false, detail: String(e?.message ?? e).slice(0, 2000) };
  }
}

function runBounded(command, cwd, timeoutMs, envOverlay) {
  return new Promise((resolveP) => {
    let child;
    try {
      // Scrub FIRST, overlay second (M121, same discipline as js_repl and the
      // observational hooks): the verifier command comes from an AGENT-
      // WRITABLE config (.pai/verify.json) — a full process.env passthrough
      // would let `onWrite: "printenv"` lift operator credentials into the
      // transcript. Policy classification gates the command SHAPE; env
      // scrubbing closes what shape-classification cannot see.
      child = spawn(command, { shell: true, cwd, windowsHide: true, env: { ...scrubHookEnv(process.env), ...(envOverlay?.() ?? {}) } });
    } catch (e) {
      resolveP({ code: -1, output: String(e?.message ?? e) });
      return;
    }
    let out = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      // shell:true → the tracked pid is the cmd.exe wrapper; killing it alone
      // orphans the real verifier (a hung `npm run lint` would live on past
      // the timeout). Same tree-kill discipline as the durable-job executor.
      if (process.platform === 'win32') {
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
        catch { child.kill(); }
      } else child.kill('SIGTERM');
    }, timeoutMs);
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

export function createVerifier({ workdir, classify, riskActions, audit = null, emit = null, observations = null, envOverlay = null }) {
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
    /**
     * dedup-h #2132 — built-in post-write delta lint: syntax-check the files
     * a write-family tool just touched (json always; py/toml/yaml via a
     * probed python). NOT burst-coalesced — each file is checked once per
     * write. Failures reflect into the observation stream + audit; skipped
     * (unchecked) files stay silent — no fake pass, no fake fail.
     */
    async lintPaths(paths) {
      const list = [...new Set((paths ?? []).filter((p) => typeof p === 'string' && p.trim()))].slice(0, 8);
      const results = [];
      for (const raw of list) {
        const p = isAbsolute(raw) ? raw : resolve(workdir, raw);
        const r = await lintOne(p, envOverlay);
        results.push(r);
        if (!r.checked) continue;
        audit?.write({ kind: 'DELTA_LINT', data: { path: p.slice(0, 300), ok: r.ok, detail: r.ok ? null : r.detail?.slice(0, 500) ?? null } });
        if (!r.ok) {
          emit?.({ type: 'verify_result', command: `delta-lint ${p}`, ok: false });
          observations?.record({
            kind: 'delta_lint_fail',
            subject: p.slice(0, 200),
            detail: { tail: r.detail?.slice(-2000) ?? '' },
            actor: 'host',
          });
        }
      }
      return results;
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
      const r = await runBounded(command, workdir, timeoutMs, envOverlay);
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
