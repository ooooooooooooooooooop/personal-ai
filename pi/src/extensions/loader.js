import { verifyExtensionIntegrity } from '../../../host/src/core/manifest.js';
import { resolve } from 'node:path';

/**
 * Managed extension loader — TCB admission enforcement.
 *
 * Every extension file listed in managed-manifest.json is sha256-verified
 * BEFORE it can reach the resource loader. Hash mismatch = throw (fail-closed):
 * a tampered or drifted extension must never enter the TCB silently.
 *
 * Returns ordered absolute paths for DefaultResourceLoader's
 * `additionalExtensionPaths`. Combined with `noExtensions: true` this gives
 * zero-discovery admission: nothing loads except what the manifest pins.
 */
export function resolveManagedExtensions(manifest, { baseDir }) {
  const out = [];
  for (const entry of manifest.extensions) {
    const abs = resolve(baseDir, entry.path);
    verifyExtensionIntegrity(entry, abs); // throws on mismatch
    out.push({ id: entry.id, path: abs });
  }
  return out;
}
