/**
 * M121 session env overlay + M122 env snapshot — the overlay reaches only
 * children WE spawn (jobs/hooks/verify/delegate); injection-vector keys are
 * refused at set-time inside SessionEnv; snapshots mask secret values.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionEnv, captureEnvSnapshot } from '../../host/src/core/sessionenv.js';
import { envTools } from '../src/adapter/envtools.js';
import { HookRunner } from '../../host/src/core/hooks.js';

function fakeAudit() { const events = []; return { events, write: (e) => events.push(e) }; }

test('env_set: ordinary keys accepted; injection-vector keys hard-refused + audited', async () => {
  const audit = fakeAudit();
  const env = new SessionEnv({ audit });
  const [set, , list] = envTools(env);
  const ok = await set.execute('t1', { key: 'MY_FLAG', value: 'on' });
  assert.equal(ok.isError, undefined);
  assert.equal(env.view().MY_FLAG, 'on');

  for (const bad of ['NODE_OPTIONS', 'PATH', 'LD_PRELOAD', 'HTTP_PROXY', 'GIT_SSH_COMMAND', 'PYTHONSTARTUP']) {
    const r = await set.execute('t2', { key: bad, value: 'x' });
    assert.equal(r.isError, true, `${bad} refused`);
    assert.match(r.content[0].text, /injection/);
  }
  assert.ok(audit.events.filter((e) => e.kind === 'ENV_SET_REFUSED').length >= 6);
  assert.deepEqual(Object.keys(env.view()), ['MY_FLAG']);

  const bad2 = await set.execute('t3', { key: '1BAD KEY!', value: 'x' });
  assert.equal(bad2.isError, true);
});

test('env_list masks secret-looking values; view() carries them for spawn', async () => {
  const env = new SessionEnv({});
  env.set('CHILD_API_TOKEN', 'sekrit');
  env.set('PLAIN_VAR', 'v');
  const [, , list] = envTools(env);
  const r = await list.execute('t4', {});
  assert.match(r.content[0].text, /CHILD_API_TOKEN=\[REDACTED\]/);
  assert.match(r.content[0].text, /PLAIN_VAR=v/);
  assert.equal(env.view().CHILD_API_TOKEN, 'sekrit'); // real value intact for spawn merge
});

test('env overlay reaches hook child process env (post-scrub merge)', async () => {
  const w = mkdtempSync(join(tmpdir(), 'pai-env-'));
  writeFileSync(join(w, 'x'), '');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(w, '.pai'), { recursive: true });
  const outFile = join(w, 'out.json');
  const script = join(w, 'dump.js');
  writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({o:process.env.MY_OVERLAY??null,t:process.env.HOOK_TOKEN??null}));`);
  writeFileSync(join(w, '.pai', 'hooks.json'), JSON.stringify({ hooks: { session_start: [{ command: `node ${JSON.stringify(script)}` }] } }));

  const env = new SessionEnv({});
  env.set('MY_OVERLAY', 'from-session');
  env.set('HOOK_TOKEN', 'tok-123'); // secret-looking but operator/session-set → survives scrub
  const h = new HookRunner(w, { env: { PATH: process.env.PATH }, envOverlay: () => env.view() });
  await h.fire('session_start');
  const seen = JSON.parse(readFileSync(outFile, 'utf-8'));
  assert.equal(seen.o, 'from-session');
  assert.equal(seen.t, 'tok-123');
});

test('env_snapshot masks operator secrets; overlay keys flagged; persist writes file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-snap-'));
  const env = new SessionEnv({});
  env.set('SESSION_FLAG', 'y');
  const [, , , snapTool] = envTools(env, { snapshotDir: dir });
  const prev = process.env.FAKE_SNAP_KEY;
  process.env.FAKE_SNAP_KEY = 'sk-live';
  try {
    const r = await snapTool.execute('t5', { persist: true });
    const snap = r.details.snapshot;
    assert.equal(snap.vars.FAKE_SNAP_KEY, '[REDACTED]');
    assert.ok(snap.redacted.includes('FAKE_SNAP_KEY'));
    assert.equal(snap.vars.SESSION_FLAG, 'y');
    assert.deepEqual(snap.overlayKeys, ['SESSION_FLAG']);
    assert.ok(existsSync(r.details.file));
    const persisted = JSON.parse(readFileSync(r.details.file, 'utf-8'));
    assert.equal(persisted.vars.FAKE_SNAP_KEY, '[REDACTED]'); // disk copy is masked too
  } finally {
    if (prev === undefined) delete process.env.FAKE_SNAP_KEY; else process.env.FAKE_SNAP_KEY = prev;
  }
});

test('captureEnvSnapshot unit: overlay wins over base env', () => {
  const s = captureEnvSnapshot({ env: { A: 'base', B: 'b' }, overlay: { A: 'over' }, at: 't' });
  assert.equal(s.vars.A, 'over');
  assert.equal(s.vars.B, 'b');
  assert.deepEqual(s.overlayKeys, ['A']);
});

// ---- dedup-h #697: credential_request — masked prompt, value never enters chat/model ----

test('credential_request: absent without operator channel (fail-closed surface)', () => {
  const env = new SessionEnv({});
  const tools = envTools(env);
  assert.ok(!tools.some((t) => t.name === 'credential_request'), 'no asks channel → tool not advertised');
});

test('credential_request: secret field schema; value stored masked, never echoed', async () => {
  const env = new SessionEnv({});
  let seen = null;
  const asks = {
    ask: async (d) => { seen = d; return { value: 'sk-live-9' }; },
  };
  const cred = envTools(env, { asks }).find((t) => t.name === 'credential_request');
  assert.ok(cred);
  const r = await cred.execute('c1', { key: 'MY_SERVICE', reason: 'deploy needs it' });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  // the ask card: form kind, single secret field, no value in the descriptor
  assert.equal(seen.kind, 'form');
  assert.equal(seen.fields[0].type, 'secret');
  assert.equal(seen.fields[0].required, true);
  assert.ok(!JSON.stringify(seen).includes('sk-live-9'), 'descriptor must not carry the value');
  // value landed in the overlay for spawned children — real value in view()
  assert.equal(env.view().MY_SERVICE, 'sk-live-9');
  // every read surface masks it — even though the name has no secret pattern
  assert.equal(env.list().find((x) => x.key === 'MY_SERVICE').value, '[REDACTED]');
  assert.equal(env.list().find((x) => x.key === 'MY_SERVICE').sensitive, true);
  // the tool result itself never carries the secret
  assert.ok(!JSON.stringify(r).includes('sk-live-9'));
});

test('credential_request: non-form answer refused; injection keys rejected before asking', async () => {
  const env = new SessionEnv({});
  let asked = 0;
  const asks = { ask: async () => { asked++; return 'timeout'; } };
  const cred = envTools(env, { asks }).find((t) => t.name === 'credential_request');
  const refused = await cred.execute('c2', { key: 'SOME_KEY' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /refused \(timeout\)/);
  assert.equal(env.view().SOME_KEY, undefined, 'refused credential must not be stored');

  for (const bad of ['PATH', 'NODE_OPTIONS', 'not a key']) {
    const r = await cred.execute('c3', { key: bad });
    assert.equal(r.isError, true, bad);
  }
  assert.equal(asked, 1, 'injection-vector keys never reach the operator card');
});

test('env_set: op:// / bw:// refs resolve via secrets.json source and store masked (#820)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-sec-'));
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ sources: { op: { bin: 'op' }, bw: { bin: 'bw' } } }));
  const audit = fakeAudit();
  const env = new SessionEnv({ audit });
  const audits = [];
  const spawn = (bin, args) => {
    if (bin === 'op') { assert.equal(args[0], 'read'); return 'tok-live-99\n'; }
    return JSON.stringify({ login: { password: 'bw-pw' } });
  };
  const [set, , list] = envTools(env, { instanceRoot: dir, audit: (e) => audits.push(e), spawnFn: spawn });

  const r = await set.execute('s1', { key: 'API_TOKEN', value: 'op://prod/db/password' });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.match(r.content[0].text, /resolved via op secret source/);
  assert.equal(env.view().API_TOKEN, 'tok-live-99');
  // masked on the list surface regardless of key naming
  const lr = await list.execute('s2', {});
  assert.match(lr.content[0].text, /API_TOKEN=\[REDACTED\]/);
  assert.ok(!lr.content[0].text.includes('tok-live-99'));
  // audit carries scheme+item, never the value
  assert.deepEqual(audits[0].item, 'prod/db');
  assert.ok(JSON.stringify(audits).includes('prod/db') && !JSON.stringify(audits).includes('tok-live-99'));

  const r2 = await set.execute('s3', { key: 'LEGACY_PW', value: 'bw://legacy-svc' });
  assert.equal(r2.isError, undefined);
  assert.equal(env.view().LEGACY_PW, 'bw-pw');

  // managed scheme absent from secrets.json refuses closed — no spawn, no store
  const dir2 = mkdtempSync(join(tmpdir(), 'pai-sec-none-'));
  const [set2] = envTools(new SessionEnv({}), { instanceRoot: dir2, spawnFn: () => { throw new Error('must not spawn'); } });
  const r3 = await set2.execute('s4', { key: 'NOPE', value: 'op://v/i/f' });
  assert.equal(r3.isError, true);
  assert.match(r3.content[0].text, /not enabled/);
  // non-managed URI-looking values are plain strings — stored literally
  const r3b = await set.execute('s4b', { key: 'BASE_URL', value: 'hcv://vault/k' });
  assert.equal(r3b.isError, undefined);
  assert.equal(env.view().BASE_URL, 'hcv://vault/k');
  // injection key refuses before any resolution
  const r4 = await set.execute('s5', { key: 'PATH', value: 'op://prod/db/password' });
  assert.equal(r4.isError, true);
  assert.equal(env.view().PATH, undefined);
});

// dedup-h #2346 — doctor surfaces web_search onboarding: unconfigured → warn
// with the env contract as the fix; configured → pass reporting only key
// PRESENCE; non-http(s) → fail. The key value is never echoed.
test('#2346 doctor web_search check: onboarding states, key never echoed', async () => {
  const { doctorTool } = await import('../src/adapter/envtools.js');
  const t = doctorTool({ paths: {}, workdir: mkdtempSync(join(tmpdir(), 'pai-doc-')) });
  const find = (r) => (r.details?.checks ?? []).find((c) => c.id === 'web_search');

  delete process.env.PAI_WEB_SEARCH_URL;
  delete process.env.PAI_WEB_SEARCH_KEY;
  let r = await t.execute();
  assert.equal(find(r).status, 'warn');
  assert.match(find(r).fix, /PAI_WEB_SEARCH_URL/);
  assert.equal(r.details.warn, r.details.checks.filter((c) => c.status === 'warn').length, 'summary recounts the appended check');

  process.env.PAI_WEB_SEARCH_URL = 'https://search.example/api';
  process.env.PAI_WEB_SEARCH_KEY = 'topsecret-value';
  r = await t.execute();
  assert.equal(find(r).status, 'pass');
  assert.match(find(r).detail, /\+api key/);
  assert.ok(!r.content[0].text.includes('topsecret-value'), 'key material never rendered');

  process.env.PAI_WEB_SEARCH_URL = 'ftp://x';
  r = await t.execute();
  assert.equal(find(r).status, 'fail');
  delete process.env.PAI_WEB_SEARCH_URL;
  delete process.env.PAI_WEB_SEARCH_KEY;
});
