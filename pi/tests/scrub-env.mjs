/**
 * Pi's test preload: same deployment-mount isolation as the host suite.
 *
 * The body boots hosts. Without this, a machine configured the documented way
 * (`WORLD_MODEL_HOME` pointing at the real pilot canonical) would have every test
 * session resolve to that REAL canonical and, wherever the host compiles or writes
 * at startup, write into governed canonical state.
 *
 * The logic lives in one place: host/ owns the contract, and pi depends on host —
 * never the reverse. Duplicating it here would be the very drift the manifest
 * discipline exists to prevent.
 */
import '../../host/tests/scrub-env.mjs';
