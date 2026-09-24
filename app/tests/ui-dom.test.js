/**
 * UI DOM gate (review P0c): the six experience surfaces are verified against
 * the REAL rendered DOM — an offscreen Electron window over the real
 * http-bridge + BodySupervisor + fixture body channel. No mocks of app.js:
 * the assertions read what a user would actually see.
 *
 *   1. statusline          — model · mode · workdir bottom row
 *   2. todo panel          — todos_list checklist renders
 *   3. @-attachment        — @file mention reads the workdir file
 *   4. approval card       — real args payload visible before approving
 *   5. tool cards          — bash output + edit diff rendered
 *   6. job detail drawer   — real command + output tail
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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
const FIXTURE = join(REPO, 'app', 'tests', 'fixtures', 'fake-channel.js');
const GATE = join(REPO, 'app', 'tests', 'fixtures', 'dom-gate.js');
const electron = createRequire(import.meta.url)('electron'); // resolves to the binary path

test('ui-dom: six experience surfaces render real data in the actual DOM', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-dom-'));
  writeFileSync(join(dir, 'note.txt'), 'domgate-note-content');
  // dedup-h #3094 — a recipe carrying argument-hint frontmatter for the
  // dom-gate /recipe picker check.
  mkdirSync(join(dir, '.pai', 'recipes'), { recursive: true });
  writeFileSync(join(dir, '.pai', 'recipes', 'hinted.md'),
    '---\ndescription: hinted recipe\nargument-hint: [topic] [depth]\nparams: topic(required), depth=3\n---\nresearch {{topic}} at depth {{depth}}\n');

  const catalog = {
    'fake-dom': {
      id: 'fake-dom', label: 'fake-dom',
      facts: () => ({
        body_id: 'fake-dom', adapter_version: '0.0.1',
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
        env: { FAKE_BODY: 'fake-dom', FAKE_SCENARIO: 'domgate' },
      }),
    },
  };

  const sup = await new BodySupervisor({
    instanceRoot: dir, workdir: dir, repoRoot: REPO, catalog, env: { ...process.env },
  }).start();
  const bridge = createHttpBridge({ supervisor: sup });
  const port = await bridge.listen(0);

  // This machine sets ELECTRON_RUN_AS_NODE=1 globally — strip it or the
  // "Electron" child is just plain node and 'electron' resolves to the npm
  // path-stub instead of the real runtime.
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
    const line = buf.split('\n').find((l) => l.startsWith('DOMGATE '));
    assert.ok(line, `electron produced no DOMGATE line (exit ${code})\nstderr: ${errBuf.slice(-2000)}`);
    const gate = JSON.parse(line.slice(8));
    if (process.env.DOM_GATE_DUMP === '1') console.error(`GATEDUMP ${JSON.stringify(gate.checks, null, 1)}`);
    assert.equal(gate.ok, true, `DOM checks failed: ${JSON.stringify(gate, null, 1)}`);
    for (const [name, c] of Object.entries(gate.checks)) {
      assert.equal(c.ok, true, `check '${name}' failed: ${JSON.stringify(c)}`);
    }
  } finally {
    child.kill();
    await bridge.close();
    await sup.dispose();
  }
});
