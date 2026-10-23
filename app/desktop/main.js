/**
 * Personal AI desktop shell — Electron main process.
 *
 * The window loads the same zero-build UI the dev server serves; the
 * supervisor + HTTP bridge run in-process here, so the app is one process
 * owning: instance root → body channel child → renderer. No terminal needed.
 */
import { app, BrowserWindow, dialog, shell, ipcMain } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BodySupervisor } from '../server/supervisor.js';
import { createHttpBridge } from '../server/http-bridge.js';
import { resolveStartupOptions } from './options.js';

// Disable hardware acceleration to eliminate Windows D3D/GPU compositing black screens
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
// Disable background throttling so long-running inference, timers, and SSE streams never drop when window is unfocused
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIST_UI = fileURLToPath(new URL('../dist/', import.meta.url));

let bridge = null;
let supervisor = null;
let mainWindow = null;

async function checkRunningBridge(port = 4173) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data && (data.ok || data.overall)) return `http://127.0.0.1:${port}/`;
    }
  } catch {}
  return null;
}

async function boot() {
  const { uiMode, instanceRoot, workdir } = resolveStartupOptions({
    argv: process.argv,
    env: process.env,
    userDataPath: app.getPath('userData'),
    defaultWorkdir: app.getPath('documents'),
  });

  // If a local Personal AI bridge is already running, attach directly instead
  // of colliding on the single-writer canonical lease.
  let targetUrl = await checkRunningBridge(4173);

  if (!targetUrl) {
    supervisor = new BodySupervisor({ instanceRoot, workdir, repoRoot: REPO_ROOT });
    await supervisor.start();

    let uiDir = undefined;
    if (uiMode === 'modern') {
      if (!existsSync(DIST_UI) || !existsSync(join(DIST_UI, 'index.html'))) {
        const msg = `Modern UI requested (--ui modern) but build artifact not found at ${DIST_UI}.\nPlease run 'npm run build:modern' in the app directory first.`;
        try { await dialog.showErrorBox('Personal AI UI Load Error', msg); } catch {}
        throw new Error(msg);
      }
      process.env.PAI_UI = 'modern';
      uiDir = DIST_UI;
    }

    bridge = createHttpBridge({
      supervisor,
      uiDir,
      pickDir: async () => {
        const r = await dialog.showOpenDialog({
          title: '选择工作目录',
          defaultPath: supervisor.workdir,
          properties: ['openDirectory', 'createDirectory'],
        });
        return r.canceled ? null : r.filePaths[0];
      },
    });
    const port = await bridge.listen(0);
    targetUrl = `http://127.0.0.1:${port}/`;
  }

  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    title: 'Personal AI',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? {} : {
      titleBarOverlay: {
        color: '#0f1115',
        symbolColor: '#9ca3af',
        height: 32,
      },
    }),
    backgroundColor: '#0f1115',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
    },
  });
  mainWindow.removeMenu();

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown') {
      if (input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r')) {
        event.preventDefault();
        mainWindow.reload();
      } else if (input.key === 'F12' || ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i')) {
        event.preventDefault();
        mainWindow.webContents.toggleDevTools();
      }
    }
  });

  ipcMain.on('pai_theme_changed', (_e, theme) => {
    if (mainWindow && !mainWindow.isDestroyed() && process.platform === 'win32') {
      try {
        mainWindow.setTitleBarOverlay({
          color: theme === 'light' ? '#f8fafc' : '#0f1115',
          symbolColor: theme === 'light' ? '#334155' : '#9ca3af',
          height: 32,
        });
      } catch {}
    }
  });
  // dedup-h #1077 — window.open (OAuth/外链) goes to the SYSTEM browser, never
  // an in-app window; only http(s) is allowed out.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        void shell.openExternal(u.href);
      }
    } catch { /* malformed target — deny the window either way */ }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-fail-load', (e, code, desc, url) => {
    console.error(`[Desktop] Page failed to load: ${code} ${desc} (${url})`);
  });

  mainWindow.webContents.on('render-process-gone', (e, details) => {
    console.error('[Desktop] Renderer process gone:', details);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.reload();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(targetUrl);
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // If another instance is running, exit immediately
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(boot).catch(async (e) => {
    const rawMsg = e?.stack ?? e?.message ?? String(e);
    let userMsg = rawMsg;
    if (rawMsg.includes('canonical-writer lease held by')) {
      userMsg = '检测到已有另一个 Personal AI 进程或开发服务正在运行并持有核心写入锁。\n\n请检查后台任务栏或关闭终端中的 node 进程后再试。';
    }
    try { await dialog.showErrorBox('Personal AI failed to start', userMsg); } catch { /* pre-ready */ }
    await supervisor?.dispose().catch(() => {});
    bridge?.close();
    app.exit(1);
  });

  app.on('window-all-closed', async () => {
    await supervisor?.dispose().catch(() => {});
    bridge?.close();
    app.quit();
  });
}
