/**
 * jsrepl-worker.js — the persistent half of the js_repl tool (M114).
 *
 * One node child per session; code arrives as JSON lines on stdin, each eval
 * runs inside a vm context that SURVIVES between calls (const/let/function
 * declarations persist — that is the whole point of a REPL vs node -e).
 * Replies are JSON lines on stdout: {id, ok, result, stdout, stderr}.
 *
 * Discipline: a hard per-eval timeout (the parent's code can kill us too),
 * output captured and capped, and the child's env is already scrubbed by the
 * parent before spawn — model-written code must never read operator secrets
 * out of process.env.
 */
import vm from 'node:vm';
import readline from 'node:readline';

const EVAL_TIMEOUT_MS = Number(process.env.PAI_REPL_TIMEOUT_MS ?? 15_000);
const OUT_CAP = 32 * 1024;

// A shared context — the REPL is exec-class (governed like bash), so it gets
// the real node globals (process/require/console/fetch/timers). The child's
// env is already secret-scrubbed by the parent, so process.env inside is
// safe to expose. stdout/stderr writes are captured per-eval below.
const ctx = vm.createContext(globalThis);

const cap = (s) => (s.length > OUT_CAP ? s.slice(0, OUT_CAP) + `\n[output capped at ${OUT_CAP} chars]` : s);

const rl = readline.createInterface({ input: process.stdin, terminal: false });
// STRICTLY SERIAL: the parent allows concurrent js_repl calls (parallel tool
// calls in one turn), and the stdout/stderr capture below monkey-patches
// process streams — two interleaved evals would capture each other's patched
// writer as their "original", then one restore leaves the reply JSON written
// into a dead buffer: the reply never reaches the parent, the call hangs to
// timeout, and every later eval's output vanishes. A promise chain forces
// one eval at a time (the REPL context is shared state anyway).
let queue = Promise.resolve();
rl.on('line', (line) => { queue = queue.then(() => evalLine(line)).catch(() => {}); });

async function evalLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, code } = msg;
  let stdout = '';
  let stderr = '';
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c) => { stdout += c; return true; };
  process.stderr.write = (c) => { stderr += c; return true; };
  let result;
  let ok = true;
  try {
    const script = new vm.Script(String(code ?? ''));
    // async snippets: a returned promise is raced against the same timeout
    const value = script.runInContext(ctx, { timeout: EVAL_TIMEOUT_MS });
    result = value instanceof Promise
      ? await Promise.race([value, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${EVAL_TIMEOUT_MS}ms`)), EVAL_TIMEOUT_MS))])
      : value;
  } catch (e) {
    ok = false;
    result = e?.message ?? String(e);
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErr;
  }
  const render = (v) => {
    if (v === undefined) return 'undefined';
    try { return typeof v === 'string' ? v : JSON.stringify(v); }
    catch { return String(v); }
  };
  origWrite(JSON.stringify({ id, ok, result: render(result), stdout: cap(stdout), stderr: cap(stderr) }) + '\n');
}
