import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { ToolSpec } from '@vo-coder/providers';

/**
 * Built-in hands for agents working in a project folder: list/read/write files
 * and run commands, scoped strictly to the project directory. Every call still
 * passes the user's per-call permission prompt — the human approves, the agent
 * executes.
 */

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-bundle', 'out', 'release',
  'coverage', '__pycache__', '.venv', '.next', '.turbo',
]);
const MAX_READ_CHARS = 150_000;
const MAX_RUN_OUTPUT = 60_000;
const MAX_LIST_ENTRIES = 400;

export function workspaceToolSpecs(dir: string): ToolSpec[] {
  return [
    {
      name: 'ws_list',
      description: `List files and folders in the project (${dir}). Build tools like node_modules are hidden.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative subfolder (default: project root)' },
        },
      },
    },
    {
      name: 'ws_read',
      description: 'Read a text file from the project folder.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative file path' } },
        required: ['path'],
      },
    },
    {
      name: 'ws_write',
      description:
        'Write a file in the project folder (creates parent folders; overwrites). Use this to actually build the project instead of telling the user what to type.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'ws_run',
      description:
        'Run a shell command in the project folder (npm install, npm run build, tests, git…). ' +
        'Waits for the command to FINISH and returns its exit code and output. ' +
        'To LAUNCH a GUI app or start a long-running server (an .exe, npm start, electron .) for ' +
        'the user to try, set background:true — it starts the process detached and returns at ' +
        'once. A normal (foreground) ws_run on something that never exits will block the turn.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line to run' },
          timeoutSec: { type: 'number', description: 'Timeout in seconds (default 300, max 600). Ignored when background:true.' },
          background: {
            type: 'boolean',
            description:
              'Launch detached and return immediately (for GUI apps / servers that do not exit). Default false.',
          },
        },
        required: ['command'],
      },
    },
  ];
}

function guarded(dir: string, relPath: string): string {
  const target = resolve(dir, relPath);
  const rel = relative(dir, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path "${relPath}" escapes the project folder.`);
  }
  return target;
}

function listDir(root: string, sub: string): string {
  const lines: string[] = [];
  const walk = (abs: string, prefix: string, depth: number) => {
    if (lines.length >= MAX_LIST_ENTRIES || depth > 4) return;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (lines.length >= MAX_LIST_ENTRIES) return;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (IGNORE_DIRS.has(entry.name)) continue;
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        lines.push(`${path}/`);
        walk(resolve(abs, entry.name), `${path}/`, depth + 1);
      } else {
        let size = 0;
        try {
          size = statSync(resolve(abs, entry.name)).size;
        } catch {
          /* raced */
        }
        lines.push(`${path} (${size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`})`);
      }
    }
  };
  const start = guarded(root, sub || '.');
  walk(start, sub ? `${sub.replace(/[\\/]+$/, '')}/` : '', 0);
  if (lines.length === 0) return '(empty)';
  const truncated = lines.length >= MAX_LIST_ENTRIES ? '\n…(truncated)' : '';
  return lines.join('\n') + truncated;
}

/** Hard-kill a child and everything it spawned (Windows needs the tree walk). */
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

function runCommand(
  dir: string,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise) => {
    if (signal?.aborted) {
      resolvePromise({ code: null, output: '[stopped before start]' });
      return;
    }
    const child = spawn(command, { cwd: dir, shell: true, windowsHide: true, env: process.env });
    let output = '';
    let settled = false;
    const capture = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > MAX_RUN_OUTPUT) output = output.slice(-MAX_RUN_OUTPUT);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolvePromise({ code, output });
    };
    const onAbort = () => {
      killTree(child.pid);
      output += '\n[stopped by user]';
      finish(null);
    };
    const timer = setTimeout(() => {
      killTree(child.pid);
      output += '\n[timed out]';
      finish(null);
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('close', (code) => finish(code));
    child.on('error', (err) => {
      if (settled) return;
      output += (output ? '\n' : '') + err.message;
      finish(null);
    });
  });
}

/** Fire-and-forget launch for GUI apps / servers that never exit on their own. */
function launchDetached(dir: string, command: string): { pid: number | undefined } {
  const child = spawn(command, {
    cwd: dir,
    shell: true,
    windowsHide: true,
    env: process.env,
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  const pid = child.pid;
  child.unref();
  return { pid };
}

export async function executeWorkspaceTool(
  dir: string,
  name: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<{ content: string; isError?: boolean }> {
  const a = (args ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case 'ws_list':
        return { content: listDir(dir, String(a.path ?? '')) };
      case 'ws_read': {
        const target = guarded(dir, String(a.path ?? ''));
        if (!existsSync(target)) return { content: `No such file: ${a.path}`, isError: true };
        const buffer = readFileSync(target);
        if (buffer.subarray(0, 8000).includes(0)) {
          return { content: `${a.path} is a binary file.`, isError: true };
        }
        const text = buffer.toString('utf8');
        return {
          content:
            text.length > MAX_READ_CHARS
              ? `${text.slice(0, MAX_READ_CHARS)}\n…(truncated, ${text.length} chars total)`
              : text,
        };
      }
      case 'ws_write': {
        const target = guarded(dir, String(a.path ?? ''));
        const content = String(a.content ?? '');
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, 'utf8');
        return { content: `Wrote ${content.length} chars to ${a.path}` };
      }
      case 'ws_run': {
        const command = String(a.command ?? '').trim();
        if (!command) return { content: 'No command given.', isError: true };
        if (a.background === true) {
          const { pid } = launchDetached(dir, command);
          return {
            content:
              pid === undefined
                ? `Launched (detached): ${command}`
                : `Launched (detached, PID ${pid}): ${command}\nIt is running independently; this ` +
                  `turn did not wait for it. Ask the user how it looks.`,
          };
        }
        const timeoutMs = Math.min(Math.max(Number(a.timeoutSec) || 300, 5), 600) * 1000;
        const { code, output } = await runCommand(dir, command, timeoutMs, signal);
        return {
          content: `exit code: ${code ?? 'error'}\n\n${output.trim() || '(no output)'}`,
          isError: code !== 0,
        };
      }
      default:
        return { content: `Unknown workspace tool "${name}".`, isError: true };
    }
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}
