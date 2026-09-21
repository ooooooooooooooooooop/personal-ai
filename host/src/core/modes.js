/**
 * Mode presets — Policy Preset Overlay (Roo custom-mode analogue, adapted to
 * our lattice). A preset is a NAMED SESSION OVERLAY compiled onto the
 * existing policy/ToolSurface decision path — never an independent engine.
 *
 * Schema (<instance>/modes.json and <workdir>/.pai/modes.json; project file
 * wins on name collision, matching .roomodes precedence):
 *   { "modes": [{
 *     "name": "review",
 *     "description": "read-mostly review posture",
 *     "whenToUse": "auditing changes before merge",
 *     "toolDeny": ["write","edit","delete"],
 *     "toolAsk":  ["bash","mcp__*"],
 *     "toolAllow":["read","ls","grep"],          // bypasses defaultAction
 *     "pathAsk":  ["migrations/**"],
 *     "pathDeny": ["prod-config/**"],
 *     "defaultAction": "ask",                     // 'allow'|'ask'
 *     "hideTools": ["deploy"]                     // session-scoped surface hide
 *   }] }
 *
 * HARD RULE — structural, not validated: the overlay resolves AFTER the
 * canonical kernel paths (explicit deny, protected roots, unparseable,
 * risk classes, plan mode). It can only ADD ask/deny — a preset can never
 * turn a canonical deny into an allow, so loading is safe by construction.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const VALID_ACTIONS = new Set(['allow', 'ask', 'deny']);

function validatePreset(p) {
  if (!p?.name || typeof p.name !== 'string') return 'name required';
  for (const k of ['toolDeny', 'toolAsk', 'toolAllow', 'pathAsk', 'pathDeny', 'hideTools']) {
    if (p[k] != null && !Array.isArray(p[k])) return `${k} must be an array`;
  }
  if (p.defaultAction != null && !VALID_ACTIONS.has(p.defaultAction)) {
    return `defaultAction must be allow|ask|deny`;
  }
  return null;
}

/** Validate a whole modes.json doc before it is written (UI save path). */
export function validateModesDoc(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.modes)) return 'doc must be {modes:[...]}';
  const names = new Set();
  for (const p of doc.modes) {
    const err = validatePreset(p);
    if (err) return `preset '${p?.name ?? '?'}': ${err}`;
    if (names.has(p.name)) return `duplicate preset name '${p.name}'`;
    names.add(p.name);
  }
  return null;
}

function globRe(pat) {
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') { re += (pat[i + 1] === '*') ? (i++, '.*') : '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export class ModePresets {
  /**
   * @param {string} instanceRoot — <instance>/modes.json
   * @param {string} workdir — <workdir>/.pai/modes.json (project wins)
   */
  constructor({ instanceRoot, workdir }) {
    this.presets = new Map();
    this.#load(join(instanceRoot, 'modes.json'), 'instance');
    this.#load(join(workdir, '.pai', 'modes.json'), 'project');
  }

  #load(file, source) {
    if (!existsSync(file)) return;
    let doc;
    try { doc = JSON.parse(readFileSync(file, 'utf-8')); }
    catch (e) { throw new Error(`modes.json malformed (${file}): ${e.message}`); }
    for (const p of doc?.modes ?? []) {
      const err = validatePreset(p);
      if (err) throw new Error(`modes.json preset '${p?.name ?? '?'}' (${file}): ${err}`);
      this.presets.set(p.name, { ...p, source, file });
    }
  }

  /** Plain-data catalog for the mode chip / settings surface. */
  list() {
    return [...this.presets.values()].map((p) => ({
      name: p.name,
      description: p.description ?? '',
      whenToUse: p.whenToUse ?? '',
      source: p.source,
    }));
  }

  /**
   * Compile a preset into the runtime overlay the kernel consumes.
   * Unknown name → null (callers fail closed on a bogus selection).
   */
  compile(name) {
    const p = this.presets.get(name);
    if (!p) return null;
    const toolActions = {};
    for (const t of p.toolAllow ?? []) toolActions[t] = 'allow';
    for (const t of p.toolAsk ?? []) toolActions[t] = 'ask';
    for (const t of p.toolDeny ?? []) toolActions[t] = 'deny';
    return {
      name: p.name,
      toolActions,
      allowSet: new Set(p.toolAllow ?? []),
      pathRules: [
        ...(p.pathAsk ?? []).map((g) => ({ re: globRe(g), action: 'ask', pattern: g })),
        ...(p.pathDeny ?? []).map((g) => ({ re: globRe(g), action: 'deny', pattern: g })),
      ],
      defaultAction: p.defaultAction ?? 'allow',
      hideTools: p.hideTools ?? [],
      hash: createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 12),
    };
  }
}
