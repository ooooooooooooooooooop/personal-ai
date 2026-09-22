/**
 * env_set / env_unset / env_list / env_snapshot — M121 session-level env
 * injection + M122 shell environment snapshot.
 *
 * The overlay applies to child processes WE spawn (durable jobs, hooks,
 * verifier commands, delegate bridges) — merged over the operator's env at
 * each spawn, so later edits apply without a session rebuild. Injection-
 * vector keys (loader flags, PATH, proxies…) are refused inside SessionEnv
 * itself — a tool call must not reopen the channel the MCP spawn boundary
 * strips. env_snapshot returns the effective env with secret-looking values
 * masked, plus an explicit `redacted` key list so "unset" and "hidden" are
 * distinguishable.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureEnvSnapshot } from '../../../host/src/core/sessionenv.js';
import { runDoctor } from '../../../host/src/core/doctor.js';

const err = (text) => ({ content: [{ type: 'text', text }], isError: true });
const ok = (text, details) => ({ content: [{ type: 'text', text }], details });

export function envTools(sessionEnv, { snapshotDir = null } = {}) {
  return [
    {
      name: 'env_set',
      label: 'Set session env var',
      description: 'Set an environment variable applied to child processes spawned by this session (jobs, hooks, verifier, delegate). Loader/path/proxy injection keys are refused.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Env var name (A-Z, 0-9, _)' },
          value: { type: 'string', description: 'Value to set (empty string allowed)' },
        },
        required: ['key', 'value'],
      },
      async execute(_id, params) {
        const r = sessionEnv.set(params?.key, params?.value);
        if (!r.ok) return err(`env_set refused: ${r.reason}`);
        return ok(`env set: ${String(params.key)} (${sessionEnv.vars.size} overlay vars active)`);
      },
    },
    {
      name: 'env_unset',
      label: 'Unset session env var',
      description: 'Remove a key from the session env overlay. The operator env value (if any) is what children see again.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
      },
      async execute(_id, params) {
        const r = sessionEnv.unset(params?.key);
        return ok(r.removed ? `env unset: ${String(params.key)}` : `env unset: ${String(params.key)} (was not in overlay)`);
      },
    },
    {
      name: 'env_list',
      label: 'List session env overlay',
      description: 'List the session env overlay keys. Secret-looking values are masked.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const rows = sessionEnv.list();
        if (!rows.length) return ok('session env overlay is empty — children inherit the operator environment only');
        return ok(rows.map((r) => `${r.key}=${r.value}`).join('\n'), { count: rows.length, overlay: rows });
      },
    },
    {
      name: 'env_snapshot',
      label: 'Snapshot effective env',
      description: 'Capture the effective child environment (operator env + session overlay) with credential values masked. Optional persist to the instance state dir.',
      parameters: {
        type: 'object',
        properties: {
          persist: { type: 'boolean', description: 'Write the snapshot under the instance state dir (default false)' },
        },
      },
      async execute(_id, params) {
        const snap = captureEnvSnapshot({ env: process.env, overlay: sessionEnv.view(), cwd: process.cwd() });
        let file = null;
        if (params?.persist && snapshotDir) {
          mkdirSync(snapshotDir, { recursive: true });
          file = join(snapshotDir, `env-${Date.now()}.json`);
          writeFileSync(file, JSON.stringify(snap, null, 2));
        }
        return ok(
          `env snapshot: ${snap.count} vars (${snap.redacted.length} masked, ${snap.overlayKeys.length} from session overlay)${file ? ` → ${file}` : ''}`,
          { snapshot: snap, file },
        );
      },
    },
  ];
}

/**
 * doctor — M120 environment health-check: runs the host-side check battery
 * (instance dirs, hooks/policy configs, managed-extension integrity,
 * .paiignore, git, node floor, env overlay) and reports pass/warn/fail with
 * a fix suggestion per finding. Read-only; it diagnoses, never repairs.
 */
export function doctorTool(deps) {
  return {
    name: 'doctor',
    label: 'Environment doctor',
    description: 'Run environment health checks over the runtime (instance dirs, configs, extension integrity, git, node) — returns pass/warn/fail with fix suggestions.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const r = await runDoctor(deps);
      const icon = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };
      const lines = r.checks.map((c) => `[${icon[c.status]}] ${c.id}: ${c.detail}${c.fix ? `\n      fix: ${c.fix}` : ''}`);
      lines.push(`— ${r.pass} pass / ${r.warn} warn / ${r.fail} fail`);
      return { content: [{ type: 'text', text: lines.join('\n') }], details: r, isError: r.fail > 0 };
    },
  };
}
