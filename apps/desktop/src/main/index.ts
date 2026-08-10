import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { registerIpc } from './ipc';
import { createMainWindow } from './windows';

/**
 * One-time profile adoption after a package rename (Free: @vo-coder/desktop →
 * vo-coder). The userData folder tracks the app name, so renaming would strand
 * an existing user's profile under the old name. Runs only when THIS profile
 * has no projects.json and the legacy one does — otherwise it never touches
 * anything.
 */
function adoptLegacyProfile(): void {
  try {
    const current = app.getPath('userData');
    if (existsSync(join(current, 'projects.json'))) return;
    const legacy = join(dirname(current), '@vo-coder', 'desktop');
    if (resolve(legacy) === resolve(current)) return;
    if (!existsSync(join(legacy, 'projects.json'))) return;
    cpSync(legacy, current, { recursive: true, errorOnExist: false, force: false });
    console.log(`[profile] adopted legacy profile from ${legacy}`);
  } catch (err) {
    // A failed adoption must never block startup — the app just starts fresh.
    console.error('[profile] legacy adoption failed:', err);
  }
}

// Isolated profile override (screenshots/testing) — must run before anything
// reads a userData path. Never set in normal use.
if (process.env.VO_USERDATA) app.setPath('userData', process.env.VO_USERDATA);

// Windows stops compositing a window it considers fully covered, and
// capturePage on it rejects with UnknownVizError — which is exactly what
// happens during a capture run while the real app sits in front. Only for
// capture runs; normal launches keep the occlusion optimisation.
if (process.env.VO_CAPTURE) {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

let mainWindow: BrowserWindow | null = null;

function openWindow(): void {
  mainWindow = createMainWindow();
  // Drop the reference the moment the window dies so late events from PTYs,
  // watchers, and streams have nowhere destroyed to land.
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  if (process.env.VO_CAPTURE) {
    const target = process.env.VO_CAPTURE;
    void captureAllViews(mainWindow, target)
      .catch((err) => console.error('[capture] run failed:', err))
      .finally(() => app.quit());
  }
}

/**
 * Marketing capture: cycle the nav and snap each view with the window's own
 * compositor (crisp, correctly cropped) instead of driving the desktop. Gated
 * behind VO_CAPTURE so it never affects a real run.
 */
async function captureAllViews(win: BrowserWindow, outDir: string): Promise<void> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  mkdirSync(outDir, { recursive: true });
  // One unlucky frame must not kill the whole run: retry, then move on. A
  // missing shot is a missing file; a throw here used to abandon every view
  // after it.
  const snap = async (name: string) => {
    await wait(900);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const img = await win.webContents.capturePage();
        if (img.isEmpty()) throw new Error('empty frame');
        writeFileSync(join(outDir, `${name}.png`), img.toPNG());
        console.log(`[capture] ${name}`);
        return;
      } catch (err) {
        if (attempt === 3) {
          console.error(`[capture] ${name} failed:`, err);
          return;
        }
        await wait(1200);
      }
    }
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

  /** Set a <select> by visible option text and fire React's change. */
  const selectByText = (sel: string, text: string) =>
    win.webContents.executeJavaScript(
      `(()=>{const s=document.querySelector(${JSON.stringify(sel)});if(!s)return false;
        const o=[...s.options].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(!o)return false;
        const setter=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;
        setter.call(s,o.value);s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
    );

  await new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()));
  // Marketing shots get a roomier window than the default: the split view and
  // the code panes look cramped at the everyday size.
  win.setContentSize(1600, 1000);
  win.center();
  /** Open a chat by (part of) its sidebar title. */
  const openChat = (title: string) =>
    win.webContents.executeJavaScript(
      `(()=>{const r=[...document.querySelectorAll('.session-row .session-title')]
        .find(e=>e.textContent.includes(${JSON.stringify(title)}));
        if(r){r.click();return true}return false})()`,
    );

  await wait(3500); // initial data (catalog, projects, missions)
  // Chat itself is captured last, once a deliberate conversation is open — the
  // restored session is whatever the profile happened to leave behind.
  for (const label of ['Agents', 'Missions', 'Scaffold', 'Settings']) {
    await clickNav(label);
    await snap(label.toLowerCase());
  }

  // Terminal: an empty prompt says nothing, so run two version checks — the
  // most side-effect-free commands there are — and shoot a shell in use.
  await clickNav('Terminal');
  await wait(1200);
  await win.webContents.executeJavaScript(
    `document.querySelector('.xterm-helper-textarea, .terminal textarea, textarea')?.focus()`,
  );
  for (const cmd of ['node -v', 'npm -v', 'git --version']) {
    for (const ch of cmd) {
      win.webContents.sendInputEvent({ type: 'char', keyCode: ch } as never);
    }
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' } as never);
    await wait(1100);
  }
  await snap('terminal');

  // Agent editor with the model picker open. The picker only lists providers
  // that are usable right now, so on a profile without keys the local fleet is
  // what it can show — switching the provider dropdown just empties it.
  await clickNav('Agents');
  await wait(600);
  await clickText('.agent-row button', 'Edit');
  await wait(700);
  await click('.model-picker-value');
  await wait(600);
  await snap('agents-edit');

  // Group projects: several agents on one goal, side by side. Pick the BIGGEST
  // group (the bundle head's tooltip carries "— N chats"), because a one-member
  // run in an 8-slot grid shows nothing of what the view is for.
  await clickNav('Chat');
  await wait(600);
  const grouped = await win.webContents.executeJavaScript(
    `(()=>{const heads=[...document.querySelectorAll('.session-row.bundle-head .session-title')];
      const n=e=>{const m=/—\\s*(\\d+)\\s*chats/.exec(e.getAttribute('title')||'');return m?+m[1]:0};
      const best=heads.sort((a,b)=>n(b)-n(a))[0];
      if(!best||n(best)<2)return false;
      window.__vocapBundle=best.closest('.group-bundle');
      best.click();return true})()`,
  );
  if (grouped) {
    await wait(700);
    // Expanded bundle → click the first member chat inside THAT bundle.
    await win.webContents.executeJavaScript(
      `(window.__vocapBundle?.querySelector('.session-row.in-bundle .session-title'))?.click()`,
    );
    await wait(3000);
    await selectByText('.group-head select, .group-view select', '8 per page');
    await wait(1500);
    await snap('group-8');
    await selectByText('.group-head select, .group-view select', '4 per page');
    await wait(1200);
    await snap('group-4');
  }

  // Design suite — Pro only, so the nav item decides whether these run at all.
  if (await clickNav('Design')) {
    await wait(2500);
    await snap('design-label');
    await clickText('.design-tab', '3D Mockup');
    await wait(2200);
    await snap('design-mockup');
    await clickText('.design-tab', 'Dieline');
    await wait(1800);
    await snap('design-dieline');
  }

  // Preview follows the active chat's folder — still the group's, so the tree
  // holds what those agents just built.
  await clickNav('Preview');
  await wait(1400);
  await clickText('.tree-row', 'index.html');
  await snap('preview');

  // Split view: the chat beside the pane. Deliberately shot with CODE on the
  // right, not Browser — capturePage() photographs this webContents only, and
  // the browser pane is a NATIVE view above it, so a Browser split would come
  // out as the empty checkered placeholder. Code is real DOM and shoots true.
  await clickText('.mode-switch button', 'Split');
  await wait(1600);
  await snap('preview-split');
  await clickText('.mode-switch button', 'Split'); // leave it as we found it
  await wait(600);

  // A single build conversation: open it deliberately, then shoot the chat and
  // its context popup from there.
  await clickNav('Chat');
  await wait(600);
  await openChat('make a replica');
  await wait(2500);
  await snap('chat');
  await click('.ctx-chip');
  await snap('chat-context');

  // Memory is project-scoped, and the chat above set the project — so the map
  // on screen is that project's, not a pile of everything.
  await clickNav('Memory');
  await wait(2200);
  await snap('memory');

  // Mr Homelab — only present when enabled; harmless no-op otherwise.
  if (await clickNav('Mr Homelab')) {
    await wait(2000);
    await snap('homelab');
  }
  await wait(800);
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

  void adoptLegacyProfile();

app.whenReady().then(() => {
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
