import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CODEX_CLI_ID,
  CODEX_CLI_STALL_MS,
  codexCliArgs,
  codexCliPrompt,
  codexCliSandbox,
  codexCliSeedModels,
  latestUserText,
  newCodexCliParseState,
  parseCodexCliLine,
  renderHistoryPrompt,
  type ChatProvider,
  type ChatRequest,
  type CodexCliParseState,
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

/**
 * Codex CLI as a provider — the RUNNER half. The ChatGPT-plan counterpart of
 * claude-code-provider: spawns the user's installed `codex` headless
 * (`codex exec --json`), one process per turn, in the chat's folder. The CLI
 * brings its own login (`codex login` — we never touch ~/.codex/auth.json),
 * its own tools, its own thread state. One Vo-Coder chat maps to one Codex
 * thread; unlike claude, Codex assigns the thread id itself, so the first
 * turn reads it off the stream and later turns `exec resume` it.
 *
 * The pure half (argv, JSONL parsing) lives in @vo-coder/providers; the
 * generic process half in cli-agent-runner. This file owns what is Codex's
 * alone: finding the binary, the env scrub, and the error prose.
 */

/** The stream dialect handed to the shared runner. */
const ADAPTER: CliParseAdapter<CodexCliParseState> = {
  newState: newCodexCliParseState,
  parse: (line, state) => {
    const parsed = parseCodexCliLine(line, state);
    return { events: parsed.events, ...(parsed.threadId ? { sessionId: parsed.threadId } : {}) };
  },
  sawResult: (s) => s.sawResult,
  exitError: (detail, exitCode) =>
    /unexpected argument|unknown option|unrecognized/i.test(detail)
      ? `Codex is too old for this integration: ${detail}. Update it (codex update).`
      : `Codex exited (${exitCode ?? 'killed'}) without a result` +
        (detail ? `: ${detail}` : '.') +
        (/revoked|sign in|log ?in|401|unauthorized|expired/i.test(detail)
          ? ' Run `codex login` in a terminal to sign in with your ChatGPT plan.'
          : ''),
};

/**
 * A Vo-Coder started FROM a `codex exec` session inherits that sandbox's
 * markers (CODEX_SANDBOX, CODEX_SANDBOX_NETWORK_DISABLED, …) and the child
 * would believe it is nested inside a sandbox with the network off — same
 * trap claude-code hit with its harness markers, pre-empted here. A stray
 * OPENAI_BASE_URL would silently re-point the CLI at a relay that is not
 * there; a deliberate override belongs in ~/.codex/config.toml.
 */
function scrubEnv(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (/^CODEX/i.test(key)) delete env[key];
  }
  delete env.OPENAI_BASE_URL;
}

interface TurnSummary {
  sawResult: boolean;
  erred: boolean;
}

export class CodexCliProvider implements ChatProvider {
  readonly id = CODEX_CLI_ID;
  readonly stallTimeoutMs = CODEX_CLI_STALL_MS;

  /** Positive resolutions are cached (keyed by the override value); a failed
   *  probe is retried next turn, so installing the CLI mid-session just works. */
  private resolved: ResolvedBinary | null = null;
  private resolvedFor = '';
  /** Mission bindings live exactly as long as the app run — like mission history. */
  private missionIds = new Map<string, string>();
  /** Chats already shown the one-line read-only advisory. */
  private warnedManual = new Set<string>();

  constructor(private cfg: () => AppConfig) {}

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve(codexCliSeedModels());
  }

  /** Settings "Check": is the CLI findable, and what version answers. */
  async healthCheck(): Promise<{ ok: boolean; version?: string; path?: string; error?: string }> {
    const binary = this.resolveBinary();
    if (!binary) {
      return {
        ok: false,
        error:
          'Codex CLI not found. Install it (npm install -g @openai/codex, or the Codex app) ' +
          'and sign in with `codex login`, or set its path below.',
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

  /** A chat- or mission-bound view: same provider, plus thread continuity. */
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
            'Codex CLI not found — install it (npm install -g @openai/codex, or the Codex app), ' +
            'sign in with `codex login`, or point Settings → Providers → Codex at the binary.',
        },
      };
      return;
    }

    const approval = this.cfg().approvalMode;
    // Missions force claude-vocabulary 'bypassPermissions'; for Codex that
    // means the sandbox comes off. Anything else derives from approval mode.
    const sandbox =
      binding.permissionMode === 'bypassPermissions' ? 'bypass' : codexCliSandbox(approval);
    if (approval === 'manual' && sandbox === 'read-only' && !this.warnedManual.has(binding.key)) {
      this.warnedManual.add(binding.key);
      yield {
        type: 'text_delta',
        text:
          '(Codex runs headless: in Manual mode it works read-only — nobody can approve its ' +
          'actions. Switch Vo-Coder to Auto to let it edit files and run commands.)\n\n',
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
        codexCliArgs({ resumeId: stored, model: req.model, sandbox }),
        latestUserText(req.messages),
        cwd,
        opts.signal,
        persist,
        /* suppressErrors */ true,
      );
      if (summary.sawResult || opts.signal.aborted) return;
      // The CLI-side thread is gone (cleaned ~/.codex, another machine's id,
      // or an id from a different CLI agent this chat ran on before). Start
      // over once, carrying the conversation so nothing is lost.
      persist(null);
    }

    // Fresh thread: Codex has no --append-system-prompt, so the persona rides
    // the first prompt; the thread id arrives on the stream and is persisted
    // by the runner the moment it is announced.
    yield* this.spawnTurn(
      binary,
      codexCliArgs({ model: req.model, sandbox }),
      codexCliPrompt(req.system, renderHistoryPrompt(req.messages)),
      cwd,
      opts.signal,
      persist,
      false,
    );
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
      startError: (detail) => `Could not start Codex: ${detail}`,
    });
  }

  private resolveBinary(): ResolvedBinary | null {
    const override = this.cfg().codexCliPath?.trim() ?? '';
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
 * @openai/codex ships the native binary in a platform sub-package
 * (node_modules/@openai/codex-<platform>-<arch>/vendor/<triple>/bin/codex),
 * plus a bin/codex.js launcher; the native one is preferred, the launcher is
 * a plain Node script that runs fine on Electron-as-Node.
 */
function npmCodexBinary(npmDir: string): ResolvedBinary | null {
  const pkg = join(npmDir, 'node_modules', '@openai', 'codex');
  const vendor = join(
    pkg,
    'node_modules',
    '@openai',
    `codex-${process.platform}-${process.arch}`,
    'vendor',
  );
  if (existsSync(vendor)) {
    try {
      for (const triple of readdirSync(vendor)) {
        const native = join(
          vendor,
          triple,
          'bin',
          process.platform === 'win32' ? 'codex.exe' : 'codex',
        );
        if (existsSync(native)) return { path: native, kind: 'exe' };
      }
    } catch {
      /* unreadable vendor dir — fall through to the launcher */
    }
  }
  const launcher = join(pkg, 'bin', 'codex.js');
  return existsSync(launcher) ? { path: launcher, kind: 'cli-js' } : null;
}

function classify(path: string): ResolvedBinary | null {
  if (!existsSync(path)) return null;
  if (/\.(cmd|bat|ps1)$/i.test(path)) return npmCodexBinary(dirname(path));
  if (process.platform === 'win32' && !/\.[a-z0-9]+$/i.test(path)) {
    return npmCodexBinary(dirname(path));
  }
  if (/\.[cm]?js$/i.test(path)) return { path, kind: 'cli-js' };
  return { path, kind: 'exe' };
}

function probeBinary(override: string): ResolvedBinary | null {
  if (override) return classify(override);

  const home = homedir();
  if (process.platform === 'win32') {
    // npm first: it is the install the user refreshes (`npm install -g
    // @openai/codex`), while the app-managed copy under OpenAI\Codex can be a
    // stale orphan whose own `codex update` cannot even tell how it was
    // installed — seen live, a 19-versions-old alpha outranking a fresh npm.
    const npm = npmCodexBinary(
      join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm'),
    );
    if (npm) return npm;
    const local = classify(join(home, '.local', 'bin', 'codex.exe'));
    if (local) return local;
    // The Codex desktop/installer build — where `codex app` puts it.
    const installer = join(
      process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'),
      'OpenAI',
      'Codex',
      'bin',
      'codex.exe',
    );
    const hit = classify(installer);
    if (hit) return hit;
  } else {
    const npm = npmCodexBinary('/usr/local/lib');
    if (npm) return npm;
    for (const candidate of [
      join(home, '.local', 'bin', 'codex'),
      '/usr/local/bin/codex',
      '/opt/homebrew/bin/codex',
    ]) {
      const hit = classify(candidate);
      if (hit) return hit;
    }
  }

  // Last resort: ask the OS. Packaged apps carry a minimal PATH, which is why
  // the fixed probes come first.
  try {
    const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
    const out = execFileSync(cmd, ['codex'], { encoding: 'utf8', timeout: 3_000, windowsHide: true });
    for (const line of out.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const hit = classify(line);
      if (hit) return hit;
    }
  } catch {
    /* not on PATH either */
  }
  return null;
}
