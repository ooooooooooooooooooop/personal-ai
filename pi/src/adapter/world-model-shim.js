/**
 * World-model ctx shim — presents pi's seams in the shape the BCC-1 contract
 * requires, so `world-model.js` can stay entirely ignorant of pi.
 *
 * Contract surface → pi seam:
 *   ctx.on('tools/result', fn)  → pi.on('turn_end') → per event.toolResults[]
 *   ctx.on('session/event', fn) → pi.on('session_compact' / 'model_select' / …)
 *   ctx.get(service)            → not needed by the adapter (returns null)
 *   ctx.tools.register(tool)    → collected, pushed into customTools
 *   ctx.tools.guard(fn)         → collected, consulted from the decide chain
 *
 * Handlers cannot be attached at apply() time: the pi session does not exist
 * yet, and it is REBUILT on session_new/session_switch. So the shim buffers the
 * registrations and exposes an extension factory that attaches them to each
 * new session — the same mechanism the other pai-* extensions use.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { apply as applyAdapter, TOOL_IDENTITIES } from './world-model.js';
import { logLine } from '../../../host/src/core/logline.js';

// pi/src/adapter → repo root → mind/  (the toolchain that runs the cycle)
const REPO_MIND = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'mind');

/** Match a tool call's arguments by id, the way loop.js does. */
function argsFor(context, callId) {
  const msgs = Array.isArray(context) ? context : (context?.messages ?? []);
  for (const m of msgs) {
    const parts = Array.isArray(m?.content) ? m.content : [];
    for (const p of parts) {
      if (p?.toolCallId === callId && p?.arguments) return p.arguments;
      if (p?.toolCallId === callId && p?.input) return p.input;
    }
  }
  return {};
}

/**
 * @param {{stateDir: string, canonicalDir: string, mode?: string, bodyId?: string,
 *          getSessionId: () => string|null, aliases?: object,
 *          scheduleStore?: object, instanceRoot?: string, pythonExe?: string}} opts
 */
export function createWorldModelShim({ stateDir, canonicalDir, mode = 'off', bodyId = 'unset',
  getSessionId, aliases = TOOL_IDENTITIES, scheduleStore = null, instanceRoot = null,
  pythonExe = null }) {
  const resultHandlers = [];
  const sessionHandlers = [];
  let tool = null;
  let guard = null;

  // A burst of refutations must produce ONE cycle, not N. The window is a
  // coalescing window, not a cadence: the trigger is still the refutation.
  const COALESCE_MS = 5 * 60 * 1000;
  let lastRequestedAt = 0;

  const ctx = {
    on: (event, fn) => {
      if (event === 'tools/result') resultHandlers.push(fn);
      else if (event === 'session/event') sessionHandlers.push(fn);
    },
    get: () => null,
    tools: {
      register: (t) => { tool = t; },
      guard: (fn) => { guard = fn; },
    },
    // Optional body capability: "a refutation happened, start learning".
    // The adapter states the POLICY; how this body acts on it stays here.
    learning: {
      /**
       * The adapter refuses to invent a threshold, so when the pilot has not
       * declared one it reports the gap instead of guessing. Surfaced once, and
       * deliberately loud enough to be noticed: a silently inert learning loop
       * is the failure mode this whole section exists to prevent.
       */
      undeclared({ what, where, consequence } = {}) {
        // #3059 — diagnostics route through logLine so LOG_JSON turns them
        // into structured records for log pipelines.
        logLine('world-model', `${what} is UNDECLARED (looked in ${where}) — `
          + `${consequence}. Declare it through the pilot's U1 governance path; `
          + 'until then the recurrence trigger is UNMEASURED, not off-by-default.',
          { what, where }, 'warn');
        return { undeclared: true, what };
      },
      request({ reason, prediction_id, verdict } = {}) {
        if (!scheduleStore || !instanceRoot) return { scheduled: false, why: 'no schedule store' };
        const now = Date.now();
        if (now - lastRequestedAt < COALESCE_MS) {
          return { scheduled: false, why: 'coalesced into the pending cycle' };
        }
        lastRequestedAt = now;
        const py = pythonExe ?? process.env.PAI_PYTHON ?? 'python';
        // One-shot: the signal fires when it fires, not on a cadence.
        scheduleStore.add({
          command: `${py} ${join(REPO_MIND, 'wm_cycle.py')} --instance ${instanceRoot}`,
          run_at: now,
          label: `world-model cycle (refutation ${String(prediction_id ?? '').slice(0, 12)}: ${verdict ?? reason})`,
        });
        return { scheduled: true, reason, prediction_id, verdict };
      },
    },
  };

  // The adapter speaks only the contract; everything pi-shaped stays here.
  applyAdapter(ctx, { stateDir, canonicalDir, mode, bodyId, aliases });

  const sid = () => getSessionId() ?? 's1';

  const extension = {
    name: 'pai-world-model',
    factory: (pi) => {
      // RAW_EVIDENCE feed: every tool result the body observed.
      pi.on('turn_end', (event) => {
        for (const r of event?.toolResults ?? []) {
          const exec = {
            name: r?.toolName ?? 'unknown',
            arguments: argsFor(event?.context, r?.toolCallId),
            agent: { session: { id: sid() } },
          };
          for (const h of resultHandlers) {
            try { h(exec, r?.content ?? r); } catch { /* evidence capture must never break the turn */ }
          }
        }
      });
      // Session lifecycle events the adapter records.
      for (const [piEvent, type] of [['session_compact', 'session_compact'],
        ['session_compact_failed', 'session_compact_failed'], ['model_select', 'model_select']]) {
        pi.on(piEvent, (event) => {
          for (const h of sessionHandlers) {
            try { h({ id: sid() }, { type, detail: event }); } catch { /* as above */ }
          }
        });
      }
    },
  };

  return {
    /**
     * The `world_model` tool in PI's shape.
     *
     * The contract's tool interface and pi's are NOT the same — verified against
     * a real provider run, where the contract-shaped tool failed with
     * "Cannot read properties of undefined (reading 'properties')":
     *
     *   contract (simulate_body.mjs):  execute(input, exec) → {prediction_id}
     *   pi runtime:                    parameters: <JSON schema>   (required —
     *                                  the runtime reads .parameters.properties)
     *                                  execute(toolCallId, params)
     *                                  → {content:[{type:'text',...}], isError?}
     *
     * Translating between them is exactly this shim's job; the adapter stays
     * contract-shaped and knows neither form.
     */
    get tool() {
      if (!tool) return null;
      return {
        name: tool.name,
        label: tool.label ?? 'World Model',
        description: tool.description,
        parameters: tool.parameters ?? { type: 'object', properties: {} },
        async execute(toolCallId, params) {
          const out = await tool.execute(params ?? {}, {
            agent: { session: { id: sid() } },
            toolCallId,
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(out) }],
            ...(out && out.ok === false ? { isError: true } : {}),
          };
        },
      };
    },
    /** Decide-chain hook: returns undefined to permit, or a string to deny. */
    guard(execution) {
      if (!guard) return undefined;
      return guard({ ...execution, agent: { session: { id: sid() } } });
    },
    extension,
  };
}
