import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { registerIpc } from './ipc';
import { createMainWindow } from './windows';

// Isolated profile override (screenshots/testing) — must run before anything
// reads a userData path. Never set in normal use.
if (process.env.VO_USERDATA) app.setPath('userData', process.env.VO_USERDATA);

let mainWindow: BrowserWindow | null = null;

function openWindow(): void {
  mainWindow = createMainWindow();
  // Drop the reference the moment the window dies so late events from PTYs,
  // watchers, and streams have nowhere destroyed to land.
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  if (process.env.VO_CAPTURE) void captureAllViews(mainWindow, process.env.VO_CAPTURE);
}

/**
 * Marketing capture: cycle the nav and snap each view with the window's own
 * compositor (crisp, correctly cropped) instead of driving the desktop. Gated
 * behind VO_CAPTURE so it never affects a real run.
 */
async function captureAllViews(win: BrowserWindow, outDir: string): Promise<void> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  mkdirSync(outDir, { recursive: true });
  const snap = async (name: string) => {
    await wait(900);
    const img = await win.webContents.capturePage();
    writeFileSync(join(outDir, `${name}.png`), img.toPNG());
  };
  const clickNav = (label: string) =>
    win.webContents.executeJavaScript(
      `(()=>{const b=[...document.querySelectorAll('.nav-item')].find(x=>x.textContent.trim()===${JSON.stringify(label)});if(b){b.click();return true}return false})()`,
    );
  const click = (sel: string) =>
    win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(sel)})?.click()`);

  const clickText = (sel: string, text: string) =>
    win.webContents.executeJavaScript(
      `[...document.querySelectorAll(${JSON.stringify(sel)})].find(e=>e.textContent.includes(${JSON.stringify(text)}))?.click()`,
    );

  await new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()));
  await wait(3500); // initial data (catalog, projects, missions)
  for (const label of ['Chat', 'Agents', 'Missions', 'Scaffold', 'Terminal', 'Settings']) {
    await clickNav(label);
    await snap(label.toLowerCase());
  }
  // Preview with a file open so it shows highlighted code, not the empty pane.
  await clickNav('Preview');
  await wait(1200);
  await clickText('.tree-row', 'index.html');
  await snap('preview');
  // Agent editor — shows the two-column form + the priced model picker.
  await clickNav('Agents');
  await wait(500);
  await clickText('.agent-row button', 'Edit');
  await wait(500);
  await click('.model-picker-value');
  await snap('agents-edit');
  // Context-window popup over the chat.
  await clickNav('Chat');
  await wait(600);
  await click('.ctx-chip');
  await snap('chat-context');
  await wait(1200);
  app.quit();
}

// One instance per profile. Two writers on one userData means corrupt state
// (projects.json/config/membank) — a proven failure. A different VO_USERDATA
// gets its own lock, so capture runs never collide with the real app.
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
