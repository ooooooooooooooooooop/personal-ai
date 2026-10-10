// simulate_body.mjs — BCC body simulator: load a body adapter with a mock ctx,
// feed a JSON scenario (tool results / session events / executions), emit the
// guard decisions + captured ledger events as JSON to stdout.
// Usage: node simulate_body.mjs <scenario.json> <stateDir> <canonicalDir> [mode]
//        BCC_PLUGIN=<path to adapter .mjs>  — REQUIRED: the adapter under test
//
// This fixture is deliberately body-agnostic: it bakes in NO adapter path.
// It belongs to the BCC-1 contract harness (bcc_check.py), and the contract is
// body-independent — so the HARNESS names the adapter under test and passes it
// here via BCC_PLUGIN. Adding a body never requires editing this file.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const adapterPath = process.env.BCC_PLUGIN;
if (!adapterPath) {
  process.stderr.write('simulate_body: BCC_PLUGIN=<path to adapter .mjs> is required ' +
    '(the harness names the adapter under test; this fixture bakes in no body path)\n');
  process.exit(2);
}
const { apply } = await import(pathToFileURL(resolve(adapterPath)).href);

const [scenarioPath, stateDir, canonicalDir, mode] = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));

const events = [];
const guardDecisions = [];
let registeredTool = null;
let lastPid = null;

const ctx = {
  on: (ev, fn) => { (ctx._handlers ||= {})[ev] = fn; },
  get: (svc) => svc === 'agents' ? { get: () => null } : null,
  tools: {
    register: (t) => { registeredTool = t; },
    guard: (fn) => { ctx._guard = fn; },
  },
};

// scenario.aliases, when present, is forwarded verbatim — the HARNESS may name
// a body→canonical rename to exercise 6.4 without this fixture baking in any
// body's name table.
apply(ctx, { stateDir, canonicalDir, mode: mode || scenario.mode || 'off', bodyId: scenario.bodyId || 'body-A', ...(scenario.aliases ? { aliases: scenario.aliases } : {}) });

const execFor = (name, sid) => ({ name, agent: { session: { id: sid || 's1' } }, arguments: scenario.args || {} });

for (const step of scenario.steps || []) {
  if (step.type === 'tool_result') {
    ctx._handlers['tools/result']?.(execFor(step.tool, step.session), step.result ?? 'ok');
  } else if (step.type === 'session_event') {
    ctx._handlers['session/event']?.({ id: step.session || 's1' }, { type: step.event });
  } else if (step.type === 'tool_call') {
    const inp = { ...(step.input || {}) };
    if (inp.prediction_id === '__last__' && lastPid) inp.prediction_id = lastPid;
    // AWAIT: a body's tool execute may be async (cordis/pi both await it), and
    // calling it without awaiting yields a Promise whose `.prediction_id` is
    // undefined — so `__last__` never resolves and any later op that needs the
    // id silently operates on a placeholder. That made the harness unable to
    // drive an async adapter at all, while looking like an adapter failure.
    const out = await registeredTool?.execute(inp, execFor(step.tool || 'world_model', step.session));
    if (out?.prediction_id) lastPid = out.prediction_id;
    events.push({ step: 'tool_call', op: inp?.op, out });
  } else if (step.type === 'guard') {
    // exec_extra: 往 execution 上注入别名/未知参数键（parameters/tool_input/自有键）
    const r = ctx._guard?.({ name: step.tool, arguments: step.arguments || {}, ...(step.exec_extra || {}), agent: { session: { id: step.session || 's1' } } });
    guardDecisions.push({ tool: step.tool, args: step.arguments || {}, decision: r === undefined ? 'permit' : 'deny', msg: r || null });
  }
}

// drain ledger written to stateDir for ordering analysis
console.log(JSON.stringify({
  guardDecisions,
  toolCalls: events,
}, null, 0));
