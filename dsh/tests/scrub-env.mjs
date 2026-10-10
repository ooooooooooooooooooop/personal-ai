/**
 * DSH's test preload: same deployment-mount isolation as the host and pi suites.
 *
 * Without it the L5/L6 real pi→dsh switch test resolved `canonicalDir` to the
 * machine's REAL pilot canonical (via WORLD_MODEL_HOME) and died on
 * "policy attestation failed: canonical policy missing" — a test failure caused
 * entirely by the operator's deployment mount. It also means a test could have
 * written into that governed canonical instead of its own fixture.
 *
 * The logic lives in one place: host/ owns the contract (dependency direction is
 * body → host, never host → body), so this reuses it rather than copying it.
 */
import '../../host/tests/scrub-env.mjs';
