import os from 'node:os';
import { spawn as ptySpawn, type IPty } from '@lydell/node-pty';
import { IPC } from '../shared/ipc-contract';

/**
 * Real integrated terminal: a native PTY (ConPTY on Windows) per session,
 * streamed raw to an xterm.js front end. @lydell/node-pty ships N-API
 * prebuilds, so no compile step and no Electron ABI rebuilds.
 */
export class TerminalManager {
  private ptys = new Map<number, IPty>();
  private seq = 0;

  constructor(private send: (channel: string, payload: unknown) => void) {}

  create(opts: { cwd?: string; cols?: number; rows?: number }): { id: number; shell: string } {
    // $SHELL is absent when a packaged app launches from Finder/desktop, so
    // real platform defaults matter; macOS gets a login shell (-l) so the
    // user's actual PATH (Homebrew et al.) loads from their profile.
    let shell: string;
    let args: string[];
    if (process.platform === 'win32') {
      shell = 'powershell.exe';
      args = ['-NoLogo'];
    } else if (process.platform === 'darwin') {
      shell = process.env.SHELL ?? '/bin/zsh';
      args = ['-l'];
    } else {
      shell = process.env.SHELL ?? '/bin/bash';
      args = [];
    }
    const id = ++this.seq;
    const pty = ptySpawn(shell, args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd || os.homedir(),
      env: process.env as Record<string, string>,
    });
    this.ptys.set(id, pty);
    pty.onData((data) => this.send(IPC.termData, { id, data }));
    pty.onExit(({ exitCode }) => {
      this.ptys.delete(id);
      this.send(IPC.termExit, { id, exitCode });
    });
    return { id, shell };
  }

  input(id: number, data: string): void {
    this.ptys.get(id)?.write(data);
  }

  resize(id: number, cols: number, rows: number): void {
    try {
      this.ptys.get(id)?.resize(Math.max(2, cols), Math.max(2, rows));
    } catch {
      /* racing a dead pty is fine */
    }
  }

  kill(id: number): void {
    this.ptys.get(id)?.kill();
    this.ptys.delete(id);
  }

  killAll(): void {
    for (const id of [...this.ptys.keys()]) this.kill(id);
  }
}
