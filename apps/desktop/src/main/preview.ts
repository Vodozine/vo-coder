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

  open(url: string): { ok: boolean; error?: string } {
    const win = this.getWindow();
    if (!win) return { ok: false, error: 'No window' };
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: 'Only http(s) URLs can be previewed.' };
      }
    } catch {
      return { ok: false, error: `Not a valid URL: ${url}` };
    }
    if (!this.view) {
      this.view = new WebContentsView({
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      win.contentView.addChildView(this.view);
      this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
    this.currentUrl = url;
    void this.view.webContents.loadURL(url).catch(() => {
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
