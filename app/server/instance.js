/**
 * First-run provisioning: create the instance skeleton + a conservative
 * default canonical policy when absent. Instance root must live OUTSIDE any
 * git worktree — host's resolveInstanceRoot enforces that boundary.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { instancePaths } from '../../host/src/core/instance.js';

const DEFAULT_POLICY = {
  version: 1,
  deny: [],
  tools: {},
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
  }
  return paths;
}
