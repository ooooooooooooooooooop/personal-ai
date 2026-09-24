import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVerifier } from '../src/adapter/verify.js';
import { parseShellCommand } from '../src/adapter/command-parse.js';

const fixture = (riskActions = {}) => {
  const workdir = mkdtempSync(join(tmpdir(), 'pai-verify-'));
  const audits = [];
  const emitted = [];
  const obs = [];
  const verify = createVerifier({
    workdir,
    classify: parseShellCommand,
    riskActions,
    audit: { write: (e) => audits.push(e) },
    emit: (e) => emitted.push(e),
    observations: { record: (o) => obs.push(o) },
  });
  const arm = (doc) => {
    mkdirSync(join(workdir, '.pai'), { recursive: true });
    writeFileSync(join(workdir, '.pai', 'verify.json'), JSON.stringify(doc));
  };
  return { workdir, audits, emitted, obs, verify, arm };
};

test('armed benign verifier runs and audits; success records no observation', async () => {
  const { audits, emitted, obs, verify, arm } = fixture();
  arm({ onWrite: process.platform === 'win32' ? 'echo ok' : 'echo ok' });
  await verify.afterWrite();
  assert.equal(emitted[0].type, 'verify_result');
  assert.equal(emitted[0].ok, true);
  assert.equal(audits.at(-1).kind, 'VERIFY_RUN');
  assert.equal(obs.length, 0);
});

test('failing verifier reflects into the observation stream', async () => {
  const { obs, emitted, verify, arm } = fixture();
  arm({ onWrite: process.platform === 'win32' ? 'exit 3' : 'exit 3' });
  await verify.afterWrite();
  assert.equal(emitted[0].ok, false);
  assert.equal(obs.length, 1);
  assert.equal(obs[0].kind, 'verify_fail');
  assert.equal(obs[0].detail.exit, 3);
});

test('denied-class verifier config is refused at arm — never executes', async () => {
  const { audits, emitted, obs, verify, arm } = fixture({ network: 'deny' });
  arm({ onWrite: 'curl https://evil.example/x' });
  await verify.afterWrite();
  assert.equal(emitted.length, 0); // nothing ran
  assert.equal(obs.length, 0);
  assert.equal(audits.at(-1).kind, 'VERIFY_REFUSED');
});

test('unparseable config command fails closed', async () => {
  const { audits, verify, arm } = fixture();
  arm({ onWrite: 'cmd "unclosed' });
  await verify.afterWrite();
  assert.equal(audits.at(-1).kind, 'VERIFY_REFUSED');
});

test('absent/empty config is a silent no-op', async () => {
  const { audits, emitted, verify } = fixture();
  await verify.afterWrite(); // no verify.json at all
  assert.equal(audits.length, 0);
  assert.equal(emitted.length, 0);
});

test('runNow: operator trigger bypasses burst throttle, keeps arm-check', async () => {
  const { audits, emitted, verify, arm } = fixture();
  arm({ onWrite: 'echo ok' });
  await verify.afterWrite();
  // immediate second write is burst-throttled...
  const before = emitted.length;
  await verify.afterWrite();
  assert.equal(emitted.length, before);
  // ...but a manual /verify always runs and reports
  const r = await verify.runNow();
  assert.equal(r.ran, true);
  assert.equal(r.ok, true);
  assert.equal(emitted.length, before + 1);
  assert.equal(audits.at(-1).data.origin, 'manual');
});

test('runNow: unconfigured reports cleanly; gated command still refused', async () => {
  const { verify, arm } = fixture();
  const r0 = await verify.runNow();
  assert.equal(r0.ran, false);
  assert.match(r0.reason, /no \.pai\/verify\.json/);
  const v2 = fixture({ network: 'deny' });
  v2.arm({ onWrite: 'curl https://evil.example/x' });
  const r1 = await v2.verify.runNow();
  assert.equal(r1.refused, true);
});

test('timeout tree-kills the verifier — the grandchild process does not outlive it', { timeout: 20_000 }, async () => {
  const { workdir, verify, arm, emitted } = fixture();
  // the verifier's child records its OWN pid (the grandchild of our process,
  // behind the shell wrapper) then hangs — a wrapper-only kill orphans it
  arm({ onWrite: `node -e "require('fs').writeFileSync('verify-grandchild.pid',String(process.pid));setTimeout(()=>{},30000)"`, timeoutMs: 800 });
  const r = await verify.runNow();
  assert.equal(r.ok, false);
  assert.equal(emitted.at(-1).ok, false);
  const { readFileSync, existsSync } = await import('node:fs');
  const pidFile = join(workdir, 'verify-grandchild.pid');
  assert.ok(existsSync(pidFile), 'grandchild started and recorded its pid');
  const pid = Number(readFileSync(pidFile, 'utf-8'));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, `grandchild pid ${pid} must be tree-killed, not orphaned`);
});

// dedup-h #2132 — built-in post-write delta lint: JSON always checked;
// py/toml/yaml via probed python (skipped honestly when absent).
test('#2132 delta lint: bad JSON reflects into observations; good JSON silent', async () => {
  const { workdir, audits, emitted, obs, verify } = fixture();
  writeFileSync(join(workdir, 'bad.json'), '{broken');
  writeFileSync(join(workdir, 'good.json'), '{"a":1}');
  writeFileSync(join(workdir, 'note.txt'), 'not a lintable ext');

  const results = await verify.lintPaths(['bad.json', 'good.json', 'note.txt']);
  assert.equal(results.length, 3);
  assert.equal(results[0].checked, true);
  assert.equal(results[0].ok, false, 'broken json must fail');
  assert.equal(results[1].checked, true);
  assert.equal(results[1].ok, true);
  assert.equal(results[2].checked, false, 'non-lintable extension skipped');

  const fail = obs.find((o) => o.kind === 'delta_lint_fail');
  assert.ok(fail, 'lint failure must reflect into the observation stream');
  assert.match(fail.subject, /bad\.json/);
  assert.equal(emitted.some((e) => e.type === 'verify_result' && e.ok === false), true);
  assert.ok(audits.some((a) => a.kind === 'DELTA_LINT' && a.data.ok === false));
  assert.ok(audits.some((a) => a.kind === 'DELTA_LINT' && a.data.ok === true), 'pass is audited too');
});

test('#2132 delta lint: missing file reports as a fail, not a throw', async () => {
  const { obs, verify } = fixture();
  const results = await verify.lintPaths(['ghost.json']);
  assert.equal(results[0].checked, true);
  assert.equal(results[0].ok, false);
  assert.ok(obs.some((o) => o.kind === 'delta_lint_fail'));
});

test('#2132 delta lint: python path checked only when a probe succeeds', async () => {
  const { workdir, verify } = fixture();
  writeFileSync(join(workdir, 'ok.py'), 'x = 1\n');
  const results = await verify.lintPaths(['ok.py']);
  assert.equal(results.length, 1);
  // Either python exists (checked, passes) or does not (honest skip) —
  // never a fake pass or a thrown probe.
  if (results[0].checked) assert.equal(results[0].ok, true);
  else assert.match(results[0].detail, /no python interpreter|no py module/);
});
