import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CLAUDE_CODE_ID,
  CLAUDE_CODE_STALL_MS,
  claudeCodeArgs,
  claudeCodePermissionMode,
  claudeCodeSeedModels,
  latestUserText,
  newClaudeCodeParseState,
  parseClaudeCodeLine,
  renderHistoryPrompt,
  streamLines,
  type ChatProvider,
  type ChatRequest,
  type ModelInfo,
  type ProviderEvent,
} from '@vo-coder/providers';
import type { AppConfig } from '../shared/ipc-contract';

/**
 * Claude Code as a provider — the RUNNER half.
 *
 * Spawns the user's installed `claude` CLI headless, one process per turn,
 * working directly in the chat's folder. The CLI brings everything: its own
 * login (we never touch tokens), its own tools, its own conversation state.
 * One Vo-Coder chat maps to one CLI session — Vo-Coder assigns the UUID on the
 * first turn and resumes it afterwards, so nothing is ever replayed.
 *
 * The pure half (argv, stream-json parsing, prompt rendering) lives in
 * @vo-coder/providers where it is unit-tested; this file owns what needs a
 * process: finding the binary, spawning, killing, and session bookkeeping.
 */

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

/** Every live child, so quitting the app never leaves a CLI running headless. */
const children = new Map<number, ChildProcess>();

export function closeAllCliChildren(): void {
  for (const child of children.values()) killTree(child.pid);
  children.clear();
}

/** Same idiom as workspace-tools' runner: Windows needs the whole tree gone. */
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

interface ResolvedBinary {
  path: string;
  /** 'exe' spawns directly; 'cli-js' runs under Electron-as-Node — the .cmd
   *  shim is never executed, so cmd.exe never sees user text. */
  kind: 'exe' | 'cli-js';
}

interface TurnSummary {
  sawResult: boolean;
  erred: boolean;
  exitCode: number | null;
  stderrTail: string;
}

export class ClaudeCodeCliProvider implements ChatProvider {
  readonly id = CLAUDE_CODE_ID;
  readonly stallTimeoutMs = CLAUDE_CODE_STALL_MS;

  /** Positive resolutions are cached (keyed by the override value); a failed
   *  probe is retried next turn, so installing the CLI mid-session just works. */
  private resolved: ResolvedBinary | null = null;
  private resolvedFor = '';
  /** Mission bindings live exactly as long as the app run — like mission history. */
  private missionIds = new Map<string, string>();
  /** Chats already shown the one-line manual-mode advisory. */
  private warnedManual = new Set<string>();

  constructor(private cfg: () => AppConfig) {}

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve(claudeCodeSeedModels());
  }

  /** Settings "Check": is the CLI findable, and what version answers. */
  async healthCheck(): Promise<{ ok: boolean; version?: string; path?: string; error?: string }> {
    const binary = this.resolveBinary();
    if (!binary) {
      return {
        ok: false,
        error:
          'Claude Code CLI not found. Install it (npm install -g @anthropic-ai/claude-code) ' +
          'or set its path below.',
      };
    }
    try {
      const { cmd, argv, env } = spawnForm(binary, ['--version']);
      const out = execFileSync(cmd, argv, { env, encoding: 'utf8', timeout: 5_000, windowsHide: true });
      return { ok: true, version: out.trim().split('\n')[0] ?? '', path: binary.path };
    } catch (err) {
      return {
        ok: false,
        path: binary.path,
        error: `Found it, but --version failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /** A chat- or mission-bound view: same provider, plus session continuity. */
  forSession(binding: CliSessionBinding): ChatProvider {
    return {
      id: this.id,
      stallTimeoutMs: this.stallTimeoutMs,
      listModels: () => this.listModels(),
      stream: (req, opts) => this.streamBound(binding, req, opts),
    };
  }

  /** Unbound = stateless one-shot (Telegram, helper calls): whole window in,
   *  no resume, no persistence. Nothing breaks when a binding is missing. */
  stream(req: ChatRequest, opts: { signal: AbortSignal }): AsyncIterable<ProviderEvent> {
    return this.streamBound({ key: '' }, req, opts);
  }

  private async *streamBound(
    binding: CliSessionBinding,
    req: ChatRequest,
    opts: { signal: AbortSignal },
  ): AsyncGenerator<ProviderEvent> {
    const binary = this.resolveBinary();
    if (!binary) {
      yield {
        type: 'error',
        error: {
          kind: 'unknown',
          message:
            'Claude Code CLI not found — install it (npm install -g @anthropic-ai/claude-code), ' +
            'or point Settings → Providers → Claude Code at the binary.',
        },
      };
      return;
    }

    const approval = this.cfg().approvalMode;
    const permissionMode = binding.permissionMode ?? claudeCodePermissionMode(approval);
    if (approval === 'manual' && !binding.permissionMode && !this.warnedManual.has(binding.key)) {
      this.warnedManual.add(binding.key);
      yield {
        type: 'text_delta',
        text:
          '(Claude Code runs headless: in Manual mode, actions not pre-allowed in its own ' +
          'settings are denied rather than prompted. Switch Vo-Coder to Auto for full autonomy.)\n\n',
      };
    }

    const stored = binding.key
      ? (binding.persistedId?.() ?? this.missionIds.get(binding.key))
      : undefined;
    const cwd = binding.dir ?? this.cfg().genericDir?.trim() ?? homedir();

    const persist = (id: string | null) => {
      if (!binding.key) return;
      if (binding.persist) binding.persist(id);
      else if (id) this.missionIds.set(binding.key, id);
      else this.missionIds.delete(binding.key);
    };

    if (stored) {
      const summary = yield* this.spawnTurn(
        binary,
        claudeCodeArgs({ resumeId: stored, model: req.model, permissionMode }),
        latestUserText(req.messages),
        cwd,
        opts.signal,
        persist,
        /* suppressErrors */ true,
      );
      if (summary.sawResult || opts.signal.aborted) return;
      // The CLI-side session is gone (cleaned ~/.claude, another machine's id).
      // Start over once, carrying the conversation so nothing is lost.
      persist(null);
    }

    const fresh = claudeCodeArgs({
      newSessionId: randomUUID(),
      model: req.model,
      permissionMode,
      ...(req.system ? { system: req.system } : {}),
    });
    yield* this.spawnTurn(binary, fresh, renderHistoryPrompt(req.messages), cwd, opts.signal, persist, false);
  }

  /**
   * One child process, start to finish. Yields provider events; returns what
   * happened so the caller can decide on the resume-retry. When
   * `suppressErrors` is set a failed turn ends silently (no error event, no
   * done) — the caller is about to retry and two error bubbles for one turn
   * would read as two failures.
   */
  private async *spawnTurn(
    binary: ResolvedBinary,
    args: string[],
    prompt: string,
    cwd: string,
    signal: AbortSignal,
    persist: (id: string | null) => void,
    suppressErrors: boolean,
  ): AsyncGenerator<ProviderEvent, TurnSummary> {
    const summary: TurnSummary = { sawResult: false, erred: false, exitCode: null, stderrTail: '' };
    if (signal.aborted) {
      yield { type: 'done', stopReason: 'aborted' };
      return summary;
    }

    const { cmd, argv, env } = spawnForm(binary, args);
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
          error: { kind: 'unknown', message: `Could not start Claude Code: ${messageOf(err)}` },
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

      const state = newClaudeCodeParseState();
      // A suppressed attempt (a --resume about to be retried fresh) must leave
      // NO trace unless it succeeds — otherwise the CLI's failure prose lands
      // in the transcript and the retry repeats the same complaint under it.
      // Prose is held back until the result confirms the attempt; heartbeats
      // pass through so the stall watchdog stays fed either way.
      let held: ProviderEvent[] | null = suppressErrors ? [] : null;
      for await (const line of streamLines(
        child.stdout as unknown as ReadableStream<Uint8Array>,
      )) {
        const parsed = parseClaudeCodeLine(line, state);
        // Persist the moment the CLI announces itself: a crash mid-turn must
        // not orphan a session that already exists on disk.
        if (parsed.sessionId) persist(parsed.sessionId);
        if (held && state.sawResult) {
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
      summary.sawResult = state.sawResult;

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
          const oldFlag = /unknown option/i.test(detail);
          yield {
            type: 'error',
            error: {
              kind: 'unknown',
              message: oldFlag
                ? `Claude Code is too old for this integration: ${detail}. Update it ` +
                  '(npm update -g @anthropic-ai/claude-code).'
                : `Claude Code exited (${summary.exitCode ?? 'killed'}) without a result` +
                  (detail ? `: ${detail}` : '.'),
            },
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

  private resolveBinary(): ResolvedBinary | null {
    const override = this.cfg().claudeCliPath?.trim() ?? '';
    if (this.resolved && this.resolvedFor === override) return this.resolved;
    const found = probeBinary(override);
    if (found) {
      this.resolved = found;
      this.resolvedFor = override;
    }
    return found;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The npm shims' real payload — the shims themselves must never be executed
 * (.cmd would drag in cmd.exe; the extensionless one is a bash script).
 * Layout depends on the package generation: current ships a native
 * bin/claude.exe inside the package; older ones a cli.js at its root.
 */
function npmClaudeBinary(npmDir: string): ResolvedBinary | null {
  const pkg = join(npmDir, 'node_modules', '@anthropic-ai', 'claude-code');
  const native = join(pkg, 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  if (existsSync(native)) return { path: native, kind: 'exe' };
  const cliJs = join(pkg, 'cli.js');
  return existsSync(cliJs) ? { path: cliJs, kind: 'cli-js' } : null;
}

function classify(path: string): ResolvedBinary | null {
  if (!existsSync(path)) return null;
  // Any npm shim form (claude.cmd, claude.ps1, the extensionless bash one on
  // Windows) resolves to the real binary sitting in the same prefix.
  if (/\.(cmd|bat|ps1)$/i.test(path)) return npmClaudeBinary(dirname(path));
  if (process.platform === 'win32' && !/\.[a-z0-9]+$/i.test(path)) {
    return npmClaudeBinary(dirname(path));
  }
  if (/\.[cm]?js$/i.test(path)) return { path, kind: 'cli-js' };
  return { path, kind: 'exe' };
}

function probeBinary(override: string): ResolvedBinary | null {
  if (override) return classify(override);

  const home = homedir();
  if (process.platform === 'win32') {
    const local = classify(join(home, '.local', 'bin', 'claude.exe'));
    if (local) return local;
    const npm = npmClaudeBinary(
      join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm'),
    );
    if (npm) return npm;
  } else {
    for (const candidate of [
      join(home, '.local', 'bin', 'claude'),
      join(home, '.claude', 'local', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    ]) {
      const hit = classify(candidate);
      if (hit) return hit;
    }
  }

  // Last resort: ask the OS. Packaged apps carry a minimal PATH, which is why
  // the fixed probes come first.
  try {
    const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
    const out = execFileSync(cmd, ['claude'], { encoding: 'utf8', timeout: 3_000, windowsHide: true });
    for (const line of out.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const hit = classify(line);
      if (hit) return hit;
    }
  } catch {
    /* not on PATH either */
  }
  return null;
}

/** How to actually invoke the resolved binary. cli.js runs on the bundled
 *  Electron-as-Node runtime, so a packaged app needs no system Node at all. */
function spawnForm(
  binary: ResolvedBinary,
  args: string[],
): { cmd: string; argv: string[]; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // A Vo-Coder started FROM a Claude Code terminal inherits that session's
  // harness markers, and the child then believes it has a host: with
  // CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH=1 in the env it waits for a host that
  // does not exist and reports "OAuth session expired and could not be
  // refreshed" despite a perfectly valid login. Seen live, first harness run.
  // ANTHROPIC_BASE_URL from such a session points at the host's relay — also
  // gone. A deliberate base URL belongs in the CLI's own settings.json.
  for (const key of Object.keys(env)) {
    if (/^CLAUDE/i.test(key)) delete env[key];
  }
  delete env.ANTHROPIC_BASE_URL;
  if (binary.kind === 'cli-js') {
    env.ELECTRON_RUN_AS_NODE = '1';
    return { cmd: process.execPath, argv: [binary.path, ...args], env };
  }
  delete env.ELECTRON_RUN_AS_NODE;
  return { cmd: binary.path, argv: args, env };
}
