import { dialog, type BrowserWindow, type OpenDialogOptions, type SaveDialogOptions } from 'electron';
import { currentCaller } from './ipc-registry';

/**
 * A file dialog that opens where the person is.
 *
 * Fourteen handlers open one. Each calls Electron's `dialog`, which draws a
 * window on THIS machine — right when this machine is the one being used, and
 * wrong the moment it is not. Asked for by a laptop driving a desktop, the
 * dialog would appear on the desktop, where nobody is looking; asked for on a
 * container, it would not appear at all and the call would never return.
 *
 * So the call is routed instead of moved: same shape, same options, same
 * return value, and every one of those handlers is unchanged. If the request
 * arrived over a socket it goes back down that socket and the front end draws
 * the picker; otherwise Electron draws it, exactly as before.
 *
 * The front end answers in Electron's own shape — { canceled, filePaths } —
 * so nothing downstream has to know which of the two happened.
 */

/** What the front end sends back, mirroring Electron's result objects. */
interface OpenAnswer {
  canceled: boolean;
  filePaths: string[];
}
interface SaveAnswer {
  canceled: boolean;
  filePath?: string;
}

export const hostDialog = {
  async showOpenDialog(
    windowOrOptions: BrowserWindow | OpenDialogOptions,
    maybeOptions?: OpenDialogOptions,
  ): Promise<OpenAnswer> {
    const options = (maybeOptions ?? windowOrOptions) as OpenDialogOptions;
    const caller = currentCaller();
    if (caller) {
      const answer = (await caller.ask('dialog:open', options)) as OpenAnswer | null;
      // Null means the front end went away mid-question. Treated as a cancel,
      // because every caller already handles a cancel and none of them handles
      // an exception from a file dialog.
      return answer ?? { canceled: true, filePaths: [] };
    }
    return maybeOptions
      ? dialog.showOpenDialog(windowOrOptions as BrowserWindow, maybeOptions)
      : dialog.showOpenDialog(windowOrOptions as OpenDialogOptions);
  },

  async showSaveDialog(
    windowOrOptions: BrowserWindow | SaveDialogOptions,
    maybeOptions?: SaveDialogOptions,
  ): Promise<SaveAnswer> {
    const options = (maybeOptions ?? windowOrOptions) as SaveDialogOptions;
    const caller = currentCaller();
    if (caller) {
      const answer = (await caller.ask('dialog:save', options)) as SaveAnswer | null;
      return answer ?? { canceled: true };
    }
    return maybeOptions
      ? dialog.showSaveDialog(windowOrOptions as BrowserWindow, maybeOptions)
      : dialog.showSaveDialog(windowOrOptions as SaveDialogOptions);
  },
};
