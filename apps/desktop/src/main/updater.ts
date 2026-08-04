import { app, ipcMain, type BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import { IPC, type UpdateEvent } from '../shared/ipc-contract';
import type { ConfigStore } from './config';

const { autoUpdater } = electronUpdater;

/** Raw electron-updater errors dump headers and cookies — never show those. */
function friendlyUpdateError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes('404')) {
    return 'No update feed yet — the GitHub repository has not been published. Updates activate once the project is on GitHub with releases.';
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(raw)) {
    return 'Could not reach the update server — check your connection and try again.';
  }
  const firstLine = raw.split('\n')[0] ?? raw;
  return firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
}

/**
 * In-app updates: the installed (NSIS/DMG/AppImage) app checks the publish
 * feed, downloads in the background, and installs over itself on restart —
 * userData survives. Inactive in dev; fail-soft when no releases exist yet.
 * Automatic checks respect config.autoUpdate (checked at fire time, so the
 * Settings toggle applies without a restart); the manual button always works.
 *
 * Important: electron-updater always fills `result.updateInfo` with whatever
 * the feed's latest.yml says — even when that version is *older* than the
 * running app (e.g. you installed 1.2.7 from a local build while GitHub's
 * published latest is still 1.2.3). Always gate on `isUpdateAvailable`, never
 * on a bare version inequality, or Settings will offer a downgrade as an update.
 */
export function initUpdater(getWindow: () => BrowserWindow | null, config: ConfigStore): void {
  const send = (payload: UpdateEvent) => {
    const win = getWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(IPC.updateEvent, payload);
  };

  ipcMain.handle(IPC.appVersion, () => app.getVersion());
  ipcMain.handle(IPC.updateCheck, async (): Promise<UpdateEvent> => {
    if (!app.isPackaged) {
      return { state: 'dev', message: 'Updates only apply to the installed app.' };
    }
    try {
      const result = await autoUpdater.checkForUpdates();
      // Prefer the library's semver gate. Falling back to a gt-style string
      // compare only if the field is missing on an older electron-updater.
      const newer =
        result?.isUpdateAvailable === true ||
        (result?.isUpdateAvailable !== false &&
          Boolean(result?.updateInfo?.version) &&
          isVersionNewer(result!.updateInfo!.version, app.getVersion()));
      if (newer && result?.updateInfo?.version) {
        return { state: 'available', version: result.updateInfo.version };
      }
      return { state: 'none' };
    } catch (err) {
      return { state: 'error', message: friendlyUpdateError(err) };
    }
  });
  // Only restart into an update that actually finished downloading. The UI only
  // offers the button in the 'downloaded' state, so this is a backstop rather
  // than a fix for a path anyone walks today: an unconditional quitAndInstall
  // closes the app on any early or stale invocation, which reads as a crash.
  let downloaded = false;
  ipcMain.handle(IPC.updateInstall, () => {
    if (downloaded) autoUpdater.quitAndInstall();
  });

  if (!app.isPackaged) return;

  // Never treat an older feed version as installable (channel / channel-force
  // paths can flip this on; we only ever want forward upgrades).
  autoUpdater.allowDowngrade = false;
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-available', (info) => send({ state: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => send({ state: 'none' }));
  autoUpdater.on('update-downloaded', (info) => {
    downloaded = true;
    send({ state: 'downloaded', version: info.version });
  });
  autoUpdater.on('error', (err) => send({ state: 'error', message: friendlyUpdateError(err) }));
  // First check shortly after launch; then every 4 hours while running.
  const autoCheck = () => {
    if (!config.get().autoUpdate) return;
    void autoUpdater.checkForUpdates().catch(() => {});
  };
  setTimeout(autoCheck, 8_000);
  setInterval(autoCheck, 4 * 60 * 60 * 1000);
}

/** Lightweight semver core compare (x.y.z only) — no prerelease/build handling. */
function isVersionNewer(candidate: string, current: string): boolean {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/i, '')
      .split('.')
      .slice(0, 3)
      .map((p) => {
        const n = parseInt(p.replace(/[^0-9].*$/, ''), 10);
        return Number.isFinite(n) ? n : 0;
      });
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}
