/**
 * Model routing (operator-declared) — <instance>/model-routes.json.
 *
 * The gap this closes: profile frontmatter can pin model/effort, but only
 * when the model happens to choose that profile. The OPERATOR's intent —
 * "review-class work goes to the strong model, fetch-class work to the
 * cheap one" — had no deterministic seat; it rode on prompt luck.
 *
 * Honest scope: routing is a deterministic rule table the operator writes,
 * never an LLM judge (privacy boundary + reproducibility). A rule matches
 * on the admission-time facts a delegation already has: the profile name,
 * the resolved target, and a regex over the task text. Rules fill only the
 * slots the profile left open — precedence is:
 *
 *   profile frontmatter  >  first matching route  >  "default" block
 *
 * The file lives in the instance root (operator-private) on purpose:
 * routing steers spend, so a workdir must never plant it — same trust
 * posture as model-fallbacks.json.
 *
 * Shape:
 *   {
 *     "default": { "model": "claude-sonnet-5", "effort": "medium" },
 *     "routes": [
 *       { "name": "deep-review", "task": "审查|review|audit",
 *         "model": "claude-opus-5", "effort": "high" },
 *       { "name": "cheap-research", "profile": "researcher",
 *         "model": "claude-haiku-4-5" }
 *     ]
 *   }
 *
 * dedup-h #2118 (crush "Adaptive" default model): top-level
 * `"adaptive": true` opts the MAIN session into the same table — each
 * prompt resolves against its text and switches the session model/effort
 * per turn. An explicit model pick (model_set/config_set model) pins the
 * session out of adaptive routing; alias 'adaptive' un-pins.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_RULES = 16;

const cleanModel = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null);
const cleanEffort = (v) => (typeof v === 'string' && /^(low|medium|high|max)$/i.test(v.trim()) ? v.trim().toLowerCase() : null);

/**
 * Load + validate the routing table. Absent/invalid file → null (no routing,
 * same as before). Invalid RULES drop individually — one bad regex must not
 * blind the whole table.
 * @returns {{default: {model?, effort?}|null, routes: Array, adaptive: boolean}|null}
 */
export function loadModelRoutes(instanceRoot) {
  let raw;
  try { raw = JSON.parse(readFileSync(join(instanceRoot, 'model-routes.json'), 'utf-8')); }
  catch { return null; }
  const routes = [];
  for (const [i, r] of (Array.isArray(raw?.routes) ? raw.routes : []).entries()) {
    if (!r || typeof r !== 'object') continue;
    let taskRe = null;
    if (r.task != null) {
      try { taskRe = new RegExp(String(r.task), 'i'); }
      catch { continue; } // uncompilable matcher — drop the rule, not the table
    }
    const model = cleanModel(r.model);
    const effort = cleanEffort(r.effort);
    if (!model && !effort) continue; // a rule that sets nothing routes nothing
    routes.push({
      name: typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 60) : `route-${i}`,
      profile: typeof r.profile === 'string' && r.profile.trim() ? r.profile.trim().toLowerCase() : null,
      target: typeof r.target === 'string' && r.target.trim() ? r.target.trim() : null,
      taskRe,
      model, effort,
    });
    if (routes.length >= MAX_RULES) break;
  }
  const def = raw?.default && typeof raw.default === 'object'
    ? { model: cleanModel(raw.default.model), effort: cleanEffort(raw.default.effort) }
    : null;
  const usableDefault = def && (def.model || def.effort) ? def : null;
  if (!routes.length && !usableDefault) return null;
  return { default: usableDefault, routes, adaptive: raw?.adaptive === true };
}

/**
 * First-match resolution. A rule matches when every condition it declares
 * holds: profile name (the one the caller passed), resolved target, task
 * regex. Falls through to the default block when no rule matches.
 * @returns {{model: string|null, effort: string|null, via: string}|null}
 */
export function resolveRoute(cfg, { profile = null, target = null, task = '' } = {}) {
  if (!cfg) return null;
  for (const r of cfg.routes) {
    if (r.profile && r.profile !== profile) continue;
    if (r.target && r.target !== target) continue;
    if (r.taskRe && !r.taskRe.test(task)) continue;
    return { model: r.model, effort: r.effort, via: r.name };
  }
  if (cfg.default) return { model: cfg.default.model, effort: cfg.default.effort, via: 'default' };
  return null;
}
