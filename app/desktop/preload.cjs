/**
 * Desktop preload script — exposes safe, minimal system IPC bridge.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  setTheme: (theme) => {
    try {
      ipcRenderer.send('pai_theme_changed', theme);
    } catch {}
  },
});
