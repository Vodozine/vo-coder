import { execFileSync } from 'node:child_process';
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
  type ChatProvider,
  type ChatRequest,
  type ClaudeCodeParseState,
  type ModelInfo,
  type ProviderEvent,
} from '@vo-coder/providers';
import type { AppConfig } from '../shared/ipc-contract';
import {
  runCliTurn,
  spawnForm,
  type CliParseAdapter,
  type CliSessionBinding,
  type ResolvedBinary,
} from './cli-agent-runner';

// The process machinery (child registry, kill, spawn form) is shared with the
// Codex provider; existing import sites keep working through these re-exports.
export { closeAllCliChildren } from './cli-agent-runner';
export type { CliSessionBinding } from './cli-agent-runner';

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
 * @vo-coder/providers where it is unit-tested; the generic process half
 * (spawn, kill, held-events, child registry) in cli-agent-runner. This file
 * owns what is Claude Code's alone: finding the binary, the env scrub, the
 * session bookkeeping, and the error prose.
 */

/** The stream dialect handed to the shared runner. */
const ADAPTER: CliParseAdapter<ClaudeCodeParseState> = {
  newState: newClaudeCodeParseState,
  parse: parseClaudeCodeLine,
  sawResult: (s) => s.sawResult,
  exitError: (detail, exitCode) =>
    /unknown option/i.test(detail)
      ? `Claude Code is too old for this integration: ${detail}. Update it ` +
        '(npm update -g @anthropic-ai/claude-code).'
      : `Claude Code exited (${exitCode ?? 'killed'}) without a result` +
        (detail ? `: ${detail}` : '.'),
};

/**
 * A Vo-Coder started FROM a Claude Code terminal inherits that session's
 * harness markers, and the child then believes it has a host: with
 * CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH=1 in the env it waits for a host that
 * does not exist and reports "OAuth session expired and could not be
 * refreshed" despite a perfectly valid login. Seen live, first harness run.
 * ANTHROPIC_BASE_URL from such a session points at the host's relay — also
 * gone. A deliberate base URL belongs in the CLI's own settings.json.
 */
function scrubEnv(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (/^CLAUDE/i.test(key)) delete env[key];
  }
  delete env.ANTHROPIC_BASE_URL;
}

interface TurnSummary {
  sawResult: boolean;
  erred: boolean;
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
      const { cmd, argv, env } = spawnForm(binary, ['--version'], scrubEnv);
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

  private spawnTurn(
    binary: ResolvedBinary,
    args: string[],
    prompt: string,
    cwd: string,
    signal: AbortSignal,
    persist: (id: string | null) => void,
    suppressErrors: boolean,
  ): AsyncGenerator<ProviderEvent, TurnSummary> {
    return runCliTurn({
      binary,
      args,
      prompt,
      cwd,
      signal,
      persist,
      suppressErrors,
      adapter: ADAPTER,
      scrubEnv,
      startError: (detail) => `Could not start Claude Code: ${detail}`,
    });
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
