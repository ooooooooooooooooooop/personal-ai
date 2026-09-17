/**
 * Personal AI desktop shell — Electron main process.
 *
 * The window loads the same zero-build UI the dev server serves; the
 * supervisor + HTTP bridge run in-process here, so the app is one process
 * owning: instance root → body channel child → renderer. No terminal needed.
 */
import { app, BrowserWindow, dialog } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BodySupervisor } from '../server/supervisor.js';
import { createHttpBridge } from '../server/http-bridge.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

let bridge = null;
let supervisor = null;

async function boot() {
  const instanceRoot = process.env.PAI_INSTANCE
    ?? join(app.getPath('userData'), 'instance');
  const workdir = process.env.PAI_WORKDIR ?? app.getPath('documents');

  supervisor = new BodySupervisor({ instanceRoot, workdir, repoRoot: REPO_ROOT });
  await supervisor.start();
  bridge = createHttpBridge({ supervisor });
  const port = await bridge.listen(0);

  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    title: 'Personal AI',
    backgroundColor: '#0f1115',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.removeMenu();
  await win.loadURL(`http://127.0.0.1:${port}/`);
}

app.whenReady().then(boot).catch(async (e) => {
  const msg = e?.stack ?? e?.message ?? String(e);
  try { await dialog.showErrorBox('Personal AI failed to start', msg); } catch { /* pre-ready */ }
  await supervisor?.dispose().catch(() => {});
  bridge?.close();
  app.exit(1);
});

app.on('window-all-closed', async () => {
  await supervisor?.dispose();
  bridge?.close();
  app.quit();
});
