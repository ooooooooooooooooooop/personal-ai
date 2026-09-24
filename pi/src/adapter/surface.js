/**
 * Tool-surface governance — deny→hide and deny→stop-turn semantics.
 *
 * Two distinct suppression mechanisms (they are NOT interchangeable):
 *  - initial suppression: `excludeTools` at createAgentSession time — tools the
 *    model should never see from turn zero.
 *  - runtime deny→hide: `agent-harness.setActiveTools` — after a denial, the
 *    tool is removed from the visible surface so the model stops retrying it
 *    (OpenCode-style). Persisted to <instance>/deny-memory.json so a restart
 *    reproduces the same visible surface.
 *
 * deny→stop-turn is separate: a decision {block:true, terminate:true} ends the
 * whole tool batch (Crush semantics) — the kernel sets terminate; this module
 * only handles surface visibility.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class ToolSurface {
  /**
   * @param {object} deps
   * @param {{getActiveToolNames:()=>string[], setActiveToolsByName:(n:string[])=>void}} deps.session
   *        the AgentSession — surface control is session-level in 0.85.1
   * @param {string} deps.denyMemoryPath  <instance>/deny-memory.json
   * @param {string[]} [deps.initialDeny] tools hidden from turn zero
   * @param {string[]} [deps.allowedTools] dedup-h #1112 — when set, ONLY
   *        these names (trailing * = prefix) may be visible/activatable;
   *        session-scoped, never persisted (a delegate child's stamp)
   */
  constructor({ session, denyMemoryPath, initialDeny = [], allowedTools = null }) {
    this.session = session;
    this.denyMemoryPath = denyMemoryPath;
    mkdirSync(dirname(denyMemoryPath), { recursive: true });
    // torn/invalid deny-memory must not brick bootstrap — an unreadable store
    // degrades to the initial deny set (fail-open on VISIBILITY only; the
    // kernel's per-call decide still gates execution underneath)
    let persisted = [];
    if (existsSync(denyMemoryPath)) {
      try {
        const parsed = JSON.parse(readFileSync(denyMemoryPath, 'utf-8'));
        if (Array.isArray(parsed)) persisted = parsed.filter((n) => typeof n === 'string');
      } catch { /* corrupt store — start from initialDeny */ }
    }
    this.denied = new Set([...initialDeny, ...persisted]);
    this.modeDenied = new Set();
    // M83 deferred tools — session-scoped lazy surface. Unlike denied, lazy
    // tools are NOT persisted and NOT governance denials: they are hidden to
    // keep the schema prompt small until tool_activate claims them.
    this.lazy = new Set();
    this.lastLazyHidden = [];
    // allowlist hides are session-scoped like modeDenied — never persisted
    this.allowedOk = toolAllowMatcher(allowedTools) ?? (() => true);
    if (initialDeny.length) this.#persist(); // initial suppression is durable too
  }

  /** Deny a tool: record + hide from the active surface immediately. */
  deny(toolName) {
    this.denied.add(toolName);
    this.#persist();
    this.#apply();
  }

  /** Restore a tool (policy change / operator override). */
  allow(toolName) {
    this.denied.delete(toolName);
    this.#persist();
    const active = this.session.getActiveToolNames();
    const visible = active.filter((n) => !this.denied.has(n) && this.allowedOk(n));
    if (!visible.includes(toolName) && this.allowedOk(toolName)) visible.push(toolName); // re-add hidden tool — never past the allowlist
    this.session.setActiveToolsByName(visible);
  }

  /** Re-assert the visible surface — call on session start / reload. */
  reconcile() {
    this.#apply();
  }

  /**
   * Session-scoped mode hide (Policy Preset Overlay `hideTools`). NOT
   * persisted — a mode posture dies with the session/mode switch, unlike
   * operator denials which are durable deny-memory.
   */
  setModeDenied(names) {
    // candidates must include tools hidden by the PREVIOUS mode so a mode
    // switch can restore them — the active list alone has already lost them
    const candidates = [...this.session.getActiveToolNames(), ...(this.lastModeHidden ?? [])];
    this.modeDenied = new Set(names ?? []);
    const visible = candidates.filter((n) => !this.denied.has(n) && !this.modeDenied.has(n) && this.allowedOk(n));
    this.lastModeHidden = candidates.filter((n) => this.modeDenied.has(n));
    this.session.setActiveToolsByName(visible);
  }

  /**
   * Defer tools (lazy surface): hide without denying. Candidates must include
   * tools already hidden lazy/deferred so re-deferring doesn't lose them —
   * same candidates mechanism as setModeDenied.
   */
  defer(names) {
    const candidates = [...this.session.getActiveToolNames(), ...this.lastLazyHidden];
    this.lazy = new Set(names ?? []);
    const visible = candidates.filter((n) => !this.denied.has(n) && !this.modeDenied.has(n) && !this.lazy.has(n) && this.allowedOk(n));
    this.lastLazyHidden = candidates.filter((n) => this.lazy.has(n));
    this.session.setActiveToolsByName(visible);
  }

  /** Activate deferred tools: re-add to the visible surface. Returns the names actually activated. */
  activate(names) {
    const want = new Set((names ?? []).map(String));
    const activated = [];
    for (const n of want) {
      if (!this.activatable(n)) continue;
      this.lazy.delete(n);
      activated.push(n);
    }
    if (activated.length) {
      const active = this.session.getActiveToolNames();
      const visible = active.filter((n) => !this.denied.has(n) && !this.modeDenied.has(n) && !this.lazy.has(n) && this.allowedOk(n));
      for (const n of activated) if (!visible.includes(n) && this.allowedOk(n)) visible.push(n);
      this.lastLazyHidden = this.lastLazyHidden.filter((n) => this.lazy.has(n));
      this.session.setActiveToolsByName(visible);
    }
    return activated;
  }

  isLazy(toolName) {
    return this.lazy.has(toolName);
  }

  /** M83: lazy AND not denied AND not mode-hidden — the only tools the model
   * may discover or claim via tool_search/tool_activate. */
  activatable(toolName) {
    return this.lazy.has(toolName) && !this.denied.has(toolName) && !this.modeDenied.has(toolName) && this.allowedOk(toolName);
  }

  lazyList() {
    return [...this.lazy];
  }

  isDenied(toolName) {
    return this.denied.has(toolName);
  }

  #persist() {
    // atomic: a crash mid-write must not leave a torn store that bricks the
    // NEXT bootstrap (the constructor tolerates it, but durability of the
    // deny set is the whole point of this file)
    const tmp = `${this.denyMemoryPath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify([...this.denied].sort()));
    renameSync(tmp, this.denyMemoryPath);
  }

  #apply() {
    const active = this.session.getActiveToolNames();
    const visible = active.filter((n) => !this.denied.has(n) && !this.modeDenied.has(n) && !this.lazy.has(n) && this.allowedOk(n));
    if (visible.length !== active.length) {
      this.session.setActiveToolsByName(visible);
    }
  }
}

/**
 * dedup-h #1112 — an allowlist matcher: exact names plus trailing-*
 * prefixes. Null/empty input → null (no allowlist in force).
 */
export function toolAllowMatcher(names) {
  const list = (names ?? []).map((n) => String(n).trim()).filter((n) => /^[a-zA-Z][\w*-]*$/.test(n)).slice(0, 64);
  if (!list.length) return null;
  const exact = new Set();
  const prefixes = [];
  for (const n of list) {
    if (n.endsWith('*')) prefixes.push(n.slice(0, -1));
    else exact.add(n);
  }
  return (name) => exact.has(name) || prefixes.some((p) => name.startsWith(p));
}

export function defaultDenyMemoryPath(instanceRoot) {
  return join(instanceRoot, 'deny-memory.json');
}
