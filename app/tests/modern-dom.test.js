/**
 * Modern DOM gate test: verifies that the built Vite bundle in app/dist/
 * successfully boots over the real supervisor and HTTP bridge, mounts in
 * offscreen Electron, renders the topbar, composer, and can switch across
 * all seven P01-P07 views without crash (satisfying PRD v2.0 B12).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
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
const GATE = join(REPO, 'app', 'tests', 'fixtures', 'modern-gate.js');
const FIXTURE = join(REPO, 'app', 'tests', 'fixtures', 'fake-channel.js');
const electron = createRequire(import.meta.url)('electron');

test('modern-dom: all seven P01-P07 views mount and render in built modern UI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-modern-dom-'));
  writeFileSync(join(dir, 'note.txt'), 'modern-dom-note');

  const catalog = {
    'fake-dom': {
      id: 'fake-dom',
      label: 'fake-dom',
      facts: () => ({
        body_id: 'fake-dom',
        adapter_version: '0.0.1',
        verified_capabilities: {
          final_post_extension_guard: 'supported',
          durable_jobs: 'supported',
          provider_request_audit: 'supported',
        },
        governance_coverage: { audit: 'supported' },
        handoff_capabilities: { quiesce: 'supported', verify: 'supported' },
      }),
      installed: () => true,
      channel: () => ({
        command: process.execPath,
        args: [FIXTURE, '--instance', dir],
        env: { FAKE_BODY: 'fake-dom' },
      }),
    },
  };

  const sup = await new BodySupervisor({
    instanceRoot: dir,
    workdir: dir,
    repoRoot: REPO,
    catalog,
    env: { ...process.env },
    backupCtl: { probe: async () => ({ ok: true, overdue: false }), run: async () => 0 },
    govCtl: { probe: async () => ({ ok: true, overdue: false, lanes: {} }), run: async () => 0 },
    cogCtl: { run: async () => 0 },
  }).start();

  const bridge = createHttpBridge({ supervisor: sup, uiDir: DIST_UI });
  const port = await bridge.listen(0);

  const childEnv = { ...process.env, DOM_GATE_URL: `http://127.0.0.1:${port}` };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const child = spawn(electron, [GATE, '--no-sandbox', '--disable-gpu'], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buf = '';
  let errBuf = '';
  child.stdout.on('data', (d) => { buf += d; });
  child.stderr.on('data', (d) => { errBuf += d; });

  try {
    const code = await new Promise((res) => child.on('exit', res));
    const line = buf.split('\n').find((l) => l.startsWith('MODERNGATE '));
    assert.ok(line, `electron produced no MODERNGATE line (exit ${code})\nstderr: ${errBuf.slice(-2000)}`);
    const gate = JSON.parse(line.slice(11));
    assert.equal(gate.ok, true, `Modern DOM checks failed: ${JSON.stringify(gate, null, 1)}`);
    assert.equal(gate.a11y?.count ?? 0, 0, `Axe accessibility violations found: ${JSON.stringify(gate.a11y?.violations)}`);
    for (const [name, c] of Object.entries(gate.checks)) {
      assert.equal(c.ok, true, `Modern DOM check '${name}' failed: ${JSON.stringify(c)}`);
    }
  } finally {
    child.kill();
    await bridge.close();
    await sup.dispose();
  }
});
