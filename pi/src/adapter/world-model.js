/**
 * World-model adapter — the pi body's implementation of the BCC-1 contract.
 *
 * WHAT THIS IS: pi's answer to `dsh/world-model/world-model.mjs`. It produces
 * the event stream the `mind/` toolchain reads and enforces the prediction-
 * binding guard. Contract: mind/README.md. Design: docs/pi-world-model-adapter.md.
 *
 * WHAT IT KNOWS: nothing about pi. It speaks only the contract's five surfaces
 * (ctx.on / ctx.get / ctx.tools.register / ctx.tools.guard) and the on-disk
 * formats the toolchain reads. The body supplies a ctx presenting pi's seams in
 * that shape (docs/pi-world-model-adapter.md §5), which is what lets the same
 * code run under mind/simulate_body.mjs in contract tests and under pi at
 * runtime.
 *
 * WHAT IT DOES NOT DO: compile the briefing (mind/canonical_compile.py) or
 * write canonical (mind/u1_accept.py — the governed path, outside the agent's
 * authority). It produces evidence and enforces the binding gate; distillation
 * is downstream.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  isConsequential, isIrreversibleByDefault, isIrreversibleArgs, overlayRelaxes,
  EXEC_STRUCT_KEYS,
} from '../../../host/src/core/irreversible.js';
import { PredictionStore } from '../../../host/src/core/prediction.js';

const SCHEMA_VERSION = '1.1';
const THEORY_VERSION = '0.3.1';
const BCC_VERSION = 'BCC-1';
const ALIAS_KEYS = ['arguments', 'args', 'params', 'input', 'parameters', 'payload', 'tool_input'];

/**
 * Formalization depth — a RATCHET, not a switch. The world model is always
 * present (observations are always recorded); the depth decides how much
 * ceremony a session must observe. `off` is a floor set by env/config, and the
 * session may only maintain or raise it — see `activate` below.
 */
const MODE_RANK = { off: 0, core: 1, full: 2 };

/**
 * THIS BODY'S tool-identity declaration (BCC-1 6.4).
 *
 * A SECURITY DECLARATION, not configuration. The classifier resolves a tool name
 * to a canonical identity; without an entry, an unknown tool falls through to
 * the fail-safe default (consequential AND irreversible-by-default), which is
 * safe but means every call demands an `irreversible:true` prediction.
 *
 * Only entries that are confidently correct belong here. `multi_edit` is left
 * OUT on purpose: it is a multi-file edit and the shared classifier already
 * resolves it as irreversible (host/tests/irreversible.test.js pins that
 * contradiction) — narrowing it is a security decision, not a cleanup.
 */
export const TOOL_IDENTITIES = Object.freeze({
  // arbitrary code execution in the page / in a repl → the exec channel
  browser_eval: 'exec',
  js_repl: 'exec',
  // env mutation is a reversible config write
  env_set: 'write',
  env_unset: 'write',
  // memory records are append-only with forget/pin as their own tools
  memory_save: 'write',
  memory_bulk: 'write',
  memory_recall: 'read',
  memory_pin: 'read',
  env_list: 'read',
  env_snapshot: 'read',
  job_status: 'read',
  doctor: 'read',
  // Read-only tools. Without these the fail-safe default would demand an
  // `irreversible:true` prediction for a pure read, which makes core mode
  // unusable rather than safer. Each was verified from its own description:
  //   fast_context  "Read-only retrieval: locate files and line ranges"
  //   session_read  "Read messages from a past session file"
  //   session_search "Full-text search across your past session transcripts"
  //   repo_map      "Structural outline of the workspace"
  //   output_read   "Read a slice of a tool output externalized for size"
  //   curator_scan  "Advisory only — it never deletes" (host/core/curator.js)
  //   skill_list/read, plan_list, task_list, spec_status, tool_search: list/read
  //   browser_read  "Read page text"
  fast_context: 'read',
  session_read: 'read',
  session_search: 'read',
  repo_map: 'read',
  output_read: 'read',
  curator_scan: 'read',
  skill_list: 'read',
  skill_read: 'read',
  plan_list: 'read',
  task_list: 'read',
  spec_status: 'read',
  tool_search: 'read',
  browser_read: 'read',
});

/**
 * The tool's parameter schema — CONTRACT-level: the ops and field names are the
 * contract's vocabulary, not any body's. A real runtime needs it (pi reads
 * `.parameters.properties` to describe the tool to the model); the contract's
 * mock harness calls execute() directly and does not.
 */
export const WM_PARAMETERS = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: ['activate', 'predict', 'observe', 'evaluate', 'update', 'persist', 'status'],
      description: 'Which world-model operation to perform.',
    },
    mode: { type: 'string', enum: ['off', 'core', 'full'], description: 'activate: ritual depth' },
    subject: { type: 'string', description: 'what this prediction/observation is about' },
    intended_action: { type: 'string', description: 'predict: the action this prediction binds to (required)' },
    expected_observation: { type: 'string', description: 'predict: what should be seen if the model is true' },
    falsifier: { type: 'string', description: 'predict: what result would prove it wrong' },
    irreversible: { type: 'boolean', description: 'predict: set when the bound action cannot be undone' },
    prediction_id: { type: 'string', description: 'observe/evaluate/update: the prediction to reference' },
    observation: { type: 'string', description: 'observe: what was actually seen' },
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'partial', 'unknown'] },
    evaluation_source: { type: 'string', description: 'evaluate: mechanical | model | operator' },
    model_id: { type: 'string', description: 'update: which model is being revised' },
    revision_type: { type: 'string', description: 'update: param | structural | representation' },
    change: { type: 'string', description: 'update: what changed' },
    summary: { type: 'string', description: 'persist: one-line summary' },
    confidence_bucket: { type: 'string', description: 'qualitative confidence, never a fake precision' },
    time_horizon: { type: 'string' },
  },
  required: ['op'],
};

/**
 * How many refutations of the SAME KIND before a re-examination is warranted.
 *
 * NO DEFAULT, DELIBERATELY. A single refutation is noise and a recurrence is a
 * 残差结构, but the COUNT at which recurrence becomes visible is a domain
 * judgement — the pilot's, not this file's. adapter-pilot-evaluation-rubric §四
 * B-P1: "适合量化时再使用数值阈值，不为 rubric 发明伪精确数字"; §五 requires the
 * pilot's adapter to declare its 判定规则/成功标准 as PRE-REGISTERED. So the
 * threshold arrives as a declared value, and its absence means UNDECLARED — in
 * which case the adapter does not fire at all (§七: 未操作化前一律 UNMEASURED).
 * Firing on a number this file invented would be exactly the pseudo-precision
 * the rubric names.
 *
 * Declaration channel: `<canonicalDir>/learning-trigger.json`
 *   { "refutation_threshold": <positive integer>, "declared_by": "...", "reason": "..." }
 * A canonical change goes through the pilot's U1 governance path, so this file is
 * written by the pilot, never by the runtime.
 *
 * @returns {number|null} the declared threshold, or null when undeclared
 */
function declaredRefutationThreshold(opts) {
  const t = Number(opts?.refutationThreshold);
  if (Number.isFinite(t) && t > 0) return Math.floor(t);
  if (!opts?.canonicalDir) return null;
  const doc = readJson(join(opts.canonicalDir, 'learning-trigger.json'));
  const d = Number(doc?.refutation_threshold);
  return Number.isFinite(d) && d > 0 ? Math.floor(d) : null;
}

const day = () => new Date().toISOString().slice(0, 10);
const safeJson = (v) => { try { return JSON.stringify(v); } catch { return '"<unserializable>"'; } };
const readJson = (p) => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; } catch { return null; } };

/**
 * @param {object} ctx  contract surface: on / get / tools.register / tools.guard
 * @param {{stateDir: string, canonicalDir: string, mode?: string, bodyId?: string,
 *          aliases?: object}} opts
 */
export function apply(ctx, { stateDir, canonicalDir, mode = 'off', bodyId = 'unset', aliases = TOOL_IDENTITIES, refutationThreshold = null } = {}) {
  if (!stateDir) throw new Error('world-model adapter requires stateDir');
  const ledgerDir = join(stateDir, 'ledger');
  const runsDir = join(stateDir, 'runs');
  mkdirSync(ledgerDir, { recursive: true });
  mkdirSync(runsDir, { recursive: true });

  // The model-visible prediction store lives in host/ (canonical state): it is
  // what host/app/host.js injects into the context envelope, so a prediction
  // opened here reaches the model's <open-predictions> block. Binding data
  // (intended_action / irreversible) is not part of that store's schema and
  // lives in the ledger instead — see openPreds below.
  const predictions = canonicalDir ? new PredictionStore(canonicalDir) : null;

  const sessions = new Map();
  let globalSeq = 0;

  // Predictions are canonical state: they survive compaction, handoff and body
  // switches (host/src/core/prediction.js says the same). So they live at the
  // adapter level, not per session — and they are RESTORED on startup, which is
  // what "persistence across kill points" (6.5) actually requires: a fresh
  // process must still know which predictions are open, or the gate would
  // permit a mutation the previous process had required a prediction for.
  const openPreds = new Map();

  // Refutations counted per KIND. One is noise; a recurrence is a residual
  // structure. Keyed by the prediction's subject — the thing the model was
  // about — so that "the same model was wrong again" accumulates, while three
  // unrelated failures do not.
  const refutationsByKind = new Map();

  // The threshold is DECLARED, never defaulted — see declaredRefutationThreshold.
  const threshold = declaredRefutationThreshold({ refutationThreshold, canonicalDir });
  let undeclaredReported = false;

  /**
   * The learned overlay (finding G11): models the canonical has learned about
   * tool/command behaviour, compiled into a form the gate can read. Without it
   * the gate could only ever run on its built-in prior, and a refutation like
   * "I thought `foo` was safe and it destroyed X" could reach the briefing and
   * the agent yet never reach the gate.
   *
   * FRESHNESS IS ENFORCED HERE, WHOLESALE. If the overlay is not newer than the
   * canonical it was compiled from, it is dropped entirely — never partially
   * applied. (Same mtime discipline as the doctor's compiled_artifacts check;
   * the overlay also carries a canonical_watermark as a provenance record for
   * human verification.)
   */
  const overlay = (() => {
    if (!canonicalDir) return null;
    const p = join(canonicalDir, 'reversibility.json');
    const doc = readJson(p);
    if (!doc || !Array.isArray(doc.relaxations)) return null;
    try {
      const src = statSync(join(canonicalDir, 'current.yaml')).mtimeMs;
      if (statSync(p).mtimeMs < src) return null;   // stale ⇒ prior stands
    } catch { /* missing source: cannot establish freshness ⇒ drop it */ return null; }
    return doc;
  })();
  let current = { schema_version: SCHEMA_VERSION, updated_at: null, open_predictions: [], models: {}, open_loops: [] };
  {
    const prior = readJson(join(stateDir, 'current.json'));
    if (prior && typeof prior === 'object') {
      current = { ...current, ...prior };
      for (const p of Array.isArray(prior.open_predictions) ? prior.open_predictions : []) {
        // Accept both the record form and a bare id (an id alone cannot be
        // bound — the guard needs intended_action — so such a prediction is
        // restored as evaluated-unknown and will not authorise anything).
        if (p && typeof p === 'object' && p.id) openPreds.set(p.id, { ...p, evaluated: false });
      }
    }
  }

  const sess = (id) => {
    const key = id || 's1';
    if (!sessions.has(key)) sessions.set(key, { id: key, mode, lastEventId: null });
    return sessions.get(key);
  };

  /** Append one event to both streams the toolchain reads, with a causal chain. */
  function emit(sessionId, eventType, data = {}) {
    const s = sess(sessionId);
    const seq = ++globalSeq;
    const ev = {
      ...data,
      // Envelope fields LAST: caller-supplied data must not be able to forge
      // event identity or break the chain pointer.
      event_id: randomUUID(),
      schema_version: SCHEMA_VERSION,
      theory_version: THEORY_VERSION,
      session_id: s.id,
      seq,
      prev_event: s.lastEventId,
      event_type: eventType,
      timestamp: new Date().toISOString(),
      actor: 'agent',
      body_id: bodyId,
      bcc: BCC_VERSION,
      layer: eventType === 'RAW_EVIDENCE' ? 'L0' : 'L1',
      access: 'PRIVATE',
    };
    s.lastEventId = ev.event_id;
    const line = safeJson(ev) + '\n';
    appendFileSync(join(ledgerDir, `${day()}.jsonl`), line);
    appendFileSync(join(runsDir, `${s.id}.jsonl`), line);
    return ev;
  }

  /** The payload pool a guard must scan: every alias key plus the execution's own extras. */
  function argPool(execution) {
    const pool = [];
    if (execution && typeof execution === 'object') {
      for (const k of ALIAS_KEYS) if (execution[k] != null) pool.push(execution[k]);
      const extra = {};
      for (const k of Object.keys(execution)) if (!EXEC_STRUCT_KEYS.has(k)) extra[k] = execution[k];
      pool.push(extra);
    }
    return pool;
  }

  // ---- RAW_EVIDENCE (L0): every tool result, unfiltered --------------------
  // Mechanical capture. The model later decides what becomes an OBSERVATION.
  ctx.on('tools/result', (exec, result) => {
    const sessionId = exec?.agent?.session?.id;
    const rawName = String(exec?.name || 'unknown');
    // 6.4: canonical identity is resolved through the body's declaration; the
    // body's own name rides alongside so a rename is visible, not lossy.
    const canonical = aliases?.[rawName] ?? rawName;
    emit(sessionId, 'RAW_EVIDENCE', {
      subject: rawName,
      happened: `tool ${rawName} returned`,
      tool: { canonical_tool_id: canonical, body_tool_id: rawName },
      payload: { result: typeof result === 'string' ? result.slice(0, 2000) : result },
      evidence_refs: [],
    });
  });

  ctx.on('session/event', (session, event) => {
    emit(session?.id, 'SESSION_EVENT', { subject: String(event?.type ?? 'event'), payload: { type: event?.type } });
  });

  // ---- the world_model tool ------------------------------------------------
  ctx.tools.register({
    name: 'world_model',
    label: 'World Model',
    description: 'Persistent world model: activate / predict / observe / evaluate / update / persist / status. '
      + 'A consequential mutation must first bind to an open prediction via op:"predict".',
    parameters: WM_PARAMETERS,
    async execute(input = {}, exec = {}) {
      const s = sess(exec?.agent?.session?.id);
      const op = input.op;
      switch (op) {
        case 'activate': {
          // The session may MAINTAIN or RAISE the formalization depth — never
          // lower it. `off` comes from env/config only. Without this the agent
          // could call activate({mode:'off'}) and disarm the very gate it is
          // subject to, which defeats the mechanism entirely.
          // (dsh/world-model/world-model.mjs:893 states the same rule:
          //  "会话不可自行关闸；activate 只能维持或升级形式化深度".)
          const requested = input.mode;
          const raised = requested === 'core' || requested === 'full';
          const refused = requested != null && !raised;
          if (raised && (MODE_RANK[requested] ?? 0) >= (MODE_RANK[s.mode] ?? 0)) s.mode = requested;
          emit(s.id, 'WM_ACTIVATE', {
            subject: 'world-model',
            happened: `activated mode=${s.mode}${refused ? ` (ignored request '${requested}' — depth may only be maintained or raised)` : ''}`,
            payload: { mode: s.mode, requested: requested ?? null, refused },
          });
          return { ok: true, mode: s.mode, body_id: bodyId, bcc: BCC_VERSION, ...(refused ? { refused_lower: requested } : {}) };
        }
        case 'predict': {
          if (!input.intended_action) return { ok: false, code: 'PREDICTION_UNBOUND', message: 'predict requires intended_action' };
          // Model-visible half (reaches <open-predictions> in the context).
          const claim = String(input.expected_observation || input.subject || input.intended_action);
          const rec = predictions
            ? predictions.open({ claim, horizon: input.time_horizon ?? null, confidence: input.confidence_bucket ?? null, actor: 'pi' })
            : { id: `pred-${randomUUID().slice(0, 12)}` };
          // Binding half (what the guard needs) — kept in the ledger and indexed.
          openPreds.set(rec.id, {
            id: rec.id,
            subject: input.subject ?? null,
            intended_action: String(input.intended_action),
            irreversible: input.irreversible === true,
            evaluated: false,
          });
          emit(s.id, 'PREDICTION_CREATED', {
            subject: input.subject ?? 'prediction',
            prediction_id: rec.id,
            happened: `prediction opened: ${claim}`,
            payload: {
              prediction_id: rec.id, subject: input.subject ?? null,
              intended_action: String(input.intended_action),
              expected_observation: input.expected_observation ?? null,
              falsifier: input.falsifier ?? null,
              irreversible: input.irreversible === true,
              confidence_bucket: input.confidence_bucket ?? null,
            },
            evidence_refs: [],
          });
          return { ok: true, prediction_id: rec.id, claim };
        }
        case 'observe': {
          const pid = input.prediction_id ?? null;
          if (!pid) return { ok: false, code: 'OBSERVATION_UNLINKED', message: 'observe requires prediction_id' };
          emit(s.id, 'OBSERVATION_RECORDED', {
            subject: input.subject ?? 'observation',
            prediction_id: pid,
            happened: String(input.observation ?? '').slice(0, 500),
            payload: { observation: input.observation ?? null, evaluation_source: input.evaluation_source ?? null },
            evidence_refs: input.evidence_refs ?? [],
          });
          return { ok: true, prediction_id: pid };
        }
        case 'evaluate': {
          const pid = input.prediction_id ?? null;
          const p = pid ? openPreds.get(pid) : null;
          if (!pid || !p) return { ok: false, code: 'PREDICTION_UNKNOWN', message: `unknown prediction ${pid}` };
          p.evaluated = true;
          const verdict = input.verdict ?? null;
          if (predictions) { try { predictions.close(pid, { verdict }, verdict === 'refuted' ? 'refuted' : 'confirmed'); } catch { /* store may already hold it closed */ } }
          emit(s.id, 'PREDICTION_EVALUATED', {
            subject: 'evaluation', prediction_id: pid,
            happened: `prediction ${pid} evaluated: ${verdict ?? 'unknown'}`,
            payload: { verdict, evaluation_source: input.evaluation_source ?? null },
          });
          // THE LEARNING SIGNAL IS REPETITION, NOT THE REFUTATION.
          //
          // One refutation is noise (theory/sources/02: "一次失败可能只是噪声"),
          // and a world model stores only what is 稳定 and 可迁移 — not single
          // events. What licenses MODEL FAILURE is a 残差结构: the same kind of
          // failure recurring, so that `reality - prediction` shows a pattern
          // rather than scatter. So we count per KIND and only then ask for a
          // re-examination — and a re-examination is all this is: whether a
          // structure actually exists is distiller.py's judgement (it groups by
          // signature and checks independence), not ours. One refutation will
          // correctly yield nothing.
          //
          // POLICY ("repeated failure of one kind warrants a look") is
          // harness-level and lives here. MECHANISM (how this body runs a cycle)
          // is body-specific and lives behind the optional `ctx.learning`
          // surface — absent it, this is a no-op and the ledger record above is
          // still the durable signal a sweep can act on later.
          if (verdict === 'refuted' || verdict === 'partial') {
            const kind = String(input.subject ?? p.subject ?? pid);
            const n = (refutationsByKind.get(kind) ?? 0) + 1;
            refutationsByKind.set(kind, n);
            // Undeclared threshold ⇒ no trigger, and say so once. A runtime that
            // picked a number here would be inventing a decision the pilot owns.
            if (threshold == null) {
              if (!undeclaredReported) {
                undeclaredReported = true;
                try {
                  ctx.learning?.undeclared?.({
                    what: 'refutation_threshold',
                    where: `${canonicalDir ?? '<canonical>'}/learning-trigger.json`,
                    consequence: 'recurrence will not trigger a re-examination (UNMEASURED)',
                  });
                } catch { /* reporting must never break evaluation */ }
              }
            } else if (n >= threshold) {
              refutationsByKind.set(kind, 0); // one look per burst, not per refutation
              try {
                ctx.learning?.request?.({
                  reason: 'residual_structure',
                  kind, refutations: n, threshold,
                  prediction_id: pid, verdict, session_id: s.id,
                });
              } catch { /* a body that cannot schedule must not break the evaluation */ }
            }
          }
          return { ok: true, prediction_id: pid, verdict };
        }
        case 'update': {
          const ref = input.prediction_id ?? null;
          if (ref && !openPreds.get(ref)?.evaluated) {
            return { ok: false, code: 'UPDATE_UNEVALUATED', message: `update references unevaluated prediction ${ref}` };
          }
          const id = input.model_id ?? `m-${randomUUID().slice(0, 8)}`;
          current.models[id] = { revision_type: input.revision_type ?? null, change: input.change ?? null };
          emit(s.id, 'MODEL_UPDATED', {
            subject: id, prediction_id: ref,
            happened: `model ${id} updated (${input.revision_type ?? 'unspecified'})`,
            payload: { model_id: id, revision_type: input.revision_type ?? null, change: input.change ?? null },
          });
          return { ok: true, model_id: id };
        }
        case 'persist': {
          // Runtime snapshot = the adapter's own working state (no toolchain
          // reader; kept so a restart can rebuild without replaying the ledger).
          // Full records, not just ids: an id alone cannot be bound on restart.
          current = {
            schema_version: SCHEMA_VERSION,
            updated_at: new Date().toISOString(),
            open_predictions: [...openPreds.values()].filter((p) => !p.evaluated),
            models: current.models,
            open_loops: current.open_loops,
            body_id: bodyId,
          };
          writeFileSync(join(stateDir, 'current.json'), JSON.stringify(current, null, 2));
          emit(s.id, 'STATE_PERSISTED', { subject: 'state', happened: String(input.summary ?? 'persisted'), payload: { summary: input.summary ?? null } });
          return { ok: true, persisted: true, open_predictions: current.open_predictions.map((p) => p.id) };
        }
        case 'status':
          return {
            ok: true, mode: s.mode, body_id: bodyId, bcc: BCC_VERSION,
            session_predictions: [...openPreds.keys()],
            open_predictions: [...openPreds.values()].filter((p) => !p.evaluated).map((p) => p.id),
            current,
          };
        default:
          return { ok: false, code: 'UNKNOWN_OP', message: `unknown op ${op}` };
      }
    },
  });

  // ---- the consequential-mutation gate -------------------------------------
  // Contract 6.3: a consequential mutation in core/full must bind to an OPEN,
  // UNEVALUATED prediction that names the tool and its target; an irreversible
  // payload additionally needs irreversible:true on that prediction.
  ctx.tools.guard((execution) => {
    const rawName = String(execution?.name || '');
    const s = sess(execution?.agent?.session?.id);
    if (s.mode !== 'core' && s.mode !== 'full') return undefined;
    if (!rawName) return '[world-model] BLOCKED: unnamed tool call cannot bind a prediction (fail closed)';
    if (!isConsequential(rawName, aliases)) return undefined;
    // The whole payload pool is scanned: a payload hidden under an alias key is
    // still a payload (hiding it must not turn a deny into a permit).
    const pool = argPool(execution);
    // PRIOR FIRST. The built-in dictionaries always decide; a learned overlay is
    // consulted only when the prior already says "irreversible", and it can only
    // drop that verdict. It cannot tighten, and it cannot touch a call the prior
    // already considers safe — there is no way to disable the prior wholesale.
    let irreversible = isIrreversibleByDefault(rawName, aliases) || isIrreversibleArgs(pool);
    if (irreversible && overlayRelaxes(overlay, rawName, pool)) irreversible = false;
    for (const p of openPreds.values()) {
      if (p.evaluated) continue;
      const ia = String(p.intended_action || '');
      if (!ia) continue;
      const bound = ia.includes(rawName) || /mutation|edit|write|exec|modify|change/i.test(ia);
      if (!bound) continue;
      if (irreversible && p.irreversible !== true) continue;
      return undefined; // bound (and, if irreversible, flagged) → permit
    }
    const why = irreversible
      ? 'is a consequential IRREVERSIBLE action'
      : 'is a consequential action';
    // What is required is a PRE-REGISTERED, falsifiable expectation — written
    // before the result exists. The record does not make the prediction correct;
    // it makes being wrong legible. Saying "predict and you may proceed" would
    // confuse a trace with validity, which theory-v0.5 §九 warns about
    // explicitly: artifact traces ≠ semantic validity.
    return `[world-model] BLOCKED: ${rawName} ${why} in ${s.mode} mode — this is a test of an `
      + 'existing model, so the expectation must exist BEFORE the result does; explaining it '
      + `afterwards is not a prediction. Call world_model(op:"predict") with intended_action `
      + `naming this tool and its target arguments${irreversible ? ', and irreversible:true' : ''}. `
      + 'Recording an expectation is what makes being wrong legible — it does not make it right.';
  });
}
