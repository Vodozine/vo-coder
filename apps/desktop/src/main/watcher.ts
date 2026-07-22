import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { watch, type FSWatcher } from 'chokidar';
import { IPC, type WatchEvent, type WatchGitStatus } from '../shared/ipc-contract';

const pExecFile = promisify(execFile);

const IGNORED = /[\\/](node_modules|\.git|dist|dist-bundle|out|release|coverage|__pycache__|\.venv|\.next|\.turbo)([\\/]|$)/;
const MAX_FILE_BYTES = 400_000;

/**
 * Watches one project folder for the Code preview: initial scan builds the
 * baseline tree, then every write/create/delete streams to the renderer so it
 * can follow the work in real time. awaitWriteFinish smooths agents that write
 * files in bursts.
 */
export class ProjectWatcher {
  private watcher: FSWatcher | null = null;
  root: string | null = null;
  private ready = false;
  private git = false;
  private gitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private send: (channel: string, payload: unknown) => void) {}

  async start(dir: string): Promise<{ ok: boolean; error?: string }> {
    await this.stop();
    const root = resolve(dir);
    try {
      if (!statSync(root).isDirectory()) return { ok: false, error: 'Not a directory' };
    } catch {
      return { ok: false, error: `Cannot open ${root}` };
    }
    this.root = root;
    this.ready = false;
    // Git repos get commit-truth review states; plain folders fall back to
    // session states (changes since watching started).
    this.git = await pExecFile('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root })
      .then(() => true)
      .catch(() => false);
    const emit = (kind: WatchEvent['kind'], absPath: string) => {
      const rel = relative(root, absPath);
      if (!rel || rel.startsWith('..')) return;
      this.send(IPC.watchEvent, {
        kind,
        path: rel.split(sep).join('/'),
        initial: !this.ready,
      } satisfies WatchEvent);
      if (this.ready && this.git) this.scheduleGitStatus();
    };
    this.watcher = watch(root, {
      ignored: (p) => IGNORED.test(p),
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
    })
      .on('add', (p) => emit('add', p))
      .on('change', (p) => emit('change', p))
      .on('unlink', (p) => emit('unlink', p))
      .on('unlinkDir', (p) => emit('unlinkDir', p))
      .on('ready', () => {
        this.ready = true;
        this.send(IPC.watchEvent, { kind: 'ready', path: '', initial: false } satisfies WatchEvent);
        if (this.git) void this.sendGitStatus();
        else this.send(IPC.watchGit, { git: false, states: {} } satisfies WatchGitStatus);
      })
      .on('error', () => {
        /* transient FS errors (locked files) are non-fatal */
      });
    return { ok: true };
  }

  async stop(): Promise<void> {
    if (this.gitTimer) clearTimeout(this.gitTimer);
    this.gitTimer = null;
    if (this.watcher) {
      await this.watcher.close().catch(() => {});
      this.watcher = null;
    }
    this.root = null;
    this.ready = false;
    this.git = false;
  }

  private scheduleGitStatus(): void {
    if (this.gitTimer) clearTimeout(this.gitTimer);
    this.gitTimer = setTimeout(() => void this.sendGitStatus(), 800);
  }

  private async sendGitStatus(): Promise<void> {
    if (!this.git || !this.root) return;
    try {
      const { stdout } = await pExecFile('git', ['status', '--porcelain'], {
        cwd: this.root,
        maxBuffer: 10 * 1024 * 1024,
      });
      const states: WatchGitStatus['states'] = {};
      for (const line of String(stdout).split('\n')) {
        if (line.length < 4) continue;
        const xy = line.slice(0, 2);
        let path = line.slice(3).trim();
        if (xy.includes('R')) path = path.split(' -> ').pop() ?? path;
        if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
        states[path] = xy.includes('D') ? 'deleted' : xy === '??' || xy.includes('A') ? 'added' : 'modified';
      }
      this.send(IPC.watchGit, { git: true, states } satisfies WatchGitStatus);
    } catch {
      /* transient (index.lock during commits) — next change reschedules */
    }
  }

  /** Content at HEAD for real review diffs; ok:false for untracked/new files. */
  async readBaseline(relPath: string): Promise<{ ok: boolean; content?: string }> {
    if (!this.git || !this.root) return { ok: false };
    const posix = relPath.split(sep).join('/');
    try {
      const { stdout } = await pExecFile('git', ['show', `HEAD:${posix}`], {
        cwd: this.root,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { ok: true, content: String(stdout) };
    } catch {
      return { ok: false };
    }
  }

  /** Read a file strictly inside the watched root (path-traversal guarded). */
  read(relPath: string): { ok: boolean; content?: string; truncated?: boolean; error?: string } {
    if (!this.root) return { ok: false, error: 'Nothing is being watched.' };
    const target = resolve(this.root, relPath);
    const rel = relative(this.root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return { ok: false, error: 'Path escapes the watched folder.' };
    }
    try {
      const stats = statSync(target);
      if (stats.size > 5_000_000) return { ok: false, error: 'File too large to preview.' };
      const buffer = readFileSync(target);
      const slice = buffer.subarray(0, MAX_FILE_BYTES);
      if (slice.includes(0)) return { ok: false, error: 'Binary file.' };
      return {
        ok: true,
        content: slice.toString('utf8'),
        truncated: buffer.length > MAX_FILE_BYTES,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
