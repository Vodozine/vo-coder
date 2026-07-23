import { BrowserWindow } from 'electron';
import { join } from 'node:path';

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 560,
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    // Frameless feel: hide the OS title bar but keep native window buttons
    // overlaid on the app's own chrome (Windows). The renderer provides drag
    // regions (.drag-strip / header bars).
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { color: '#0b0e14', symbolColor: '#8791a6', height: 40 },
        }
      : {}),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
  return win;
}
