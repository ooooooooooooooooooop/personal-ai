// #1291 — win-containment watchdog: a detached helper that gives spawned job
// trees Job-Object-style kill-on-close semantics WITHOUT an N-API addon
// (host must stay zero-dependency). Windows does not kill children when a
// parent exits — this process survives the host, polls it, and taskkills
// the job's whole tree the moment the host pid is gone, closing the orphan
// window that today only heals at the next host restart.
//
// usage: node winjobwatch.js <hostPid> <childPid> [containerName]
// exits when: the child is gone (normal end — nothing to do) or after it
// has killed the tree (host gone). Poll interval is cheap — 500ms.
import { spawnSync } from 'node:child_process';

const hostPid = Number(process.argv[2]);
const childPid = Number(process.argv[3]);
const container = process.argv[4] || null;
if (!Number.isInteger(hostPid) || hostPid <= 0 || !Number.isInteger(childPid) || childPid <= 0) process.exit(2);

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

const timer = setInterval(() => {
  try {
    if (!alive(childPid)) process.exit(0); // job ended — watchdog retires
    if (alive(hostPid)) return;          // host alive — keep watching
    // Host is gone. Kill-on-close: named container first (taskkill cannot
    // reach inside it), then the local tree.
    try { if (container) spawnSync('docker', ['rm', '-f', container], { windowsHide: true, timeout: 10_000 }); } catch { /* best-effort */ }
    try { spawnSync('taskkill', ['/pid', String(childPid), '/T', '/F'], { windowsHide: true }); } catch { /* best-effort */ }
    process.exit(0);
  } catch { /* keep watching — a transient kill() probe failure is not a death signal */ }
}, 500);
