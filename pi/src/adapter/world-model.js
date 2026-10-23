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
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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
  pdf_read: 'read',
  update_todos: 'todowrite',
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
    // Evaluation awareness (theory-v0.5 §六 / adapter contract item 6). When the
    // entity knows the evaluation goal, rules or treatment, the observation's
    // EXTERNAL VALIDITY can change — it is no longer a clean reading of the world.
    // These four are the ones the contract names, not ones invented here; the
    // VALUES are this pilot's to define. Record them or the evidence cannot be
    // weighed later: an observation produced by an informed executor, judged by a
    // non-blind evaluator, on a self-assessed outcome, is not the same evidence as
    // one produced blind — and it will look identical in the ledger without this.
    task_source: { type: 'string', description: 'observe: 自然任务 | 专门测试 (draft §6) — a task that arose naturally and one set up to test are different evidence' },
    executor_informed: { type: 'string', description: 'observe: did the executor know the evaluation goal/rules/treatment — draft §6 notes the executor here DEFAULTS to knowing, so it must be marked, not assumed' },
    evaluator_blind: { type: 'string', description: 'observe: 盲 | 非盲 (draft §6)' },
    outcome_objective: { type: 'string', description: 'observe: 客观（测试通过/日志） | 需主观判断 (draft §6) — the two do not carry the same weight' },
    model_id: { type: 'string', description: 'update: which model is being revised' },
    // The revision-depth taxonomy is rubric D3 (normative annex, has priority over
    // theory-v0.5's five-level variant — v0.5 adds 变量 but explicitly carries no
    // normative priority). The description previously stopped at `representation`,
    // so the deepest level was simply not on the menu: the agent could not ask the
    // question the rubric names — "是不是 H1/H2/H3 根本切错问题了". Per D3 the
    // taxonomy marks upgrade SPACE; it does not require four separate mechanisms,
    // and the order is not fixed.
    revision_type: {
      type: 'string',
      description: 'update: how deep the revision goes — param | structural | '
        + 'representation | ontological. Mark the DEPTH, not the effort: '
        + 'ontological means the question itself was mis-cut, not that the answer '
        + 'changed. Not a fixed ladder — go to the depth the evidence warrants.',
    },
    change: { type: 'string', description: 'update: what changed' },
    // D4: what to inspect when a mismatch persists AND is structured. The order is
    // not fixed, and none of this is a general H4 algorithm — H4 generation is an
    // open problem; these are the places to look, not a procedure that finds it.
    residual_diagnosis: {
      type: 'string',
      description: 'update: what kind of mismatch this was — isolated anomaly | '
        + 'systematic pattern | boundary failure | new entity type | measurement '
        + 'problem. A persistent STRUCTURED mismatch should send you higher up '
        + 'before you re-tune anything: check the measurement, the variables, the '
        + 'structure/causality, the representation, and the hypothesis space itself.',
    },
    summary: { type: 'string', description: 'persist: one-line summary' },
    confidence_bucket: { type: 'string', description: "qualitative confidence, never a fake precision. 'high' requires a falsifier — an unfalsifiable claim cannot carry high confidence" },
    time_horizon: { type: 'string' },
    // adapter §9 (theory-v0.5 §十一-9): every Observation/预测登记 must carry a
    // namespace — EXTERNAL_REALITY for real-world artifact evidence,
    // MODEL_INTERNAL for the entity's own inference/judgement. An unmarked or
    // unrecognised value clamps to MODEL_INTERNAL: the conservative side,
    // since an unmarked claim must not be able to pose as world evidence.
    namespace: { type: 'string', enum: ['EXTERNAL_REALITY', 'MODEL_INTERNAL'], description: "observe: which domain the recorded fact lives in — real-world artifact evidence is EXTERNAL_REALITY; the entity's own inference is MODEL_INTERNAL and cannot be cited as another prediction's world evidence" },
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

  // The model-visible prediction store lives in host/ (instance runtime state):
  // it is what host/app/host.js injects into the context envelope, so a prediction
  // opened here reaches the model's <open-predictions> block. Binding data
  // (intended_action / irreversible) is not part of that store's schema and
  // lives in the ledger instead — see openPreds below.
  // Predictions are runtime state: they live under stateDir (instance layer),
  // not canonicalDir (governed artifacts). Owner-adjudicated 2026-10-10.
  const predictions = new PredictionStore(stateDir);

  const sessions = new Map();
  let globalSeq = 0;

  // Predictions are durable runtime state: they survive compaction, handoff and
  // body switches via the instance layer (host/src/core/prediction.js says the
  // same). So they live at the adapter level, not per session — and they are RESTORED on startup, which is
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

  // THE CLOSE CHANNEL MUST REACH PREDICTIONS THIS SESSION DID NOT OPEN.
  //
  // theory-v0.5 §九 lists what the mechanism DOES guarantee, and one entry is
  // 「关闭/拦截通道存在」 — the close/intercept channel EXISTS. `evaluate` is that
  // close channel, and it used to resolve ids only against `openPreds`, which was
  // rebuilt from `current.json` alone. A prediction left open by an earlier
  // session lives in the canonical's prediction store — the entity SEES it (it is
  // in the <open-predictions> block) but could not close it: PREDICTION_UNKNOWN.
  // A channel that exists for some predictions and not others is not the channel
  // §九 claims.
  //
  // These are marked `inherited`, which is a real distinction, not bookkeeping:
  //   - closeable  — the entity can settle them (the §九 guarantee)
  //   - not binding — no intended_action of this session's, so they authorise nothing
  //   - not blocking — they are not loops THIS session left dangling, so the exit
  //     gate must not fire on them. Firing would deadlock: nothing ever declares a
  //     carry (measured: 0 STATE_PERSISTED across 8 sessions), so every session
  //     would be stopped by its predecessor's leftovers.
  if (typeof predictions?.openPredictions === 'function') {
    try {
      for (const rec of predictions.openPredictions()) {
        if (!rec || !rec.id || openPreds.has(rec.id)) continue;
        openPreds.set(rec.id, {
          id: rec.id, subject: rec.claim ?? null, intended_action: null,
          irreversible: false, evaluated: false, inherited: true,
        });
      }
    } catch { /* a body whose store cannot list them simply has none to inherit */ }
  }

  const sess = (id) => {
    const key = id || 's1';
    if (!sessions.has(key)) sessions.set(key, { id: key, mode, lastEventId: null });
    return sessions.get(key);
  };

  // adapter §9 (theory-v0.5 §十一-9): every event carries a namespace so
  // MODEL_INTERNAL content can never pose as world evidence. The stamp is
  // channel-determined — events the harness recorded directly (tool results,
  // system lifecycle, governance decisions) are EXTERNAL_REALITY; anything
  // else defaults to MODEL_INTERNAL, the fail-conservative side.
  const NS_EXTERNAL_REALITY = 'EXTERNAL_REALITY';
  const NS_MODEL_INTERNAL = 'MODEL_INTERNAL';
  const EXTERNAL_NS_EVENTS = new Set(['RAW_EVIDENCE', 'SESSION_EVENT', 'WM_ACTIVATE', 'STATE_PERSISTED']);
  const eventNamespaces = new Map(); // event_id -> namespace (this adapter instance's emissions)

  /**
   * Resolve an event id's namespace — this shim's emissions first, then the
   * durable ledger. Without the ledger fallback a MODEL_INTERNAL event from
   * an earlier session would resolve as "unknown" and pass the §9 check:
   * a self-citation from last week is still self-citation. Results (including
   * misses) are cached so each ref costs at most one sweep per shim lifetime.
   */
  /**
   * 03[msg15]: "已经很久没有什么真正改变过你的模型" — the diagnosis between
   * a learning system and an explanation system is COMPUTABLE from the
   * ledger: the age of the newest model-changing event and the newest
   * refuted verdict. status surfaces it so the question stays answerable;
   * honest nulls when the ledger has no such event yet.
   */
  function revisionPulse() {
    const kinds = new Set(['MODEL_UPDATED', 'MODEL_CREATED']);
    let lastModelChange = null, lastRefuted = null;
    try {
      const files = readdirSync(ledgerDir).filter((f) => f.endsWith('.jsonl')).sort().reverse();
      for (const f of files) {
        const lines = readFileSync(join(ledgerDir, f), 'utf8').split('\n').filter(Boolean).reverse();
        for (const l of lines) {
          let e; try { e = JSON.parse(l); } catch { continue; }
          if (!lastModelChange && kinds.has(e.event_type)) {
            lastModelChange = { type: e.event_type, event_id: e.event_id, timestamp: e.timestamp ?? null };
          }
          if (!lastRefuted && e.event_type === 'PREDICTION_EVALUATED' && e.payload?.verdict === 'refuted') {
            lastRefuted = { event_id: e.event_id, timestamp: e.timestamp ?? null };
          }
          if (lastModelChange && lastRefuted) break;
        }
        if (lastModelChange && lastRefuted) break;
      }
    } catch { /* unreadable ledger → honest nulls */ }
    return { last_model_change: lastModelChange, last_refuted: lastRefuted };
  }

  function resolveNamespace(ref) {
    const cached = eventNamespaces.get(ref);
    if (cached === NS_EXTERNAL_REALITY || cached === NS_MODEL_INTERNAL) return cached;
    let found = null;
    try {
      const files = readdirSync(ledgerDir).filter((f) => f.endsWith('.jsonl')).sort().reverse();
      outer: for (const f of files) {
        for (const line of readFileSync(join(ledgerDir, f), 'utf8').split('\n')) {
          if (!line || !line.includes(ref)) continue; // cheap pre-filter before parsing
          try {
            const ev = JSON.parse(line);
            if (ev.event_id === ref) { found = ev.namespace ?? null; break outer; }
          } catch { /* torn tail row */ }
        }
      }
    } catch { /* ledger unreadable — treat as unresolvable, not as evidence */ }
    eventNamespaces.set(ref, found ?? 'UNRESOLVED');
    return found;
  }

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
      // adapter §9: namespace is stamped by CHANNEL, not self-declared by the
      // entity — harness/world-produced facts are EXTERNAL_REALITY, and any
      // model-authored (or unrecognised) content clamps to MODEL_INTERNAL so
      // inference can never silently pose as world evidence.
      namespace: data.namespace === NS_EXTERNAL_REALITY || data.namespace === NS_MODEL_INTERNAL
        ? data.namespace : (EXTERNAL_NS_EVENTS.has(eventType) ? NS_EXTERNAL_REALITY : NS_MODEL_INTERNAL),
      access: 'PRIVATE',
    };
    s.lastEventId = ev.event_id;
    eventNamespaces.set(ev.event_id, ev.namespace);
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
    const sid = session?.id;
    // 04[msg 7]「时间失效」: a prediction whose horizon passed without its
    // expected observation is negative evidence — emit it once (durable
    // stale_notified dedup across restarts), as SESSION_EVENT, which is
    // stamped EXTERNAL_REALITY: the clock passing is a recorded world fact,
    // not a model claim. Surfacing ≠ refuting — the verdict still belongs
    // to evaluate.
    const s = sess(sid);
    if (!s.overdueChecked) {
      s.overdueChecked = true;
      try {
        const fresh = (predictions?.stale?.() ?? []).filter((p) => !p.stale_notified);
        for (const p of fresh) {
          emit(sid, 'SESSION_EVENT', {
            subject: 'prediction_overdue',
            happened: `prediction ${p.id} passed its time horizon with no observation — that lapse is itself negative evidence`,
            payload: { prediction_id: p.id, horizon: p.horizon ?? null, horizon_deadline: p.horizon_deadline ?? null },
          });
        }
        if (fresh.length) predictions.markStaleNotified(fresh.map((p) => p.id));
      } catch { /* a body without a store simply has nothing overdue */ }
    }
    emit(sid, 'SESSION_EVENT', { subject: String(event?.type ?? 'event'), payload: { type: event?.type } });
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
          // §七 conditional gate (rubric B5/02[47]): an empirical claim with no
          // discriminating prediction must not carry 'high' confidence —
          // unfalsifiable high confidence is exactly the flagged blocker.
          if (String(input.confidence_bucket ?? '').toLowerCase() === 'high' && !input.falsifier)
            return { ok: false, code: 'CONFIDENCE_WITHOUT_FALSIFIER', message: "confidence_bucket 'high' requires a falsifier — an unfalsifiable claim cannot carry high confidence" };
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
          // adapter §9: a MODEL_INTERNAL event is the model's own account —
          // citing it as world evidence would let inference re-enter as fact.
          // Resolution covers the durable ledger (prior sessions included);
          // refs to external artifacts (paths, commits, session ids) stay
          // unverifiable and pass through honestly.
          const badRef = (Array.isArray(input.evidence_refs) ? input.evidence_refs : []).find((r) => resolveNamespace(r) === NS_MODEL_INTERNAL);
          if (badRef) return { ok: false, code: 'EVIDENCE_MODEL_INTERNAL', ref: badRef, message: 'MODEL_INTERNAL events cannot be cited as world evidence (adapter §9)' };
          // Mark EVIDENCE ARRIVED on the prediction. This is what makes Update
          // reachable: D1's chain is Prediction → Action → Observation → Update, and
          // it says in terms that Prediction Error is 诊断量 — 与 Observation 比较后
          // 得到 — 不是与 Observation 并列的现实步骤. So the comparison is DERIVED once
          // both halves exist; it is not a step anyone has to perform separately.
          const _p = openPreds.get(pid);
          if (_p) _p.observed = true;
          emit(s.id, 'OBSERVATION_RECORDED', {
            // The entity declares which domain the recorded fact lives in;
            // absent/invalid clamps to MODEL_INTERNAL — an unmarked claim
            // stays on the side that cannot be over-cited.
            namespace: input.namespace === NS_EXTERNAL_REALITY ? NS_EXTERNAL_REALITY : NS_MODEL_INTERNAL,
            subject: input.subject ?? 'observation',
            prediction_id: pid,
            happened: String(input.observation ?? '').slice(0, 500),
            payload: {
              observation: input.observation ?? null,
              evaluation_source: input.evaluation_source ?? null,
              // Evaluation awareness travels WITH the observation, not beside it:
              // it is a property of how this reading was produced, and it is what
              // decides how much the reading can be leaned on later.
              task_source: input.task_source ?? null,
              executor_informed: input.executor_informed ?? null,
              evaluator_blind: input.evaluator_blind ?? null,
              outcome_objective: input.outcome_objective ?? null,
            },
            evidence_refs: input.evidence_refs ?? [],
          });
          return { ok: true, prediction_id: pid };
        }
        case 'evaluate': {
          const pid = input.prediction_id ?? null;
          const p = pid ? openPreds.get(pid) : null;
          if (!pid || !p) return { ok: false, code: 'PREDICTION_UNKNOWN', message: `unknown prediction ${pid}` };
          // Terminal verdicts are immutable (PredictionStore.close returns
          // early on a terminal record). The store already refuses, but the
          // flag must also stop the EVENT: a second PREDICTION_EVALUATED would
          // put a contradictory verdict in the append-only ledger the
          // distiller reads — the trail would claim refuted what the store
          // still holds confirmed.
          if (p.evaluated) return { ok: false, code: 'PREDICTION_ALREADY_EVALUATED', message: `prediction ${pid} already evaluated — verdict is terminal` };
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
          // WHAT UPDATE REQUIRES, per the theory rather than per this codebase.
          // D1's chain reaches Update from OBSERVATION: State → Model → Prediction →
          // Action → Observation → Update. It has no separate evaluation stage, and
          // says so twice — Prediction Error is 诊断量…不是与 Observation 并列的现实步骤,
          // and Revision 是更新机制（非独立环节）. Requiring a separate `evaluate` call was
          // this implementation's own invention, and it is what broke the loop: the
          // entity reaches Observation, stops, and Update stays mechanically out of
          // reach — so no model can ever be revised.
          //
          // The requirement is therefore EVIDENCE: an observation (the comparison is
          // then derivable) or an explicit evaluation (still allowed, and still the
          // better record when the verdict is a judgement rather than a reading).
          const p0 = ref ? openPreds.get(ref) : null;
          if (ref && p0 && !p0.observed && !p0.evaluated) {
            return {
              ok: false,
              code: 'UPDATE_UNEVIDENCED',
              message: `update references prediction ${ref}, which has no observation yet. `
                + 'Observe first — that is where the comparison comes from; the verdict can be '
                + 'derived from prediction + observation and does not need its own step. '
                + '(An explicit op:"evaluate" is still allowed when the verdict is a judgement.)',
            };
          }
          const id = input.model_id ?? `m-${randomUUID().slice(0, 8)}`;
          current.models[id] = {
            revision_type: input.revision_type ?? null,
            residual_diagnosis: input.residual_diagnosis ?? null,
            change: input.change ?? null,
          };
          emit(s.id, 'MODEL_UPDATED', {
            subject: id, prediction_id: ref,
            happened: `model ${id} updated (${input.revision_type ?? 'unspecified'}${
              input.residual_diagnosis ? `; mismatch: ${input.residual_diagnosis}` : ''})`,
            payload: { model_id: id, revision_type: input.revision_type ?? null, change: input.change ?? null },
          });
          return { ok: true, model_id: id };
        }
        case 'persist': {
          // Runtime snapshot = the adapter's own working state (no toolchain
          // reader; kept so a restart can rebuild without replaying the ledger).
          // Full records, not just ids: an id alone cannot be bound on restart.
          //
          // persist is ALSO the exit gate's escape hatch, and that is why it marks
          // the still-open predictions as CARRIED: ending a session with a loop
          // open is legitimate (the outcome may not be knowable yet) — but it has
          // to be deliberate and recorded, not an oversight. `carried` survives the
          // restart, so a deliberately-carried prediction does not block the next
          // session either.
          //
          // The guard cannot catch a SINGLE loop left dangling, because once the
          // task ends there is no next consequential call to refuse — and that was
          // the measured defect (predict → act → observe → stop). This is the one
          // place that can catch it: the end-of-task step. Asking for the reason is
          // cheap; the point is that "I am leaving these open" becomes something the
          // entity SAID rather than something it did not notice.
          // Same notion of 'open' as the guard and as `update`: a prediction with
          // evidence is settled enough that leaving it is not an oversight.
          const stillOpen = [...openPreds.values()].filter((p) => !p.observed && !p.evaluated && !p.inherited);
          if (stillOpen.length && !String(input.summary ?? '').trim()) {
            return {
              ok: false,
              code: 'CARRY_UNDECLARED',
              message: `${stillOpen.length} prediction(s) are still open and unevaluated `
                + `(${stillOpen.map((p) => p.id).join(', ')}). Persisting now would carry them `
                + 'without saying so — which is how a world model accumulates predictions that '
                + 'never become belief. Either settle them (op:"observe" then op:"evaluate"), or '
                + 'give a summary that states you are carrying them deliberately and why.',
            };
          }
          for (const p of openPreds.values()) if (!p.observed && !p.evaluated && !p.inherited) p.carried = true;
          current = {
            schema_version: SCHEMA_VERSION,
            updated_at: new Date().toISOString(),
            open_predictions: [...openPreds.values()].filter((p) => !p.evaluated),
            models: current.models,
            open_loops: current.open_loops,
            body_id: bodyId,
          };
          writeFileSync(join(stateDir, 'current.json'), JSON.stringify(current, null, 2));
          const carriedIds = current.open_predictions.map((p) => p.id);
          emit(s.id, 'STATE_PERSISTED', {
            subject: 'state',
            happened: String(input.summary ?? 'persisted') + (carriedIds.length
              ? ` (carrying ${carriedIds.length} open prediction(s) deliberately: ${carriedIds.join(', ')})`
              : ''),
            payload: { summary: input.summary ?? null, carried: carriedIds },
          });
          return { ok: true, persisted: true, open_predictions: carriedIds };
        }
        case 'status':
          return {
            ok: true, mode: s.mode, body_id: bodyId, bcc: BCC_VERSION,
            session_predictions: [...openPreds.keys()],
            open_predictions: [...openPreds.values()].filter((p) => !p.evaluated).map((p) => p.id),
            overdue_predictions: (() => {
              try { return (predictions?.stale?.() ?? []).map((p) => ({ id: p.id, horizon: p.horizon ?? null, horizon_deadline: p.horizon_deadline ?? null })); }
              catch { return []; }
            })(),
            revision_pulse: revisionPulse(),
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

      // EXIT GATE — the entry gate's mirror. The entry gate makes you open a loop
      // before you act; nothing made you close it, and in two real cross-session
      // runs the loop stopped at observation every time: predict ✅ → act ✅ →
      // observe ✅ → 【stop】. `observe` does not settle a prediction and `update`
      // refuses one without evidence, so an entity that stops at observation left the
      // loop open — the world model accumulated predictions that never became belief.
      //
      // NOT a hard requirement to have evaluated, because that would deadlock the
      // legitimate cross-session case: a prediction about how the world will be
      // found LATER cannot be settled now, and 跨阶段/跨会话继续 is one of the gate
      // criteria's own reasons to be in CORE. So the requirement is: settle it, OR
      // declare that you are carrying it — `persist` is that declaration, and it is
      // recorded. What is refused is leaving it DANGLING without saying so.
      // Same condition as `update`: EVIDENCE settles a loop, not a separate verdict.
      // A prediction with an observation has what D1 needs — the comparison is
      // derivable from it — so refusing on `!evaluated` alone would demand a step the
      // theory does not define.
      const dangling = [...openPreds.values()].find((q) => !q.observed && !q.evaluated
        && !q.carried && !q.inherited && q.id !== p.id && String(q.intended_action || ''));
      if (dangling) {
        return `[world-model] BLOCKED: prediction ${dangling.id} is still OPEN and was never `
          + `settled ("${String(dangling.intended_action).slice(0, 80)}"). You are about to open `
          + 'another loop while the last one is still dangling — that is how a world model '
          + 'accumulates predictions that never become belief. Either close it: '
          + `world_model(op:"observe") then op:"evaluate" against the falsifier you wrote; or, if `
          + 'the outcome genuinely cannot be known yet, say so deliberately: '
          + 'world_model(op:"persist") with a summary — that records the prediction as carried '
          + 'rather than abandoned.';
      }
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
