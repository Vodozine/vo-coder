import { app, BrowserWindow } from 'electron';
import { registerIpc } from './ipc';
import { createMainWindow } from './windows';

let mainWindow: BrowserWindow | null = null;

function openWindow(): void {
  mainWindow = createMainWindow();
  // Drop the reference the moment the window dies so late events from PTYs,
  // watchers, and streams have nowhere destroyed to land.
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// One instance per profile. Two instances sharing userData means two writers
// on projects.json/config/membank — a proven corruption source (and the lock
// is scoped to userData, so it also stops dev + installed running together on
// the shared profile).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    registerIpc(() => mainWindow);
    openWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        openWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
