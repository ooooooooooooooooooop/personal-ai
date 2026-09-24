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
import { captureEnvSnapshot, ENV_INJECT_RE, KEY_RE } from '../../../host/src/core/sessionenv.js';
import { runDoctor } from '../../../host/src/core/doctor.js';
import { parseSecretRef, resolveSecretRef } from '../../../host/src/core/secretsource.js';

const err = (text) => ({ content: [{ type: 'text', text }], isError: true });
const ok = (text, details) => ({ content: [{ type: 'text', text }], details });

export function envTools(sessionEnv, { snapshotDir = null, asks = null, instanceRoot = null, audit = null, spawnFn = null } = {}) {
  return [
    {
      name: 'env_set',
      label: 'Set session env var',
      description:
        'Set an environment variable applied to child processes spawned by this session (jobs, hooks, verifier, delegate). ' +
        'Loader/path/proxy injection keys are refused. A value of the form op://<vault>/<item>/<field> or bw://<item>[/<field>] ' +
        'is resolved through a password-manager secret source enabled in the instance secrets.json and stored masked.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Env var name (A-Z, 0-9, _)' },
          value: { type: 'string', description: 'Value to set — literal, or an op:// / bw:// secret reference' },
        },
        required: ['key', 'value'],
      },
      async execute(_id, params) {
        const key = String(params?.key ?? '');
        const value = params?.value;
        // dedup-h #820 — secret-source references resolve through the
        // operator-configured CLI and land via setSecret, so the real value
        // is masked on every read surface and never appears in this result.
        if (parseSecretRef(value)) {
          const r = resolveSecretRef(value, { instanceRoot, spawnFn });
          audit?.({ type: 'secret_source_resolve', tool: 'env_set', key, scheme: r.scheme ?? parseSecretRef(value)?.scheme, item: r.item ?? null, ok: r.ok === true });
          if (!r.ok) return err(`env_set '${key}': ${r.reason}`);
          const s = sessionEnv.setSecret(key, r.value);
          if (!s.ok) return err(`env_set refused: ${s.reason}`);
          return ok(`env set: ${key} — resolved via ${r.scheme} secret source, stored masked (${sessionEnv.vars.size} overlay vars active)`);
        }
        const r = sessionEnv.set(key, value);
        if (!r.ok) return err(`env_set refused: ${r.reason}`);
        return ok(`env set: ${key} (${sessionEnv.vars.size} overlay vars active)`);
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
    // dedup-h #697 — masked credential prompt: the model asks the operator
    // to type a secret; the value lands in the session env overlay marked
    // unconditionally secret and NEVER enters the tool args, the tool
    // result, or any transcript surface. The model cannot pass the value
    // itself — the schema carries only the key name and a reason.
    ...(asks?.ask
      ? [{
          name: 'credential_request',
          label: 'Request credential',
          description:
            'Ask the operator to type a credential into a masked prompt; the value is stored in the session env overlay ' +
            '(visible to spawned jobs/hooks/delegate children) without ever appearing in this conversation. Use when a ' +
            'command needs a token/key the model must not see.',
          parameters: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Env var name to store the credential under (A-Z, 0-9, _)' },
              reason: { type: 'string', description: 'Why this credential is needed (shown to the operator)' },
            },
            required: ['key'],
          },
          async execute(_id, params) {
            const key = String(params?.key ?? '').trim();
            if (!key) return err('credential_request requires {key}');
            // Refuse BEFORE the operator ever types: an injection-vector or
            // malformed key can never store, so asking for it is wasted.
            if (!KEY_RE.test(key) || ENV_INJECT_RE.test(key)) {
              return err(`credential_request refused: '${key.slice(0, 40)}' is not a storable env key`);
            }
            const answer = await asks.ask({
              toolName: 'credential_request',
              kind: 'form',
              rule: 'credential_request',
              summary: `agent 请求会话凭据 '${key}'（输入值不会进入对话）`,
              detail: String(params?.reason ?? '').slice(0, 500) || null,
              fields: [{
                key: 'value',
                label: `凭据值 → ${key}`,
                type: 'secret',
                required: true,
                description: '值存入会话环境变量后对所有读取面打码；模型永远看不到它。',
              }],
            });
            if (!answer || typeof answer !== 'object') {
              return err(`credential_request '${key}' refused (${typeof answer === 'string' ? answer : 'no answer'})`);
            }
            const r = sessionEnv.setSecret(key, String(answer.value ?? ''));
            if (!r.ok) return err(`credential_request refused: ${r.reason}`);
            return ok(`credential stored as session env '${key}' — value is masked on every read surface`);
          },
        }]
      : []),
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
