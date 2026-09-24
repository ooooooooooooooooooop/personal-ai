/**
 * dedup-h #1293 — `!command` apiKey entries in auth.json: shell-evaluated at
 * session build into runtime credentials so plaintext secrets never persist.
 * Fail-closed: a failed/empty eval leaves the literal stored (calls 401
 * visibly) and audits AUTH_BANG_FAILED — nothing is silently substituted.
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { evalBangCommand, applyBangAuth } from '../src/adapter/authbang.js';

const fakeRt = () => {
  const calls = [];
  return { calls, setRuntimeApiKey: async (pid, key) => calls.push([pid, key]) };
};
const auditLog = () => {
  const events = [];
  return { events, write: (e) => events.push(e) };
};
const okSpawn = (value) => (shell, args, opts) => ({ status: 0, stdout: value + '\n', stderr: '' });
const failSpawn = () => () => ({ status: 2, stdout: '', stderr: 'boom' });

test('#1293 !command evaluates via shell and resolves into runtime api key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-bang-'));
  const agentDir = join(dir, 'pi-agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({
    openai: { type: 'api_key', key: '!some-cli read secret' },
    anthropic: { type: 'api_key', key: 'sk-plain-literal' },       // untouched
    google: { type: 'oauth', refresh: 'r', access: 'a', expires: 0 }, // skipped
  }));
  const rt = fakeRt(); const audit = auditLog();
  const r = await applyBangAuth(agentDir, rt, audit, { spawnFn: okSpawn('resolved-secret-value') });
  assert.equal(r.resolved, 1);
  assert.equal(r.failed, 0);
  assert.deepEqual(rt.calls, [['openai', 'resolved-secret-value']]);
  assert.equal(audit.events[0].kind, 'AUTH_BANG_RESOLVED');
  assert.equal(audit.events[0].data.provider, 'openai');
  assert.ok(!JSON.stringify(audit.events).includes('resolved-secret-value'), 'audit never carries the secret');
});

test('#1293 eval failure is fail-closed: no runtime key, literal stays, audited', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-bang-'));
  const agentDir = join(dir, 'pi-agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: '!broken-cmd' } }));
  const rt = fakeRt(); const audit = auditLog();
  const r = await applyBangAuth(agentDir, rt, audit, { spawnFn: failSpawn() });
  assert.equal(r.resolved, 0);
  assert.equal(r.failed, 1);
  assert.equal(rt.calls.length, 0, 'failed eval must NOT inject anything');
  assert.equal(audit.events[0].kind, 'AUTH_BANG_FAILED');
});

test('#1293 empty output refuses; env scrubbed — PAI_ secrets never reach the command env', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-bang-'));
  const agentDir = join(dir, 'pi-agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: '!x' } }));
  let seenEnv = null;
  const spawnFn = (shell, args, opts) => { seenEnv = opts.env; return { status: 0, stdout: '   \n', stderr: '' }; };
  const rt = fakeRt(); const audit = auditLog();
  const env = { ...process.env, PAI_TEST_SESSION_SECRET: 'leak-me-not' };
  const r = await applyBangAuth(agentDir, rt, audit, { spawnFn, env });
  assert.equal(r.failed, 1, 'whitespace-only output refuses');
  assert.equal(rt.calls.length, 0);
  assert.ok(seenEnv && !('PAI_TEST_SESSION_SECRET' in seenEnv), 'scrubHookEnv must strip session secrets from the eval env');
  assert.ok(seenEnv.PATH || seenEnv.Path, 'PATH survives — CLIs still resolvable');
});

test('#1293 absent/corrupt auth.json is a silent no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-bang-'));
  const agentDir = join(dir, 'pi-agent');
  assert.deepEqual(await applyBangAuth(agentDir, fakeRt(), auditLog()), { resolved: 0, failed: 0 });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'auth.json'), '{not json');
  assert.deepEqual(await applyBangAuth(agentDir, fakeRt(), auditLog()), { resolved: 0, failed: 0 });
});

test('#1293 real shell round-trip: !echo resolves the echoed key', { skip: false }, async () => {
  const value = await evalBangCommand(process.platform === 'win32' ? 'echo real-key-123' : 'echo real-key-123');
  assert.equal(value, 'real-key-123');
});

test('#1294 models.json provider apiKey "!command" resolves into the runtime too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-bang-m-'));
  const agentDir = join(dir, 'pi-agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      vaultprov: { baseUrl: 'https://x', api: 'openai-completions', apiKey: '!security find-generic-password -s x -w', models: [] },
      envprov: { baseUrl: 'https://y', apiKey: '$SOME_ENV', models: [] },   // $ENV untouched
      plainprov: { baseUrl: 'https://z', apiKey: 'literal', models: [] },   // literal untouched
    },
  }));
  const rt = fakeRt(); const audit = auditLog();
  const r = await applyBangAuth(agentDir, rt, audit, { spawnFn: okSpawn('vault-fetched-key') });
  assert.equal(r.resolved, 1);
  assert.deepEqual(rt.calls, [['vaultprov', 'vault-fetched-key']]);
});

test('#1294 models.json !command failure refuses closed; auth.json + models.json both scan', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-bang-b-'));
  const agentDir = join(dir, 'pi-agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({ a: { type: 'api_key', key: '!cmd-a' } }));
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { b: { apiKey: '!cmd-b' } } }));
  const rt = fakeRt(); const audit = auditLog();
  const r = await applyBangAuth(agentDir, rt, audit, { spawnFn: failSpawn() });
  assert.equal(r.failed, 2);
  assert.equal(rt.calls.length, 0);
  assert.deepEqual(audit.events.map((e) => e.kind), ['AUTH_BANG_FAILED', 'AUTH_BANG_FAILED']);
});
