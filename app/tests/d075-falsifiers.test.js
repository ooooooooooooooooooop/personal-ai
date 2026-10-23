/**
 * D07.5 negative regression (falsifiers) — v4 §7.
 *
 * Each test below exists to make ONE guard's deletion fail the gate. The
 * defect is injected into the environment (a body that answers late, refuses a
 * stop, or a probe that answered nothing), the real UI is driven through the
 * real DOM, and the assertion is on what the OPERATOR can see. Delete the guard
 * in app/src and the matching test must go red — that is the whole contract.
 *
 *   1. late-history        V401  a late session_history must not paint over a newer session
 *   2. stop-refused        V404  a refused abort must leave the run running and say so
 *   3. attachment-data     V406  an attachment must reach the body WITH its bytes
 *   4. unknown-health      V407  a probe that answered nothing must read as unknown, not ok
 *   5. theme-light         V409  light theme must repaint tokens AND rendered background
 *   6. suggestion-no-send  V410  picking a suggestion fills the composer, never dispatches
 *
 * Requires app/dist (npm run build:modern) — the gate drives the built bundle.
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BodySupervisor } from '../server/supervisor.js';
import { createHttpBridge } from '../server/http-bridge.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const DIST_UI = join(REPO, 'app', 'dist');
const FIXTURE = join(REPO, 'app', 'tests', 'fixtures', 'fake-channel.js');
const DRIVER = join(REPO, 'app', 'tests', 'fixtures', 'falsifier-driver.js');
const electron = createRequire(import.meta.url)('electron');

const OK_BACKUP = { probe: async () => ({ ok: true, overdue: false }), run: async () => 0 };
const OK_GOV = { probe: async () => ({ ok: true, overdue: false, lanes: {} }), run: async () => 0 };

/**
 * Boot one isolated world: temp instance root, one fixture body, the real
 * bridge, one offscreen Electron running one scenario. Returns the parsed
 * payload plus the scenario's harness paths (temp dir) for node-side facts.
 */
async function runScenario(scenario, { fixtureEnv = {}, backupCtl = OK_BACKUP, govCtl = OK_GOV } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `pai-falsify-${scenario}-`));
  const promptLog = join(dir, 'prompt-log.jsonl');

  const catalog = {
    'fake-falsify': {
      id: 'fake-falsify',
      label: 'fake-falsify',
      facts: () => ({
        body_id: 'fake-falsify',
        adapter_version: '0.0.1',
        verified_capabilities: { final_post_extension_guard: 'supported', durable_jobs: 'supported' },
        governance_coverage: { audit: 'supported' },
        handoff_capabilities: { quiesce: 'supported', verify: 'supported' },
      }),
      installed: () => true,
      channel: () => ({
        command: process.execPath,
        args: [FIXTURE, '--instance', dir],
        env: { FAKE_BODY: 'fake-falsify', FAKE_PROMPT_LOG: promptLog, ...fixtureEnv },
      }),
    },
  };

  const sup = await new BodySupervisor({
    instanceRoot: dir,
    workdir: dir,
    repoRoot: REPO,
    catalog,
    env: { ...process.env },
    backupCtl,
    govCtl,
    cogCtl: { run: async () => 0 },
  }).start();

  const bridge = createHttpBridge({ supervisor: sup, uiDir: DIST_UI });
  const port = await bridge.listen(0);

  const childEnv = { ...process.env, DOM_GATE_URL: `http://127.0.0.1:${port}`, FALSIFY: scenario };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const child = spawn(electron, [DRIVER, '--no-sandbox', '--disable-gpu'], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  let errOut = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { errOut += d; });

  try {
    const code = await new Promise((res) => child.on('exit', res));
    const line = out.split('\n').find((l) => l.startsWith('FALSIFY '));
    assert.ok(
      line,
      `scenario '${scenario}' produced no FALSIFY line (exit ${code})\nstdout: ${out.slice(-1500)}\nstderr: ${errOut.slice(-2500)}`,
    );
    const payload = JSON.parse(line.slice(8));
    return { payload, code, promptLog, dir, stderr: errOut };
  } finally {
    child.kill();
    await bridge.close();
    await sup.dispose();
  }
}

function readPromptLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function detail(payload) {
  return JSON.stringify(payload, null, 1);
}

// ---------------------------------------------------------------- V401
test('D07.5 v401: a late session_history answer does not overwrite the newer session', async () => {
  const { payload } = await runScenario('lateHistory', {
    fixtureEnv: {
      FAKE_MULTI_SESSION: '1',
      FAKE_HISTORY_MARK: '1',
      FAKE_HISTORY_SLOW_FOR: 's2.jsonl',
      FAKE_HISTORY_DELAY_MS: '1800',
    },
  });
  const c = payload.checks?.lateHistory;
  assert.ok(c, `no lateHistory check in payload: ${detail(payload)}`);
  assert.equal(c.keptNewer, true, `the newer session's history was not on screen — switch never landed: ${detail(c)}`);
  assert.equal(
    c.lateOverwrote, false,
    `a late session_history answer for s2 painted over s1 — the staleness guard on the switch path is gone: ${detail(c)}`,
  );
  assert.equal(payload.ok, true, detail(payload));
});

// ---------------------------------------------------------------- V404
test('D07.5 v404: a refused stop keeps the run alive and reports the refusal', async () => {
  const { payload } = await runScenario('stopRefused', {
    fixtureEnv: { FAKE_ABORT_FAIL: '1', FAKE_PROMPT_DELAY_MS: '9000' },
  });
  const c = payload.checks?.stopRefused;
  assert.ok(c, `no stopRefused check in payload: ${detail(payload)}`);
  assert.equal(c.sawStopButton, true, `the turn never entered a running state, so stop was never offered: ${detail(c)}`);
  assert.equal(
    c.stillRunning, true,
    `the UI left the running state after the body REFUSED the abort — it faked a stop it did not get: ${detail(c)}`,
  );
  assert.equal(c.saidFailure, true, `the refusal was never surfaced to the operator: ${detail(c)}`);
  assert.equal(payload.ok, true, detail(payload));
});

// ---------------------------------------------------------------- V406
test('D07.5 v406: an attachment reaches the body with its bytes, not just its name', async () => {
  const { payload, promptLog } = await runScenario('attachmentData', {
    fixtureEnv: { FAKE_REQUIRE_ATTACH_DATA: '1' },
  });
  const c = payload.checks?.attachmentData;
  assert.ok(c, `no attachmentData check in payload: ${detail(payload)}`);
  assert.equal(c.chipped, true, `the dropped file never produced an attachment chip: ${detail(c)}`);
  assert.equal(
    c.refusedLocally, false,
    `the composer refused its own attachment as sourceless — the file was never read into bytes: ${detail(c)}`,
  );
  assert.equal(c.echoed, true, `the body never confirmed the prompt, so it was refused upstream: ${detail(c)}`);

  // Ground truth at the last hop: the body saw real base64, not an empty shell.
  const rows = readPromptLog(promptLog);
  const sent = rows.find((r) => String(r.message).includes('看这个附件 falsifier'));
  assert.ok(sent, `the prompt never reached the body; log=${JSON.stringify(rows).slice(0, 400)}`);
  const att = sent.options?.attachments?.[0];
  assert.ok(att, `the prompt carried no attachments: ${JSON.stringify(sent).slice(0, 400)}`);
  assert.equal(typeof att.data, 'string', `attachment '${att.name}' has no data field`);
  assert.equal(
    Buffer.from(att.data, 'base64').toString('utf-8'), 'hi\n',
    `attachment bytes were altered in flight: ${att.data}`,
  );
  assert.equal(att.mime, 'text/plain');
  assert.equal(payload.ok, true, detail(payload));
});

// ---------------------------------------------------------------- V407
test('D07.5 v407: a probe that answered nothing reads as unknown, never as ok', async () => {
  // The body answered, but said nothing conclusive: `ok` is undefined. This is
  // exactly the shape that used to render as "备份正常 / 自检正常".
  const { payload } = await runScenario('unknownHealth', {
    backupCtl: { probe: async () => ({}), run: async () => 0 },
    govCtl: { probe: async () => ({}), run: async () => 0 },
  });
  const c = payload.checks?.unknownHealth;
  assert.ok(c, `no unknownHealth check in payload: ${detail(payload)}`);
  assert.match(c.backup, /尚未检查/, `an unanswered backup probe was reported as something other than unknown: "${c.backup}"`);
  assert.match(c.checksRow, /尚未检查/, `an unanswered governance probe was reported as something other than unknown: "${c.checksRow}"`);
  assert.ok(!c.backup.includes('备份正常'), `an unanswered probe was reported as 备份正常: "${c.backup}"`);
  assert.ok(!c.checksRow.includes('自检正常'), `an unanswered probe was reported as 自检正常: "${c.checksRow}"`);
  assert.equal(payload.ok, true, detail(payload));
});

// ---------------------------------------------------------------- V409
test('D07.5 v409: switching to light repaints the tokens and the rendered background', async () => {
  const { payload } = await runScenario('themeLight');
  const c = payload.checks?.themeLight;
  assert.ok(c, `no themeLight check in payload: ${detail(payload)}`);
  assert.equal(c.lightBtn, true, `the appearance view offered no light-theme control: ${detail(c)}`);
  assert.notEqual(c.lightToken, c.darkToken, `--bg did not change with data-theme=light: dark=${c.darkToken} light=${c.lightToken}`);
  assert.notEqual(c.darkPaint, c.lightPaint, `the rendered background did not change: dark=${c.darkPaint} light=${c.lightPaint}`);
  assert.ok(c.lumLight > 0.75, `light theme painted a background luminance of ${c.lumLight} (${c.lightPaint}) — still dark`);
  assert.ok(c.lumDark < 0.25, `dark theme painted a light background (${c.darkPaint})`);
  assert.equal(payload.ok, true, detail(payload));
});

// ---------------------------------------------------------------- V410
test('D07.5 v410: picking a suggestion fills the composer and dispatches nothing', async () => {
  const { payload, promptLog } = await runScenario('suggestionNoAutosend');
  const c = payload.checks?.suggestionNoAutosend;
  assert.ok(c, `no suggestionNoAutosend check in payload: ${detail(payload)}`);
  assert.equal(c.filled, true, `the suggestion never reached the composer: ${detail(c)}`);
  assert.equal(
    c.stillEmpty, true,
    `the empty state was replaced after a suggestion click — a turn was started: ${detail(c)}`,
  );
  assert.deepEqual(
    readPromptLog(promptLog), [],
    'a prompt was dispatched by the suggestion click — suggestions must only fill the composer',
  );
  assert.equal(payload.ok, true, detail(payload));
});
