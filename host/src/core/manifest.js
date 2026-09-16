import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Managed extension manifest — the ONLY admission source into the Host TCB.
 * Pi project-local extensions/resources discovered at runtime do not enter the
 * TCB on their own; the manifest decides what is allowed to load.
 */

/** @returns {import('./contracts.js').ManagedManifest} */
export function loadManagedManifest(manifestPath) {
  const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  if (raw.version !== 1 || !Array.isArray(raw.extensions)) {
    throw new Error(`bad managed manifest shape: ${manifestPath}`);
  }
  for (const [i, e] of raw.extensions.entries()) {
    if (!e.id || !e.path || !e.sha256) {
      throw new Error(`managed manifest entry ${i} missing id/path/sha256`);
    }
  }
  return raw;
}

/** Verify an extension's bytes against its manifest pin before allowing load. */
export function verifyExtensionIntegrity(entry, extensionFilePath) {
  const digest = createHash('sha256')
    .update(readFileSync(extensionFilePath))
    .digest('hex');
  if (digest !== entry.sha256) {
    throw new Error(
      `extension integrity mismatch for ${entry.id}: ` +
        `manifest=${entry.sha256} actual=${digest}`
    );
  }
}
