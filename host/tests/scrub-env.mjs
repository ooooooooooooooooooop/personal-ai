/**
 * Test preload: do not inherit the operator's deployment mount.
 *
 * `resolveCanonicalDir` reads `process.env`, which is correct for the product but
 * wrong for a unit test: on a machine that has `WORLD_MODEL_HOME` set to the real
 * pilot canonical (the documented way to configure it), every test that boots a
 * host would resolve `canonicalDir` to that REAL canonical — and anything the host
 * compiles or writes at startup would land in the governed canonical state.
 *
 * This used to fail loudly instead (the resolver threw when it read a repo root,
 * so the host suite went 67-red). Failing loudly is no longer the failure mode —
 * which makes the silent one possible — so the isolation has to be explicit.
 *
 * Loaded via `node --import ./tests/scrub-env.mjs`. Tests that need a mount set it
 * themselves, per case, through `resolveCanonicalDir(root, { env })`.
 *
 * Reports to stderr only, so the TAP stream on stdout stays parseable.
 */

const DEPLOYMENT_VARS = [
  'WORLD_MODEL_HOME',
  'WORLD_MODEL_REPO',
  'PAI_PILOT',
  'PAI_CANONICAL_DIR',
];

const scrubbed = [];
for (const name of DEPLOYMENT_VARS) {
  if (process.env[name] !== undefined) {
    scrubbed.push(name);
    delete process.env[name];
  }
}

// Opt-in only: this runs once per test FILE (each file is its own process), so an
// always-on notice would print ~20 escaped TAP comment lines per suite run.
if (scrubbed.length && process.env.PAI_TEST_ENV_NOTICE === '1') {
  process.stderr.write(
    `# scrub-env: removed deployment mount vars so tests cannot resolve to a real canonical: ${scrubbed.join(', ')}\n`,
  );
}
