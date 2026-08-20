import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { streamLines, type ProviderEvent } from '@vo-coder/providers';

/**
 * The process half every CLI-agent provider shares.
 *
 * Claude Code and Codex are the same arrangement seen from Vo-Coder: a
 * complete coding agent the user installed and logged into, spawned headless
 * once per turn, narrating a JSONL stream back. Everything about that which is
 * NOT the stream's dialect lives here — finding nothing (that stays per
 * provider), but spawning, killing, stdin, the held-events discipline of a
 * suppressed resume attempt, and the child registry that keeps app quit from
 * leaving orphans. The dialects (argv, parsing, error prose) stay in each
 * provider, handed in as a small adapter.
 */

export interface ResolvedBinary {
  path: string;
  /** 'exe' spawns directly; 'cli-js' runs under Electron-as-Node — npm shims
   *  are never executed, so cmd.exe never sees user text. */
  kind: 'exe' | 'cli-js';
}

/** How a spawned turn is tied to a chat (or mission). Chat bindings persist the
 *  CLI session id in the session meta so a restart still resumes. */
export interface CliSessionBinding {
  /** Chat session id, or `mission:<id>` — only used as a map key. */
  key: string;
  /** Working folder for the child — the chat's project dir. */
  dir?: string;
  persistedId?: () => string | undefined;
  persist?: (cliId: string | null) => void;
  /** Missions run unattended: they force bypassPermissions so an
   *  unanswerable prompt can never wedge a scheduled run. */
  permissionMode?: string;
}

export interface TurnSummary {
  sawResult: boolean;
  erred: boolean;
  exitCode: number | null;
  stderrTail: string;
}

/** The stream dialect a provider hands the runner. */
export interface CliParseAdapter<S> {
  newState(): S;
  /** One stdout line → events (+ the announced session id, once). */
  parse(line: string, state: S): { events: ProviderEvent[]; sessionId?: string };
  sawResult(state: S): boolean;
  /** Error prose when the child exits without ever producing a result. */
  exitError(detail: string, exitCode: number | null): string;
}

/** Every live child, so quitting the app never leaves a CLI running headless.
 *  One registry for all CLI providers — quit closes claude and codex alike. */
const children = new Map<number, ChildProcess>();

export function closeAllCliChildren(): void {
  for (const child of children.values()) killTree(child.pid);
  children.clear();
}

/** Same idiom as workspace-tools' runner: Windows needs the whole tree gone. */
export function killTree(pid: number | undefined): void {
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

/** How to actually invoke a resolved binary. cli.js runs on the bundled
 *  Electron-as-Node runtime, so a packaged app needs no system Node at all.
 *  `scrubEnv` is the provider's chance to strip the env-poisoning markers a
 *  Vo-Coder launched FROM such a CLI session would otherwise pass down. */
export function spawnForm(
  binary: ResolvedBinary,
  args: string[],
  scrubEnv: (env: NodeJS.ProcessEnv) => void,
): { cmd: string; argv: string[]; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  scrubEnv(env);
  if (binary.kind === 'cli-js') {
    env.ELECTRON_RUN_AS_NODE = '1';
    return { cmd: process.execPath, argv: [binary.path, ...args], env };
  }
  delete env.ELECTRON_RUN_AS_NODE;
  return { cmd: binary.path, argv: args, env };
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One child process, start to finish. Yields provider events; returns what
 * happened so the caller can decide on the resume-retry. When
 * `suppressErrors` is set a failed turn ends silently (no error event, no
 * done) — the caller is about to retry and two error bubbles for one turn
 * would read as two failures.
 */
export async function* runCliTurn<S>(opts: {
  binary: ResolvedBinary;
  args: string[];
  prompt: string;
  cwd: string;
  signal: AbortSignal;
  persist: (id: string | null) => void;
  suppressErrors: boolean;
  adapter: CliParseAdapter<S>;
  scrubEnv: (env: NodeJS.ProcessEnv) => void;
  /** "Could not start <name>" prose for a spawn that throws outright. */
  startError: (detail: string) => string;
}): AsyncGenerator<ProviderEvent, TurnSummary> {
  const { binary, args, prompt, cwd, signal, persist, suppressErrors, adapter } = opts;
  const summary: TurnSummary = { sawResult: false, erred: false, exitCode: null, stderrTail: '' };
  if (signal.aborted) {
    yield { type: 'done', stopReason: 'aborted' };
    return summary;
  }

  const { cmd, argv, env } = spawnForm(binary, args, opts.scrubEnv);
  let child: ChildProcess;
  try {
    child = spawn(cmd, argv, {
      cwd: existsSync(cwd) ? cwd : homedir(),
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (!suppressErrors) {
      yield {
        type: 'error',
        error: { kind: 'unknown', message: opts.startError(messageOf(err)) },
      };
    }
    summary.erred = true;
    return summary;
  }
  if (child.pid !== undefined) children.set(child.pid, child);

  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4_000);
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once('close', (code) => resolve(code));
    child.once('error', () => resolve(null));
  });
  const onAbort = () => killTree(child.pid);
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    // The prompt goes down stdin: argv on Windows has a 32k ceiling and a
    // prompt is user prose that must never meet a shell.
    child.stdin?.on('error', () => {});
    child.stdin?.end(prompt);

    const state = adapter.newState();
    // A suppressed attempt (a resume about to be retried fresh) must leave
    // NO trace unless it succeeds — otherwise the CLI's failure prose lands
    // in the transcript and the retry repeats the same complaint under it.
    // Prose is held back until the result confirms the attempt; heartbeats
    // pass through so the stall watchdog stays fed either way.
    let held: ProviderEvent[] | null = suppressErrors ? [] : null;
    for await (const line of streamLines(
      child.stdout as unknown as ReadableStream<Uint8Array>,
    )) {
      const parsed = adapter.parse(line, state);
      // Persist the moment the CLI announces itself: a crash mid-turn must
      // not orphan a session that already exists on disk.
      if (parsed.sessionId) persist(parsed.sessionId);
      if (held && adapter.sawResult(state)) {
        yield* held;
        held = null;
      }
      for (const event of parsed.events) {
        if (event.type === 'error') {
          summary.erred = true;
          if (suppressErrors) continue;
        }
        if (held && (event.type === 'text_delta' || event.type === 'thinking_delta')) {
          held.push(event);
          continue;
        }
        yield event;
      }
    }
    summary.sawResult = adapter.sawResult(state);

    // The stream is over; the child should be too. A lingering process after
    // its result is the third way a turn hangs — it gets three seconds.
    const grace = setTimeout(() => killTree(child.pid), 3_000);
    summary.exitCode = await exited;
    clearTimeout(grace);
    summary.stderrTail = stderrTail.trim();

    if (signal.aborted) {
      yield { type: 'done', stopReason: 'aborted' };
      return summary;
    }
    if (!summary.sawResult && !summary.erred) {
      summary.erred = true;
      if (!suppressErrors) {
        const detail = summary.stderrTail.split('\n').slice(-3).join(' ').slice(0, 400);
        yield {
          type: 'error',
          error: { kind: 'unknown', message: adapter.exitError(detail, summary.exitCode) },
        };
      }
    }
    return summary;
  } finally {
    signal.removeEventListener('abort', onAbort);
    killTree(child.pid);
    if (child.pid !== undefined) children.delete(child.pid);
  }
}
