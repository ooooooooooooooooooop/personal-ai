/**
 * Where the canonical lives.
 *
 * Invariant 5 says canonical state / instance runtime / source tree are physically
 * separated — and the default layout put the canonical INSIDE the runtime, which
 * contradicts it. The world-model repo states the same boundary from its side
 * ("canonical 禁止出现在实例根内"; it is the canonical's sole owner and the product
 * must not assume a path into it). The mount was not expressible at all: the path
 * was hardcoded with no override anywhere in the repo.
 *
 * These pin the precedence and, more importantly, the refusal to guess.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCanonicalDir } from '../src/core/instance.js';

const ROOT = process.platform === 'win32' ? 'C:\\inst' : '/inst';

test('nothing set ⇒ the old behaviour, unchanged', () => {
  // Kept deliberately: existing instances must not break. The doctor's
  // canonical_separated check is what makes this a visible choice.
  assert.equal(resolveCanonicalDir(ROOT, { env: {} }), `${ROOT}${sep()}canonical`);
});

test('PAI_CANONICAL_DIR names the directory itself', () => {
  const away = process.platform === 'win32' ? 'D:////wm////canonical' : '/wm/canonical'; // boundary-scan-allow: deliberate foreign-drive fixture proving canonical can resolve outside the instance root
  const d = resolveCanonicalDir(ROOT, { env: { PAI_CANONICAL_DIR: away } });
  assert.ok(d.endsWith(`canonical`), d);
  assert.ok(!d.startsWith(ROOT), 'must be able to resolve OUTSIDE the instance root');
});

test('an explicit option beats the environment', () => {
  const d = resolveCanonicalDir(ROOT, {
    canonicalDir: `${ROOT}${sep()}from-option`,
    env: { PAI_CANONICAL_DIR: `${ROOT}${sep()}from-env` },
  });
  assert.ok(d.endsWith('from-option'), d);
});

test('WORLD_MODEL_HOME names the canonical directory ITSELF, not a repo root', () => {
  // This is the meaning documented on the other side of the boundary (research
  // repo README, skills/world-model-runtime, dsh/world-model) and the meaning
  // machines had already been configured with. Reading it as a repo root made
  // every such machine fail to boot, so it is pinned here.
  const home = process.platform === 'win32' ? 'C:\\wm\\pilot\\personal-ai\\canonical' : '/wm/pilot/personal-ai/canonical';
  const d = resolveCanonicalDir(ROOT, { env: { WORLD_MODEL_HOME: home } });
  assert.ok(d.endsWith('canonical'), d);
  assert.ok(!d.includes(['pilot', 'personal-ai', 'canonical'].join(sep()) + sep() + ['pilot', 'personal-ai', 'canonical'].join(sep())), d);
  assert.ok(!d.startsWith(ROOT), 'must resolve OUTSIDE the instance root');
  // No PAI_PILOT is required, and none may change the answer.
  assert.equal(resolveCanonicalDir(ROOT, { env: { WORLD_MODEL_HOME: home, PAI_PILOT: 'ignored' } }), d);
});

test('PAI_CANONICAL_DIR outranks WORLD_MODEL_HOME', () => {
  const a = process.platform === 'win32' ? 'C:\\a' : '/a';
  const b = process.platform === 'win32' ? 'C:\\b' : '/b';
  const d = resolveCanonicalDir(ROOT, { env: { PAI_CANONICAL_DIR: a, WORLD_MODEL_HOME: b } });
  assert.ok(d.endsWith('a'), d);
});

test('WORLD_MODEL_REPO + PAI_PILOT resolves the research repo layout', () => {
  const repo = process.platform === 'win32' ? 'C:\\wm' : '/wm';
  const d = resolveCanonicalDir(ROOT, { env: { WORLD_MODEL_REPO: repo, PAI_PILOT: 'personal-ai' } });
  assert.ok(d.endsWith(['pilot', 'personal-ai', 'canonical'].join(sep())), d);
});

test('WORLD_MODEL_REPO without PAI_PILOT THROWS — it does not guess a pilot', () => {
  // Guessing which pilot you meant is the kind of silent default this codebase
  // keeps having to remove. Fail closed and say what is missing.
  assert.throws(
    () => resolveCanonicalDir(ROOT, { env: { WORLD_MODEL_REPO: '/wm' } }),
    /PAI_PILOT/,
  );
});

test('a deployment mount is NOT inherited unless the caller asks for it', () => {
  // Unit tests must resolve against the env they are handed, never the operator's
  // deployment mount — otherwise a test that boots a host would read and write the
  // REAL pilot canonical. `tests/scrub-env.mjs` removes those names at test start;
  // this pins the other half: an empty env means empty.
  const d = resolveCanonicalDir(ROOT, { env: {} });
  assert.equal(d, `${ROOT}${sep()}canonical`);
});

function sep() { return process.platform === 'win32' ? '\\' : '/'; }
