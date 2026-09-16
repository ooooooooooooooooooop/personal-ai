import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Canonical/soul loaders — consume the SAME canonical soul and state that any
 * other harness would read. Output is plain data; adapters decide how to
 * inject it into engine-specific context surfaces.
 *
 * soul/ is contract-driven: when manifest.json exists we expose its declared
 * shape (soul_version/schema_version/briefing/models/release) — the release
 * anchor — not just a raw file dump.
 */

/** Read a directory tree of UTF-8 text files into {relativePath: content}. */
function readTree(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) {
      for (const [k, v] of Object.entries(readTree(p))) out[`${name.name}/${k}`] = v;
    } else if (name.isFile()) {
      out[name.name] = readFileSync(p, 'utf-8');
    }
  }
  return out;
}

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null;
}

/** @param {import('./contracts.js').InstancePaths} paths */
export function loadSoul(paths) {
  const manifest = readJson(join(paths.soulDir, 'manifest.json'));
  const files = readTree(paths.soulDir);
  return {
    root: paths.soulDir,
    manifest,          // soul-0.1.2 contract: soul_version/schema_version/briefing/models/release
    briefing: files['briefing/briefing.md'] ?? files['briefing/template.md'] ?? null,
    files,
  };
}

/** @param {import('./contracts.js').InstancePaths} paths */
export function loadCanonicalState(paths) {
  return {
    root: paths.canonicalDir,
    manifest: readJson(join(paths.canonicalDir, 'manifest.json')),
    files: readTree(paths.canonicalDir),
  };
}
