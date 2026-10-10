import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DOCTOR_CHECKS } from '../src/core/doctor.js';
import { instancePaths } from '../src/core/instance.js';

/**
 * Two checks, the two ends of the same pipeline:
 *
 *   world_model_cycle    is the loop being run at all?
 *   compiled_artifacts   did its output reach the model?
 *
 * Both exist because a MISSING thing is invisible from the inside: the model
 * cannot tell an empty briefing from a legitimately absent prior state, and
 * nothing held an expectation about either. Liveness of the pipeline is a
 * doctor question, not a learning question.
 */
const CHECK = DOCTOR_CHECKS.find((c) => c.id === 'compiled_artifacts');
const SEP = DOCTOR_CHECKS.find((c) => c.id === 'canonical_separated');
const CYCLE = DOCTOR_CHECKS.find((c) => c.id === 'world_model_cycle');

function instance({ sources = true, artifacts = false, artifactNewer = true, withOverlay = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pai-doc-artifacts-'));
  const p = instancePaths(root);
  mkdirSync(p.canonicalDir, { recursive: true });
  mkdirSync(p.soulDir, { recursive: true });
  // The compiler names come from the soul manifest's declarations — the check
  // follows the declaration instead of hardcoding a path.
  writeFileSync(join(p.soulDir, 'manifest.json'), JSON.stringify({
    briefing: { compiler: 'mind/canonical_compile.py' },
    instruction: { compiler: 'mind/instruction_compile.py' },
  }));
  if (sources) {
    writeFileSync(join(p.canonicalDir, 'current.yaml'), 'x: 1\n');
    writeFileSync(join(p.canonicalDir, 'governance.yaml'), 'policy_version: 1\n');
  }
  if (artifacts) {
    writeFileSync(join(p.canonicalDir, 'briefing.md'), 'b\n');
    mkdirSync(join(p.canonicalDir, 'instruction'), { recursive: true });
    writeFileSync(join(p.canonicalDir, 'instruction', 'generated.md'), 'p\n');
    if (withOverlay) {
      writeFileSync(join(p.canonicalDir, 'reversibility.json'), JSON.stringify({ relaxations: [] }));
    }
    if (!artifactNewer) {
      const past = new Date(Date.now() - 60_000);
      utimesSync(join(p.canonicalDir, 'briefing.md'), past, past);
      utimesSync(join(p.canonicalDir, 'instruction', 'generated.md'), past, past);
      if (withOverlay) utimesSync(join(p.canonicalDir, 'reversibility.json'), past, past);
    }
  }
  return p;
}

test('missing compiled artifacts warn, and the fix names the DECLARED compilers', () => {
  const r = CHECK.run({ paths: instance({ sources: true, artifacts: false }) });
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /briefing\.md/);
  assert.match(r.detail, /instruction\/generated\.md/);
  assert.match(r.fix, /mind\/canonical_compile\.py/);
  assert.match(r.fix, /mind\/instruction_compile\.py/);
});

test('present and current artifacts pass', () => {
  const r = CHECK.run({ paths: instance({ sources: true, artifacts: true, artifactNewer: true }) });
  assert.equal(r.status, 'pass');
});

test('an artifact older than its source is stale, not present', () => {
  const r = CHECK.run({ paths: instance({ sources: true, artifacts: true, artifactNewer: false }) });
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /stale/);
  assert.match(r.fix, /--canonical/);
});

test('no canonical dir is reported rather than thrown', () => {
  const root = mkdtempSync(join(tmpdir(), 'pai-doc-nocanon-'));
  const p = instancePaths(root);
  const r = CHECK.run({ paths: p });
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /no canonical dir/);
});


test('the canonical living inside the instance root is FLAGGED, not silent', () => {
  // Invariant 5 wants canonical / runtime / source tree separated. The default
  // layout violates it, so the default must at least be visible.
  const inside = instance({ sources: true });
  const r1 = SEP.run({ paths: { root: inside.root, canonicalDir: join(inside.root, 'canonical') } });
  assert.equal(r1.status, 'warn');
  assert.match(r1.detail, /inside the instance root/);
  assert.match(r1.fix, /PAI_CANONICAL_DIR/);

  const mounted = SEP.run({ paths: { root: inside.root, canonicalDir: join(tmpdir(), 'wm', 'pilot', 'pa', 'canonical') } });
  assert.equal(mounted.status, 'pass');
});

test('the learned overlay is OPTIONAL — its absence is not a defect', () => {
  // No overlay means the built-in prior stands, which is the safe default.
  const r = CHECK.run({ paths: instance({ sources: true, artifacts: true }) });
  assert.equal(r.status, 'pass');
  assert.match(r.detail, /no learned overlay/);
});

test('a PRESENT overlay is reported, and a STALE one is flagged', () => {
  const fresh = instance({ sources: true, artifacts: true, withOverlay: true });
  const r1 = CHECK.run({ paths: fresh });
  assert.equal(r1.status, 'pass');
  assert.match(r1.detail, /reversibility\.json/);
  assert.match(r1.detail, /learned overlay/);

  // An overlay older than its source must be flagged: the gate would otherwise
  // run on a model the canonical has already moved past.
  const stale = instance({ sources: true, artifacts: true, withOverlay: true, artifactNewer: false });
  const r2 = CHECK.run({ paths: stale });
  assert.equal(r2.status, 'warn');
  assert.match(r2.detail, /stale/);
  assert.match(r2.detail, /reversibility\.json/);
});

// ---- world_model_cycle ----------------------------------------------------

function instanceRoot(schedules) {
  const root = mkdtempSync(join(tmpdir(), 'pai-doc-cycle-'));
  if (schedules) writeFileSync(join(root, 'schedules.json'), JSON.stringify(schedules));
  return instancePaths(root);
}

test('an untriggered cycle warns, and the fix names the RECURRENCE path first', () => {
  const r = CYCLE.run({ paths: instanceRoot(null) });
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /no trigger/);
  // The signal is REPETITION — one failure is noise — and the fix must say so,
  // and must call the sweep what it is: a fallback.
  assert.match(r.fix, /recurrence consumer/);
  assert.match(r.fix, /FALLBACK/);
  assert.match(r.fix, /wm_cycle\.py/);
  assert.match(r.fix, /every_seconds/);
});

test('a schedule file without the cycle still warns', () => {
  const r = CYCLE.run({ paths: instanceRoot([{ command: 'echo hi', every_seconds: 60 }]) });
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /no trigger/);
});

test('a scheduled cycle passes and reports its cadence', () => {
  const r = CYCLE.run({ paths: instanceRoot([
    { command: 'python mind/wm_cycle.py --instance /x', every_seconds: 3600, max_seconds: 86400 },
  ]) });
  assert.equal(r.status, 'pass');
  assert.match(r.detail, /3600/);
  assert.match(r.detail, /86400/);
  // even when scheduled, the check says which one this is
  assert.match(r.detail, /FALLBACK/);
});

test('a disabled cycle entry does not count as scheduled', () => {
  const r = CYCLE.run({ paths: instanceRoot([
    { command: 'python mind/wm_cycle.py --instance /x', every_seconds: 3600, enabled: false },
  ]) });
  assert.equal(r.status, 'warn');
});

test('a corrupt schedule file is reported rather than thrown', () => {
  const root = mkdtempSync(join(tmpdir(), 'pai-doc-cycle-bad-'));
  writeFileSync(join(root, 'schedules.json'), '{not json');
  const r = CYCLE.run({ paths: instancePaths(root) });
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /unreadable/);
});
