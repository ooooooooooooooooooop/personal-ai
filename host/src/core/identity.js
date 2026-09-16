import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Runtime identity — every audit event and handoff envelope cites this.
 * Records WHICH code is running: host version, adapter id/version, both
 * lockfile hashes (lockfile is part of runtime identity, R6.5), session/run.
 */
export function sha256File(path) {
  return existsSync(path)
    ? createHash('sha256').update(readFileSync(path)).digest('hex')
    : null;
}

export function writeRuntimeIdentity(paths, {
  hostVersion,
  adapter = {},
  lockfiles = {},
  sessionId,
  runId,
}) {
  const identity = {
    kind: 'RuntimeIdentity',
    version: 1,
    host_version: hostVersion,
    adapter_id: adapter.id ?? null,
    adapter_version: adapter.version ?? null,
    lockfile_sha256: {
      host: lockfiles.host ? sha256File(lockfiles.host) : null,
      pi: lockfiles.pi ? sha256File(lockfiles.pi) : null,
    },
    session_id: sessionId ?? null,
    run_id: runId ?? null,
    started_at: new Date().toISOString(),
  };
  const file = join(paths.root, 'runtime.json');
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(identity, null, 2));
  renameSync(tmp, file);
  return identity;
}
