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
