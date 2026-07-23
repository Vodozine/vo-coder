import { WebContentsView, type BrowserWindow } from 'electron';

export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Live preview pane: a WebContentsView (BrowserView is deprecated) laid over
 * the renderer's measured placeholder region, pointed at the project's own
 * dev server — its HMR does the hot work, the harness just hosts the pane.
 */
export class PreviewManager {
  private view: WebContentsView | null = null;
  private currentUrl: string | null = null;

  constructor(private getWindow: () => BrowserWindow | null) {}

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
  }

  state(): { url: string | null } {
    return { url: this.currentUrl };
  }
}
