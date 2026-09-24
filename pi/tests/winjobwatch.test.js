/**
 * dedup-h #1291 — win-containment: the detached watchdog gives job trees
 * Job-Object-style kill-on-close without a native addon. Standalone drills:
 * host-death → tree killed immediately (not at next boot); child-exit →
 * watchdog retires. Plus a JobExecutor integration check that a real job
 * spawn is accompanied by a live watchdog process.
 */
import { mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JobStore } from '../../host/src/core/jobs.js';
import { JobExecutor } from '../src/adapter/jobs.js';

const here = dirname(fileURLToPath(import.meta.url));
const WATCH = join(here, '..', 'src', 'adapter', 'winjobwatch.js');
const isWin = process.platform === 'win32';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };
const sleepProc = () => spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
const waitFor = async (fn, ms = 6000, step = 100) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, step)); }
  return false;
};

test('#1291 watchdog kills the job tree the moment the host pid dies', { skip: !isWin }, async () => {
  const fakeHost = sleepProc();   // stands in for the host process
  const fakeJob = sleepProc();    // stands in for the job worker
  const watch = spawn(process.execPath, [WATCH, String(fakeHost.pid), String(fakeJob.pid), ''], { stdio: 'ignore', windowsHide: true });
  try {
    assert.ok(alive(fakeHost.pid) && alive(fakeJob.pid) && watch.pid);
    process.kill(fakeHost.pid); // host "crash"
    const treeDead = await waitFor(() => !alive(fakeJob.pid));
    assert.ok(treeDead, 'job tree must be killed within seconds of host death, not at next boot');
    const watchGone = await waitFor(() => !alive(watch.pid));
    assert.ok(watchGone, 'watchdog retires after discharging its kill');
  } finally {
    try { process.kill(fakeHost.pid); } catch { /* gone */ }
    try { process.kill(fakeJob.pid); } catch { /* gone */ }
    try { process.kill(watch.pid); } catch { /* gone */ }
  }
});

test('#1291 watchdog retires when the child exits while the host lives', { skip: !isWin }, async () => {
  const shortJob = spawn(process.execPath, ['-e', 'setTimeout(()=>{},150)'], { stdio: 'ignore' });
  const watch = spawn(process.execPath, [WATCH, String(process.pid), String(shortJob.pid), ''], { stdio: 'ignore', windowsHide: true });
  const watchGone = await waitFor(() => !alive(watch.pid), 6000);
  try { process.kill(watch.pid); } catch { /* gone */ }
  assert.ok(watchGone, 'watchdog must not linger after the job ended');
});

test('#1291 a live JobExecutor spawn carries a watchdog while running', { skip: !isWin, timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-watch-'));
  const store = new JobStore(join(dir, 'durable_jobs.db'));
  const executor = new JobExecutor(store, join(dir, 'jobs'));
  const watchdogCount = () => {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -match 'winjobwatch' -and $_.CommandLine -match ' ${process.pid} ' } | Measure-Object | Select-Object -ExpandProperty Count`],
      { encoding: 'utf-8', timeout: 15_000 });
    return Number(String(r.stdout).trim()) || 0;
  };
  const { job_id } = await executor.spawnCommandJob({ command: 'node -e "setTimeout(()=>{},30000)"', workdir: tmpdir() });
  try {
    const found = await waitFor(() => watchdogCount() > 0, 10_000, 400);
    assert.ok(found, 'running job must be accompanied by a winjobwatch process carrying the host pid');
    executor.cancel(job_id);
    const gone = await waitFor(() => watchdogCount() === 0, 10_000, 400);
    assert.ok(gone, 'watchdog must be gone once the job is terminal');
  } finally {
    try { executor.cancel(job_id); } catch { /* already terminal */ }
    store.close();
  }
});
