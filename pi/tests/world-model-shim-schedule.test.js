/**
 * The recurrence trigger's scheduled cycle must name the RESOLVED canonical.
 *
 * wm_cycle defaults its canonical to <instance>/canonical. On a mounted
 * instance (PAI_CANONICAL_DIR / WORLD_MODEL_HOME) that directory is a
 * DIFFERENT, stale fallback — a cycle aimed there compiles a briefing nobody
 * reads and drops proposals into the wrong place, silently. So the shim passes
 * --canonical explicitly, quoted (the command runs through a shell and a
 * mounted path may contain spaces).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldModelShim } from '../src/adapter/world-model-shim.js';

test('the scheduled cycle is aimed at the resolved canonical, quoted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-wm-shim-sched-'));
  const canonicalDir = join(dir, 'mounted canonical'); // the space is the point
  mkdirSync(canonicalDir, { recursive: true });
  // threshold 1: a single declared refutation fires the request immediately
  writeFileSync(join(canonicalDir, 'learning-trigger.json'),
    JSON.stringify({ refutation_threshold: 1, declared_by: 'test' }));
  const added = [];
  const wm = createWorldModelShim({
    stateDir: join(dir, 'state'),
    canonicalDir,
    mode: 'off',
    bodyId: 'test',
    getSessionId: () => 's1',
    scheduleStore: { add: (e) => added.push(e) },
    instanceRoot: join(dir, 'instance'),
  });
  const tool = wm.tool;
  assert.ok(tool, 'world_model tool must be registered');
  const predicted = JSON.parse(
    (await tool.execute('c1', { op: 'predict', subject: 'x', intended_action: 'edit x' }))
      .content[0].text);
  await tool.execute('c2', { op: 'evaluate', prediction_id: predicted.prediction_id, verdict: 'refuted' });

  assert.equal(added.length, 1, 'one declared refutation fires one cycle request');
  assert.ok(added[0].command.includes('wm_cycle.py'));
  assert.ok(added[0].command.includes(`--canonical "${canonicalDir}"`),
    `command must name the resolved canonical, quoted: ${added[0].command}`);
  assert.ok(added[0].command.includes(`--instance "${join(dir, 'instance')}"`),
    `instance root must be quoted too: ${added[0].command}`);
});
