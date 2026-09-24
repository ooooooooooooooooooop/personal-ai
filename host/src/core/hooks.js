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
 *   'match': optional tool-name prefix filter — the hook only runs for
 *   tool events whose name starts with it (payload.toolName). On the gate
 *   runner it narrows vetoes; on observational runners it narrows noise.
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
  'subagent_start', 'subagent_stop', 'notification',
  // dedup-h #280 (Copilot CLI TurnStarted/UserPromptQueued/TaskStarted/
  // SessionHeartbeat analogue): turn_start = the model turn actually began
  // executing; prompt_queued = a mid-run prompt landed in the follow-up
  // queue; task_started = a durable job's child process exists; heartbeat
  // rides the operator heartbeat.json cadence (no second timer).
  'turn_started', 'prompt_queued', 'task_started', 'session_heartbeat',
  // dedup-h #884 (unstable_Checkpoint analogue): a governed file mutation
  // just receipted its pre-image — payload {op, target, receiptId,
  // toolCallId}. Observational only; the checkpoint already exists.
  'file_checkpoint',
  // dedup-h #1188 (message:* enriched outbound analogue): an assistant
  // message completed and is on its way out — payload {text (≤4000),
  // chars, model, usage}. Observational only; agent_stop is the
  // turn-boundary veto, prompt_submit the inbound transform.
  'message_sent',
  // dedup-h #1698 (llm_input/llm_output payload hooks analogue): the
  // assembled provider request fired pre-send {seq, payloadHash, bytes,
  // preview≤16KB, messages} and the response line fired post-receive
  // {seq, status, headers}. OBSERVATIONAL ONLY — never gate events: a
  // workdir hook must never read-rewrite what the model is sent or told.
  'llm_input', 'llm_output',
]);
// session_directory (dedup-h #202): a gate-only extension event whose hook
// answers {"directory": "..."} to relocate session persistence. Gate-only on
// purpose — the agent-reachable observational file must never redirect where
// transcripts land (that would be a self-service exfiltration path).
// dedup-h #1807 (before_branch hook form): a gate-only query event fired
// on session_fork; the hook answers {"skipConversationRestore": true} to
// branch lineage without inheriting the transcript, or {"deny": reason}
// to refuse the branch. Operator-private plane only — a workdir hook can
// never shape or veto where a session is branched.
export const GATE_EVENTS = new Set(['pre_tool', 'session_directory', 'prompt_submit', 'agent_stop', 'before_branch']);
// dedup-h #1034: 'agent_stop' in the gate file may answer {"block"|"deny":
// "reason"} — the caller re-prompts the agent with the reason instead of
// letting the turn end (Claude Code Stop-hook semantics). An entry flag
// "continueOnBlock": false disables the continuation (block still audits).
// dedup-h #935: 'prompt_submit' joins the gate set — in the operator-private
// <instance>/hooks.json it may answer {"deny":"..."} | {"text":"rewritten"}
// | {"context":"prepended"} (first configured hook answers, fireValue
// contract). In the workspace .pai/hooks.json it stays observational —
// an agent-reachable file can never rewrite what reaches the model.
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_CHARS = 4000;

// dedup-h #1143 — allowPromptInjection: a prompt/agent hook's output is
// MODEL-GENERATED content. Without an explicit opt-in (per-entry
// `allowPromptInjection: true` or config-wide `"allowPromptInjection":
// true`) it may only VETO — deny/block/requireApproval + their reason —
// never inject content fields (text/context/directory/…) into prompts,
// session state, or query answers. Command/http entries are operator-
// authored shell — the trust boundary there is the config file itself.
const VETO_ONLY_KEYS = new Set(['deny', 'block', 'requireApproval', 'reason', 'continueOnBlock']);
const HOOK_ENTRY_KINDS = new Set(['command', 'http', 'prompt', 'agent']);

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
  constructor(workdir, { audit = null, env = process.env, configPath = null, gate = false, envOverlay = null, llmFn = null, fetchImpl = null, resolveExecEnv = null } = {}) {
    this.workdir = workdir;
    this.audit = audit;
    this.env = env;
    this.gate = gate;
    // dedup-h #1334 — plugin-provided exec env: an optional resolver rewrites
    // the command line before spawn (e.g. `sandbox-exec -- ` prefix). Falsy
    // result = provider declines, raw command runs; a THROWN resolver fails
    // closed — a configured containment env must not silently downgrade to an
    // unwrapped spawn. Timeout/killTree/output caps are unchanged and now
    // bound the wrapper's process tree as well.
    this.resolveExecEnv = resolveExecEnv;
    // M121 session env overlay — () => plain object, consulted per spawn.
    // Applied AFTER the secret scrub: an operator (or governed env_set) that
    // deliberately sets a key intends the child to see it.
    this.envOverlay = envOverlay;
    // dedup-h #937 — hook forms beyond shell commands:
    //   {command:"…"}  shell child (original form)
    //   {http:"https://…"}  POST the payload JSON; last-line JSON of the
    //       response body answers gate/value events like a command's stdout
    //   {prompt:"…"} / {agent:"…"}  routed to llmFn(instruction, payload) —
    //       agent is the same model call without a tool loop (honest: we do
    //       not fake a tool-capable sub-agent inside a hook). No llmFn → the
    //       entry counts as failed (observational: audited+skipped; gate:
    //       fails closed).
    this.llmFn = llmFn;
    this.fetch = fetchImpl ?? globalThis.fetch;
    this.configPath = configPath ?? join(workdir, '.pai', 'hooks.json');
    this.hooks = this.#load();
  }

  /** Which runnable form an entry declares; null = not a hook entry. */
  #entryKind(h) {
    if (typeof h?.command === 'string' && h.command.trim()) return 'command';
    if (typeof h?.http === 'string' && /^https?:\/\//.test(h.http.trim())) return 'http';
    if (typeof h?.prompt === 'string' && h.prompt.trim()) return 'prompt';
    if (typeof h?.agent === 'string' && h.agent.trim()) return 'agent';
    return null;
  }

  #load() {
    this.#allowInjection = false;
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
    // dedup-h #1143: allowPromptInjection may sit at doc root or inside
    // `hooks` (a boolean there is a flag, not an event list).
    this.#allowInjection = doc?.allowPromptInjection === true || hooks?.allowPromptInjection === true;
    delete hooks.allowPromptInjection;
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
    // dedup-h #1143: unknown TYPED hook entries are a load-time error, not a
    // silently-dead hook. An entry must declare a known runnable form
    // (command/http/prompt/agent); an explicit `type` field must match a
    // known kind and agree with the field actually present. Gate file
    // throws; the agent-reachable file drops the bad entries + audits.
    for (const [event, list] of Object.entries(hooks)) {
      if (!Array.isArray(list)) {
        if (this.gate) throw new Error(`hooks.json: '${event}' must be an array of hook entries`);
        this.audit?.write({ kind: 'HOOK_CONFIG_ERROR', data: { event, rejectedEntries: 'non-array' } });
        delete hooks[event];
        continue;
      }
      const kept = [];
      for (const h of list) {
        const kind = this.#entryKind(h);
        const typedOk = h?.type === undefined || (HOOK_ENTRY_KINDS.has(h.type) && h.type === kind);
        if (kind && typedOk) kept.push(h);
        else if (this.gate) throw new Error(`hooks.json: '${event}' entry has no known hook form (command/http/prompt/agent) or a mismatched 'type'`);
      }
      if (kept.length !== list.length) {
        this.audit?.write({ kind: 'HOOK_CONFIG_ERROR', data: { event, rejectedEntries: list.length - kept.length, reason: 'unknown hook form' } });
        hooks[event] = kept;
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
    const entries = (this.hooks[event] ?? []).filter((h) =>
      this.#entryKind(h)
      && (typeof h.match !== 'string' || String(payload.toolName ?? '').startsWith(h.match)));
    if (!entries.length || this.#closed) return 0;
    let ran = 0;
    for (const h of entries) {
      ran++;
      const timeoutMs = h.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      this.audit?.write({ kind: 'HOOK_FIRE', data: { event, form: this.#entryKind(h), command: String(h.command ?? h.http ?? h.prompt ?? h.agent ?? '').slice(0, 200) } });
      try {
        const r = await this.#runEntry(h, { event, ...payload }, timeoutMs);
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
      this.#entryKind(h)
      && (typeof h.match !== 'string' || String(payload.tool ?? '').startsWith(h.match)));
    for (const h of entries) {
      const timeoutMs = h.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      this.audit?.write({ kind: 'HOOK_FIRE', data: { event, gate: true, form: this.#entryKind(h), command: String(h.command ?? h.http ?? h.prompt ?? h.agent ?? '').slice(0, 200) } });
      try {
        const r = await this.#runEntry(h, { event, ...payload }, timeoutMs);
        this.audit?.write({ kind: 'HOOK_RESULT', data: { event, gate: true, exitCode: r.code, tail: r.tail.slice(0, 500) } });
        // stdout JSON {"deny":"reason"} is the structured refusal; a bare
        // non-zero exit refuses with the output tail as the reason.
        let structured = null;
        try { structured = JSON.parse(r.tail.trim().split('\n').pop() ?? ''); } catch { /* not JSON */ }
        if (structured && typeof structured.deny === 'string' && structured.deny.trim()) {
          return { deny: structured.deny.slice(0, 500) };
        }
        // dedup-h #109: {"requireApproval":"question"} — the hook neither
        // allows nor denies; it suspends the call on an operator ask. The
        // decide chain resolves it through PendingAsks (async, real card);
        // a hook can never approve, only escalate.
        if (structured && typeof structured.requireApproval === 'string' && structured.requireApproval.trim()) {
          return { requireApproval: structured.requireApproval.slice(0, 500) };
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

  /**
   * Value fire — gate-only query events (session_directory). Runs the event's
   * first configured hook and returns its last-line stdout parsed as JSON.
   * Fails CLOSED by contract of the caller: a configured-but-broken hook
   * throws, so the caller must decide between refusing and a loud fallback —
   * a silent default would scatter state across two locations.
   */
  async fireValue(event, payload = {}) {
    if (!this.gate) throw new Error('fireValue on a non-gate HookRunner — observational hooks cannot answer queries');
    this.hooks = this.#load(); // live re-read, same contract as fireGate
    const entries = (this.hooks[event] ?? []).filter((h) => this.#entryKind(h));
    if (!entries.length) return null;
    const h = entries[0];
    const kind = this.#entryKind(h);
    const timeoutMs = h.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.audit?.write({ kind: 'HOOK_FIRE', data: { event, gate: true, value: true, form: kind, command: String(h.command ?? h.http ?? h.prompt ?? h.agent ?? '').slice(0, 200) } });
    const r = await this.#runEntry(h, { event, ...payload }, timeoutMs);
    this.audit?.write({ kind: 'HOOK_RESULT', data: { event, gate: true, value: true, exitCode: r.code, tail: r.tail.slice(0, 500) } });
    if (r.code !== 0) throw new Error(`${event} hook exited ${r.code}: ${r.tail.trim().slice(0, 300) || 'no output'}`);
    try {
      const answer = JSON.parse(r.tail.trim().split('\n').pop() ?? '');
      // dedup-h #1143: a model-backed hook's answer may only VETO unless the
      // operator opted into prompt injection (entry flag or config-wide).
      // Content fields (text/context/directory/…) are stripped and audited;
      // an answer left with nothing is a loud failure, not an empty allow.
      if ((kind === 'prompt' || kind === 'agent') && !(h.allowPromptInjection === true || this.#allowInjection)) {
        if (answer && typeof answer === 'object') {
          const stripped = Object.keys(answer).filter((k) => !VETO_ONLY_KEYS.has(k));
          if (stripped.length) {
            this.audit?.write({ kind: 'HOOK_INJECTION_REFUSED', data: { event, form: kind, stripped: stripped.slice(0, 16) } });
            for (const k of stripped) delete answer[k];
          }
          if (!Object.keys(answer).length) {
            const err = new Error(`${event} ${kind} hook produced only injection fields — set allowPromptInjection to accept generated content`);
            err.injectionRefused = true;
            throw err;
          }
        }
      }
      // dedup-h #1034: expose the matched entry (non-enumerable, never
      // serialized) so callers can honor per-entry flags like
      // continueOnBlock without re-reading the config file.
      if (answer && typeof answer === 'object') {
        Object.defineProperty(answer, 'hookEntry', { value: h, enumerable: false });
      }
      return answer;
    } catch (err) {
      if (err?.injectionRefused) throw err;
      throw new Error(`${event} hook produced no JSON payload`);
    }
  }

  #closed = false;
  #children = new Set();
  #allowInjection = false;

  /**
   * Run one hook entry in whichever form it declares (#937): shell command,
   * HTTP POST, or LLM prompt/agent. All forms normalize to {code, tail} —
   * the response's last-line JSON carries gate/value answers exactly like a
   * command's stdout.
   */
  async #runEntry(h, payload, timeoutMs) {
    const kind = this.#entryKind(h);
    if (kind === 'command') return this.#run(h.command, payload, timeoutMs);
    if (kind === 'http') {
      try {
        const res = await this.fetch(h.http.trim(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
        let tail = await res.text();
        if (tail.length > MAX_OUTPUT_CHARS) tail = tail.slice(0, MAX_OUTPUT_CHARS);
        return { code: res.ok ? 0 : 1, tail };
      } catch (e) {
        return { code: 1, tail: `http hook failed: ${String(e?.message ?? e).slice(0, 300)}` };
      }
    }
    // prompt / agent — model-backed hook via injected llmFn.
    const instruction = kind === 'prompt' ? h.prompt : h.agent;
    if (!this.llmFn) return { code: 1, tail: `${kind} hook has no llmFn configured (PAI_HOOK_LLM_*)` };
    try {
      const text = await Promise.race([
        this.llmFn(instruction, payload),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`llm hook timed out after ${timeoutMs}ms`)), timeoutMs)),
      ]);
      return { code: 0, tail: String(text ?? '').slice(0, MAX_OUTPUT_CHARS) };
    } catch (e) {
      return { code: 1, tail: `llm hook failed: ${String(e?.message ?? e).slice(0, 300)}` };
    }
  }

  #run(command, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      let finalCommand = command;
      try {
        const wrapped = this.resolveExecEnv?.(command, payload);
        if (wrapped) finalCommand = String(wrapped);
      } catch (e) {
        reject(new Error(`exec env resolution failed: ${String(e?.message ?? e).slice(0, 200)}`));
        return;
      }
      const child = spawn(finalCommand, {
        cwd: this.workdir,
        shell: true,
        windowsHide: true,
        env: { ...(this.gate ? this.env : scrubHookEnv(this.env)), ...(this.envOverlay?.() ?? {}), PAI_HOOK_EVENT: payload.event ?? '' },
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
