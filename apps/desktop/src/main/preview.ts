import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebContentsView, type BrowserWindow } from 'electron';

export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The project's dev command + the port it's expected to serve on. */
export function detectDevCommand(dir: string): { command: string; port: number } | null {
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const scripts = pkg.scripts ?? {};
  const scriptName = ['dev', 'start', 'serve'].find((s) => typeof scripts[s] === 'string');
  if (!scriptName) return null;
  const text = scripts[scriptName] ?? '';
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  let port = 0;
  const m = /(?:--port[ =]|-p[ =])(\d{2,5})/.exec(text);
  if (m) port = Number(m[1]);
  else if (deps.next || text.includes('next ')) port = 3000;
  else if (deps.vite || text.includes('vite') || deps['@sveltejs/kit']) port = 5173;
  else if (deps['react-scripts']) port = 3000;
  else if (deps['@angular/cli'] || text.includes('ng serve')) port = 4200;
  else if (deps.astro || text.includes('astro')) port = 4321;
  else if (deps['@vue/cli-service']) port = 8080;
  else port = 3000;
  return { command: `npm run ${scriptName}`, port };
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
}

async function portResponds(port: number): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 400);
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ctl.signal });
    clearTimeout(timer);
    return res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Live preview pane: a WebContentsView (BrowserView is deprecated) laid over
 * the renderer's measured placeholder region, pointed at the project's own
 * dev server — its HMR does the hot work, the harness just hosts the pane.
 */
export class PreviewManager {
  private view: WebContentsView | null = null;
  private currentUrl: string | null = null;
  private devChild: ChildProcess | null = null;

  constructor(private getWindow: () => BrowserWindow | null) {}

  /**
   * Start the project's own dev server (Vite/Next/etc.) and wait until its
   * port answers. A bundler entry index.html can't be previewed from disk —
   * only a running dev server serves the transformed modules — so this is the
   * real path to a UI preview. The child is tied to the preview lifecycle and
   * killed on close/quit.
   */
  async startDev(
    dir: string,
  ): Promise<{ ok: boolean; url?: string; error?: string; log?: string }> {
    const cmd = detectDevCommand(dir);
    if (!cmd) {
      return { ok: false, error: 'No dev/start/serve script found in this project’s package.json.' };
    }
    // Already have one running for this preview? If its port answers, reuse it.
    if (this.devChild && this.devChild.exitCode === null) {
      if (await portResponds(cmd.port)) return { ok: true, url: `http://localhost:${cmd.port}/` };
    } else {
      this.stopDev();
    }

    const child = spawn(cmd.command, { cwd: dir, shell: true, windowsHide: true, env: process.env });
    this.devChild = child;
    let log = '';
    let discovered: number | null = null;
    const onData = (buf: Buffer): void => {
      const s = buf.toString();
      log += s;
      if (log.length > 8000) log = log.slice(-8000);
      const hit = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})/.exec(s);
      if (hit && !discovered) discovered = Number(hit[1]);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    return new Promise((resolve) => {
      let settled = false;
      const done = (r: { ok: boolean; url?: string; error?: string; log?: string }): void => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      child.on('error', (err) => done({ ok: false, error: err.message, log }));
      child.on('exit', (code) =>
        done({ ok: false, error: `Dev server exited (code ${code}) before it was ready.`, log }),
      );
      const deadline = Date.now() + 40_000;
      const tick = async (): Promise<void> => {
        if (settled) return;
        const ports = [discovered, cmd.port, 5173, 3000, 4200, 4321, 8080].filter(
          (p): p is number => !!p,
        );
        for (const port of ports) {
          if (await portResponds(port)) {
            done({ ok: true, url: `http://localhost:${port}/` });
            return;
          }
        }
        if (Date.now() > deadline) {
          done({
            ok: false,
            error: 'Dev server did not come up within 40s. Check the terminal / install deps.',
            log,
          });
          return;
        }
        setTimeout(() => void tick(), 700);
      };
      setTimeout(() => void tick(), 900);
    });
  }

  private stopDev(): void {
    if (this.devChild) {
      killTree(this.devChild.pid);
      this.devChild = null;
    }
  }

  private ensureView(): WebContentsView | null {
    const win = this.getWindow();
    if (!win) return null;
    if (!this.view) {
      this.view = new WebContentsView({
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      win.contentView.addChildView(this.view);
      this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
    return this.view;
  }

  open(url: string): { ok: boolean; error?: string } {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: 'Only http(s) URLs can be previewed.' };
      }
    } catch {
      return { ok: false, error: `Not a valid URL: ${url}` };
    }
    const view = this.ensureView();
    if (!view) return { ok: false, error: 'No window' };
    this.currentUrl = url;
    void view.webContents.loadURL(url).catch(() => {
      /* load errors show inside the pane */
    });
    return { ok: true };
  }

  /** Static preview: load a project HTML file straight into the pane. */
  openFile(path: string): { ok: boolean; error?: string } {
    const view = this.ensureView();
    if (!view) return { ok: false, error: 'No window' };
    this.currentUrl = `file:///${path.replace(/\\/g, '/')}`;
    void view.webContents.loadFile(path).catch(() => {
      /* load errors show inside the pane */
    });
    return { ok: true };
  }

  setBounds(bounds: PreviewBounds): void {
    this.view?.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
  }

  hide(): void {
    this.view?.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }

  reload(): void {
    this.view?.webContents.reload();
  }

  close(): void {
    const win = this.getWindow();
    if (this.view) {
      win?.contentView.removeChildView(this.view);
      this.view.webContents.close();
      this.view = null;
      this.currentUrl = null;
    }
    // A dev server we started dies with the preview — no orphan npm processes.
    this.stopDev();
  }

  state(): { url: string | null } {
    return { url: this.currentUrl };
  }
}
