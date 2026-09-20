/**
 * First-run provisioning: create the instance skeleton + a conservative
 * default canonical policy when absent. Instance root must live OUTSIDE any
 * git worktree — host's resolveInstanceRoot enforces that boundary.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { instancePaths } from '../../host/src/core/instance.js';

const DEFAULT_POLICY = {
  version: 1,
  deny: [],
  // network egress is never silent — fetches/searches ask the operator;
  // existing canonical blocks are operator-owned and opt in by adding the rule
  tools: {
    web_fetch: { action: 'ask' },
    web_search: { action: 'ask' },
    // dynamic MCP tools are opaque external effects — prefix rule gates the
    // whole namespace; narrower per-server rules can refine it explicitly
    'mcp__*': { action: 'ask' },
  },
  // destructive commands ask the operator instead of hard-denying — the
  // ask card is the product's governance surface; privilege stays a hard no
  riskActions: { destructive: 'ask', privilege: 'deny' },
};

/**
 * @returns {import('../../host/src/core/contracts.js').InstancePaths}
 */
export function ensureInstance(instanceRoot) {
  const paths = instancePaths(instanceRoot); // throws if inside a git worktree
  for (const dir of [paths.root, paths.auditDir, paths.jobsDir, paths.checkpointsDir, paths.canonicalDir]) {
    mkdirSync(dir, { recursive: true });
  }
  const policyPath = join(paths.canonicalDir, 'policy.json');
  if (!existsSync(policyPath)) {
    writeFileSync(policyPath, JSON.stringify(DEFAULT_POLICY, null, 2));
  } else {
    // additive provisioning for canonicals predating a shipped default:
    // fill only ABSENT default keys — operator-set rules are never touched
    const doc = JSON.parse(readFileSync(policyPath, 'utf-8'));
    let dirty = false;
    doc.tools ??= {};
    for (const [name, rule] of Object.entries(DEFAULT_POLICY.tools)) {
      if (doc.tools[name] === undefined) { doc.tools[name] = rule; dirty = true; }
    }
    if (dirty) writeFileSync(policyPath, JSON.stringify(doc, null, 2));
  }
  return paths;
}
