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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class ToolSurface {
  /**
   * @param {object} deps
   * @param {{getActiveToolNames:()=>string[], setActiveToolsByName:(n:string[])=>void}} deps.session
   *        the AgentSession — surface control is session-level in 0.85.1
   * @param {string} deps.denyMemoryPath  <instance>/deny-memory.json
   * @param {string[]} [deps.initialDeny] tools hidden from turn zero
   */
  constructor({ session, denyMemoryPath, initialDeny = [] }) {
    this.session = session;
    this.denyMemoryPath = denyMemoryPath;
    mkdirSync(dirname(denyMemoryPath), { recursive: true });
    this.denied = new Set([
      ...initialDeny,
      ...(existsSync(denyMemoryPath) ? JSON.parse(readFileSync(denyMemoryPath, 'utf-8')) : []),
    ]);
    this.modeDenied = new Set();
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
    const visible = active.filter((n) => !this.denied.has(n));
    if (!visible.includes(toolName)) visible.push(toolName); // re-add hidden tool
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
    const visible = candidates.filter((n) => !this.denied.has(n) && !this.modeDenied.has(n));
    this.lastModeHidden = candidates.filter((n) => this.modeDenied.has(n));
    this.session.setActiveToolsByName(visible);
  }

  isDenied(toolName) {
    return this.denied.has(toolName);
  }

  #persist() {
    writeFileSync(this.denyMemoryPath, JSON.stringify([...this.denied].sort()));
  }

  #apply() {
    const active = this.session.getActiveToolNames();
    const visible = active.filter((n) => !this.denied.has(n) && !this.modeDenied.has(n));
    if (visible.length !== active.length) {
      this.session.setActiveToolsByName(visible);
    }
  }
}

export function defaultDenyMemoryPath(instanceRoot) {
  return join(instanceRoot, 'deny-memory.json');
}
