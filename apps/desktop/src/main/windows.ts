import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';

/**
 * A window, optionally forced onto one side of the wire.
 *
 * The role normally comes from the config, which is why two windows in one
 * app were identical: both asked the same question and got the same answer.
 * An override rides in as a launch argument instead, which the preload reads
 * BEFORE the config — per window, because that is what a window is.
 */
export function createMainWindow(forceRole?: 'local' | 'client'): BrowserWindow {
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
      // Read by the preload before it looks at the config, so this window
      // can sit on a different side from its siblings.
      ...(forceRole ? { additionalArguments: [`--vo-role=${forceRole}`] } : {}),
      contextIsolation: true,
      // Not an oversight, and not free to flip: Electron cannot load an ESM
      // preload (.mjs) into a sandboxed renderer, so sandbox:true would break
      // the bridge entirely. Context isolation and nodeIntegration:false still
      // stand between the page and Node, and the guards below keep the renderer
      // on its own content, which is what carries the weight here.
      sandbox: false,
      nodeIntegration: false,
      /**
       * Spoken replies are audio elements created AFTER a round trip to the
       * speech endpoint — seconds later in Live chat, where there is no click
       * at all. Chromium's default policy ties playback to a fresh user
       * gesture and rejects those with NotAllowedError, so cloud voices went
       * silent while the offline system voice (which plays itself, outside the
       * page) was fine. This is the app's own window playing the app's own
       * audio; there is nothing to protect the user from here.
       */
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];

  // The renderer holds a ~90-channel bridge, including a PTY and MCP server
  // registration, so nothing else may ever inherit this preload. Anything that
  // wants a browser gets the real one instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const staysHome = devUrl ? url.startsWith(devUrl) : url.startsWith('file://');
    if (staysHome) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });

  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
  return win;
}

/**
 * A second window, so local and a backend can be open side by side.
 *
 * The role is chosen when a window's preload loads, not when the app starts —
 * which is why two windows in ONE process can sit on different ends of the
 * wire. Nothing about the app is per-role; only the window is.
 *
 * These are extra windows: the app's own lifecycle still follows the first one,
 * and closing an extra takes nothing with it.
 */
const extras = new Set<BrowserWindow>();

export function openExtraWindow(role?: 'local' | 'client'): void {
  const win = createMainWindow(role);
  extras.add(win);
  win.on('closed', () => extras.delete(win));
}
