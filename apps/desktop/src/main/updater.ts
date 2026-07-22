import { app, ipcMain, type BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import { IPC, type UpdateEvent } from '../shared/ipc-contract';

const { autoUpdater } = electronUpdater;

/**
 * In-app updates: the installed (NSIS/DMG/AppImage) app checks the publish
 * feed, downloads in the background, and installs over itself on restart —
 * userData survives. Inactive in dev; fail-soft when no releases exist yet.
 */
export function initUpdater(getWindow: () => BrowserWindow | null): void {
  const send = (payload: UpdateEvent) => getWindow()?.webContents.send(IPC.updateEvent, payload);

  ipcMain.handle(IPC.appVersion, () => app.getVersion());
  ipcMain.handle(IPC.updateCheck, async (): Promise<UpdateEvent> => {
    if (!app.isPackaged) {
      return { state: 'dev', message: 'Updates only apply to the installed app.' };
    }
    try {
      const result = await autoUpdater.checkForUpdates();
      if (result?.updateInfo && result.updateInfo.version !== app.getVersion()) {
        return { state: 'available', version: result.updateInfo.version };
      }
      return { state: 'none' };
    } catch (err) {
      return { state: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle(IPC.updateInstall, () => {
    autoUpdater.quitAndInstall();
  });

  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-available', (info) => send({ state: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => send({ state: 'none' }));
  autoUpdater.on('update-downloaded', (info) =>
    send({ state: 'downloaded', version: info.version }),
  );
  autoUpdater.on('error', (err) => send({ state: 'error', message: err.message }));
  // First check shortly after launch; then every 4 hours while running.
  setTimeout(() => void autoUpdater.checkForUpdates().catch(() => {}), 8_000);
  setInterval(() => void autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}
