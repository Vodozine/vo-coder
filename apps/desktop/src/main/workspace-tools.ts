import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { ToolSpec } from '@vo-coder/providers';

/**
 * Built-in hands for agents working in a project folder: list/read/write files
 * and run commands. Every call still passes the user's per-call permission
 * prompt — the human approves, the agent executes.
 *
 * On scope, precisely, because the difference matters when reviewing a grant:
 * ws_list, ws_read and ws_write ARE confined to the project directory, links
 * included (see guarded). ws_run is NOT: it takes an arbitrary command string
 * and `cwd` is only where that command starts, so `cd .. && …` leaves the
 * folder on the first character. Approving a command is approving a command,
 * not approving it within a boundary.
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
        'Write a file in the project folder (creates parent folders; overwrites). Use this to ' +
        'actually build the project instead of telling the user what to type. IMPORTANT: for ' +
        'anything longer than ~150 lines, write it in SEVERAL calls — the first normal, the ' +
        'rest with append:true — instead of one giant call. A single huge call streams for ' +
        'minutes and can get the whole turn aborted as stalled; chunks land fast and show ' +
        'progress.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
          content: { type: 'string', description: 'File content (or the next chunk with append)' },
          append: {
            type: 'boolean',
            description: 'Add to the end of the file instead of overwriting — for chunked writes of long files',
          },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'ws_assemble',
      description:
        'Build ONE file out of ordered part files — the way a block-decomposed deliverable ' +
        'becomes real. Give the parts in their final order; the tool concatenates them and ' +
        'writes the output in a single atomic step. Use it whenever several people (or several ' +
        'turns) each wrote their own blocks/NN_* piece of one file. NEVER re-type blocks into ' +
        'the output by hand: manual re-assembly is slow, serial, and where transcription errors ' +
        'come from. Missing parts fail the call by name — nothing half-assembled is written.',
      inputSchema: {
        type: 'object',
        properties: {
          output: { type: 'string', description: 'Relative path of the file to produce' },
          parts: {
            type: 'array',
            items: { type: 'string' },
            description: 'Part files in their FINAL order (e.g. blocks/01_head.js, blocks/02_core.js)',
          },
          separator: {
            type: 'string',
            description: 'Text between parts (default: one newline)',
          },
        },
        required: ['output', 'parts'],
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
    {
      name: 'ws_stop',
      description:
        'Stop something you launched with ws_run background:true, and list what is still up. ' +
        'Anything you start to LOOK at (the app, a dev server) is yours to close again: call this ' +
        'as soon as you have seen what you needed. Leaving them running fills the machine with ' +
        'copies of the same app. With no arguments it just lists.',
      inputSchema: {
        type: 'object',
        properties: {
          pid: { type: 'number', description: 'The PID from the launch. Omit to list.' },
          all: { type: 'boolean', description: 'Stop everything launched from this app.' },
        },
      },
    },
  ];
}

/**
 * Confine a relative path to the project folder.
 *
 * The lexical check alone was not enough: a symlink or directory junction sitting
 * INSIDE the folder passes it while pointing anywhere on disk, and on Windows a
 * junction needs no elevation to create. So the path is also resolved through
 * its links before being trusted. The target itself often does not exist yet
 * (ws_write creating a new file), so the deepest existing ancestor is what gets
 * resolved. The root is resolved too, since the project folder may legitimately
 * be reached through a link of its own.
 */
/**
 * True when `target` is at or below `root`. The one fence every path-taking
 * tool should share: `startsWith(root)` without a trailing separator lets a
 * sibling whose name EXTENDS the root's ("…/mysite-assets" vs "…/mysite")
 * slip through, and `relative()` closes that — a `..` or an absolute result
 * means the target climbed out.
 */
export function insideRoot(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function guarded(dir: string, relPath: string): string {
  const root = realpathSync(dir);
  const target = resolve(root, relPath);
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path "${relPath}" escapes the project folder.`);
  }

  let probe = target;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const realRel = relative(root, realpathSync(probe));
  if (realRel !== '' && (realRel.startsWith('..') || isAbsolute(realRel))) {
    throw new Error(`Path "${relPath}" escapes the project folder through a link.`);
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

/**
 * Everything the agents have launched and not stopped.
 *
 * Detached launches used to be handed out with no bookkeeping at all: the pid
 * was printed once into a tool result and then nobody — not the agent, not the
 * app — knew the process existed. Seen live: an unattended group run left
 * NINETEEN copies of the same app open, because each verification launched
 * another one and none of them cleaned up. A prompt rule alone could not fix
 * that; the launches have to be counted.
 */
const launched = new Map<number, { command: string; dir: string; at: number }>();

/** Is this pid still alive? Signal 0 tests without touching the process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Drop the ones that exited on their own, so counts are never stale. */
function pruneLaunched(): void {
  for (const pid of [...launched.keys()]) if (!alive(pid)) launched.delete(pid);
}

/** Same command, same folder, still running — a second copy helps nobody. */
function findRunning(dir: string, command: string): number | undefined {
  pruneLaunched();
  const key = command.replace(/\s+/g, ' ').trim().toLowerCase();
  for (const [pid, rec] of launched) {
    if (rec.dir === dir && rec.command.replace(/\s+/g, ' ').trim().toLowerCase() === key) return pid;
  }
  return undefined;
}

export function listLaunched(): Array<{ pid: number; command: string; dir: string; at: number }> {
  pruneLaunched();
  return [...launched.entries()].map(([pid, rec]) => ({ pid, ...rec }));
}

/** Stop one launch (or all of them) and forget it. Returns what was stopped. */
export function stopLaunched(pid?: number): Array<{ pid: number; command: string }> {
  pruneLaunched();
  const targets = pid === undefined ? [...launched.entries()] : ([...launched.entries()].filter(([p]) => p === pid));
  for (const [p] of targets) {
    killTree(p);
    launched.delete(p);
  }
  return targets.map(([p, rec]) => ({ pid: p, command: rec.command }));
}

/**
 * Fire-and-forget launch for GUI apps / servers that never exit on their own.
 *
 * Deliberately outlives the call, so it honours neither the run timeout nor the
 * AbortSignal: stopping the agent does not stop a dev server it started for you.
 * The pid is returned so the process can be stopped on purpose — and recorded
 * here, so it can be stopped even by someone who never saw the tool result.
 */
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
  if (pid !== undefined) launched.set(pid, { command, dir, at: Date.now() });
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
        if (a.append === true) {
          appendFileSync(target, content, 'utf8');
          const total = statSync(target).size;
          return { content: `Appended ${content.length} chars to ${a.path} (${total} bytes total)` };
        }
        writeFileSync(target, content, 'utf8');
        return { content: `Wrote ${content.length} chars to ${a.path}` };
      }
      case 'ws_assemble': {
        const outRel = String(a.output ?? '').trim();
        const partsRaw = Array.isArray(a.parts) ? a.parts.map((p) => String(p ?? '').trim()) : [];
        const parts = partsRaw.filter(Boolean);
        if (!outRel || parts.length === 0) {
          return { content: 'ws_assemble needs output and a non-empty parts list.', isError: true };
        }
        const outTarget = guarded(dir, outRel);
        // Refuse an output that is also an input — reading and replacing the
        // same file in one call is how a deliverable gets eaten.
        const partTargets = parts.map((p) => ({ rel: p, abs: guarded(dir, p) }));
        if (partTargets.some((p) => p.abs === outTarget)) {
          return { content: `Output "${outRel}" is also listed as a part.`, isError: true };
        }
        const missing = partTargets.filter((p) => !existsSync(p.abs)).map((p) => p.rel);
        if (missing.length) {
          return {
            content:
              `Not assembled — ${missing.length} part(s) missing: ${missing.join(', ')}. ` +
              'Nothing was written. Get those blocks delivered first, or drop them from the list.',
            isError: true,
          };
        }
        const separator = typeof a.separator === 'string' ? a.separator : '\n';
        const pieces: string[] = [];
        const sizes: string[] = [];
        for (const p of partTargets) {
          const buffer = readFileSync(p.abs);
          if (buffer.subarray(0, 8000).includes(0)) {
            return { content: `${p.rel} is a binary file — ws_assemble joins text.`, isError: true };
          }
          const text = buffer.toString('utf8');
          pieces.push(text);
          sizes.push(`${p.rel} (${text.length} chars)`);
        }
        // Temp-then-rename: a reader (or a crash) can never observe a torn
        // half-assembled deliverable.
        mkdirSync(dirname(outTarget), { recursive: true });
        const joined = pieces.join(separator);
        const tmp = `${outTarget}.assembling`;
        writeFileSync(tmp, joined, 'utf8');
        renameSync(tmp, outTarget);
        return {
          content:
            `Assembled ${outRel} (${joined.length} chars) from ${parts.length} parts in order:\n` +
            sizes.map((s) => `  ${s}`).join('\n'),
        };
      }
      case 'ws_run': {
        const command = String(a.command ?? '').trim();
        if (!command) return { content: 'No command given.', isError: true };
        if (a.background === true) {
          // Already up? Hand back the one that is running. Nineteen copies of
          // the same app were started this way, each verification launching
          // another — the guard is here rather than in the prompt because the
          // prompt was already asked and it still happened.
          const running = findRunning(dir, command);
          if (running !== undefined) {
            return {
              content:
                `Already running from an earlier launch (PID ${running}): ${command}\n` +
                'Not started a second time — use the one that is up, and ws_stop it when you are ' +
                'done checking.',
            };
          }
          const { pid } = launchDetached(dir, command);
          const others = listLaunched().filter((l) => l.pid !== pid).length;
          return {
            content:
              (pid === undefined
                ? `Launched (detached): ${command}`
                : `Launched (detached, PID ${pid}): ${command}\nIt is running independently; this ` +
                  `turn did not wait for it. Ask the user how it looks.`) +
              `\nStop it with ws_stop when you are done — do not leave it running.` +
              (others > 0
                ? `\n[${others} other process(es) you started are still up. ws_stop with all:true ` +
                  'clears them.]'
                : ''),
          };
        }
        const timeoutMs = Math.min(Math.max(Number(a.timeoutSec) || 300, 5), 600) * 1000;
        const { code, output } = await runCommand(dir, command, timeoutMs, signal);
        return {
          content: `exit code: ${code ?? 'error'}\n\n${output.trim() || '(no output)'}`,
          isError: code !== 0,
        };
      }
      case 'ws_stop': {
        const running = listLaunched();
        if (a.all !== true && a.pid === undefined) {
          return {
            content: running.length
              ? `Still running:\n${running.map((l) => `  PID ${l.pid} — ${l.command}`).join('\n')}`
              : 'Nothing you launched is still running.',
          };
        }
        const stopped = stopLaunched(a.all === true ? undefined : Number(a.pid));
        if (!stopped.length) {
          return {
            content:
              a.all === true
                ? 'Nothing to stop.'
                : `No launch with PID ${a.pid} — it already exited, or it was not started here.`,
          };
        }
        const left = listLaunched().length;
        return {
          content:
            `Stopped:\n${stopped.map((s) => `  PID ${s.pid} — ${s.command}`).join('\n')}` +
            (left ? `\n${left} still running.` : '\nNothing left running.'),
        };
      }
      default:
        return { content: `Unknown workspace tool "${name}".`, isError: true };
    }
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}
