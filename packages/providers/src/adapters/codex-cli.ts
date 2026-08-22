import type { ModelInfo, ProviderEvent } from '../types.js';

/**
 * Codex CLI as a provider — the PURE half.
 *
 * The user's installed `codex` CLI is a complete coding agent of OpenAI's own
 * making: it holds the conversation (a "thread"), runs its own tools, and edits
 * files in the working folder. Vo-Coder spawns it headless (`codex exec
 * --json`) once per turn and narrates the JSONL that comes back.
 *
 * WHY THIS SHAPE AND NOT AN OAUTH FLOW: a ChatGPT plan has no sanctioned
 * bring-your-own-plan program for third-party apps, and reusing Codex's own
 * client id would be the pattern that gets apps cut off. Here OpenAI's client
 * does its own login — `codex login` — and keeps its own tokens in
 * ~/.codex/auth.json. Vo-Coder never reads, writes, or transports a credential;
 * it starts a program the user already installed. That is the whole reason this
 * provider ships in every edition: there is no credential to hand around.
 *
 * THE ONE INVARIANT (shared with claude-code): never emit a `tool_call` event.
 * The harness executes those — but the CLI already ran its tools inside the
 * child, and a tool_call that ends `end_turn` lands in history as a call with
 * no result, corrupting every later request. Tool activity surfaces as
 * `tool_progress` heartbeats (they reset the stall watchdog) and short
 * work-log text lines.
 */

export const CODEX_CLI_ID = 'codex-cli';

/** A CLI turn can be legitimately silent while a build runs inside the child —
 *  same budget claude-code and the local-model providers claim. */
export const CODEX_CLI_STALL_MS = 600_000;

/** 'default' means "let the CLI use its own configured model" — no --model flag. */
export const CODEX_CLI_DEFAULT_MODEL = 'default';

/**
 * The slugs the CLI's own model catalogue offers a ChatGPT plan (read off
 * codex 0.130's refresh response). The FALLBACK ONLY: the live list comes
 * from the CLI's own models cache (see codexModelsFromCache) whenever that
 * file is readable. Deliberately short: a stale id here becomes a failed
 * turn, and `default` always works because the CLI resolves it.
 */
export function codexCliSeedModels(): ModelInfo[] {
  const entry = (id: string, displayName: string): ModelInfo => ({
    id,
    provider: CODEX_CLI_ID,
    displayName,
    supportsTools: true,
  });
  return [
    entry(CODEX_CLI_DEFAULT_MODEL, 'Codex (its own default)'),
    entry('gpt-5.5', 'Codex — GPT-5.5'),
    entry('gpt-5.4-mini', 'Codex — GPT-5.4 mini'),
  ];
}

/**
 * The CLI's own model catalogue, from ~/.codex/models_cache.json — written by
 * codex itself on every refresh, so it names exactly what the user's plan and
 * CLI version can run (there is no `codex models` command to ask). Hidden
 * entries (visibility ≠ "list": internal review models, reserves) stay out of
 * the picker. Returns null when the JSON is not that file's shape — the
 * caller then falls back to the static seeds.
 */
export function codexModelsFromCache(json: string): ModelInfo[] | null {
  let parsed: {
    models?: Array<{
      slug?: string;
      display_name?: string;
      visibility?: string;
      context_window?: number;
      input_modalities?: string[];
    }>;
  };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed?.models)) return null;
  const out: ModelInfo[] = [
    {
      id: CODEX_CLI_DEFAULT_MODEL,
      provider: CODEX_CLI_ID,
      displayName: 'Codex (its own default)',
      supportsTools: true,
    },
  ];
  for (const m of parsed.models) {
    if (!m?.slug || m.visibility !== 'list') continue;
    out.push({
      id: m.slug,
      provider: CODEX_CLI_ID,
      displayName: `Codex — ${m.display_name ?? m.slug}`,
      supportsTools: true,
      ...(m.context_window ? { contextLength: m.context_window } : {}),
      ...(m.input_modalities?.includes('image') ? { supportsVision: true } : {}),
    });
  }
  // A cache with no listable models is no catalogue at all.
  return out.length > 1 ? out : null;
}

/**
 * Vo-Coder approval mode → what the child is allowed to do.
 *
 * auto → bypass: Vo-Coder's Auto already means "agents act, no prompts", and a
 * headless child cannot be asked anything. This is the same call claude-code
 * makes with bypassPermissions.
 * plan / manual → read-only: the honest analog of "approve everything" when
 * nobody can be asked. The agent reads and reasons; nothing is written.
 */
export function codexCliSandbox(approvalMode: 'auto' | 'plan' | 'manual'): 'bypass' | 'read-only' {
  return approvalMode === 'auto' ? 'bypass' : 'read-only';
}

export interface CodexCliTurn {
  /** Continue the CLI-side thread with this id. Fresh turns omit it — unlike
   *  claude-code, Codex assigns the id itself and announces it in the first
   *  event, so there is nothing to pass in. */
  resumeId?: string;
  model: string;
  sandbox: 'bypass' | 'read-only';
}

/** argv AFTER the binary. The prompt goes via STDIN (the `-` argument), never
 *  argv — Windows has a 32k command-line ceiling and a prompt is user prose. */
export function codexCliArgs(turn: CodexCliTurn): string[] {
  const args = turn.resumeId ? ['exec', 'resume', turn.resumeId] : ['exec'];
  args.push('--json', '--skip-git-repo-check');
  if (turn.sandbox === 'bypass') args.push('--dangerously-bypass-approvals-and-sandbox');
  else args.push('--sandbox', 'read-only');
  if (turn.model && turn.model !== CODEX_CLI_DEFAULT_MODEL) args.push('--model', turn.model);
  args.push('-');
  return args;
}

// ---- JSONL parsing ----

export interface CodexCliParseState {
  /**
   * Chars already emitted per item id. Codex may report an item as `started`,
   * repeatedly `updated`, then `completed`, each carrying the text SO FAR —
   * emitting only the suffix keeps a streamed message and a whole-at-once
   * message from ever double-printing.
   */
  emitted: Map<string, number>;
  /** A turn.completed arrived — the analog of claude-code's sawResult. */
  sawResult: boolean;
  /** Last error prose emitted — Codex reports one failure twice (`error`,
   *  then `turn.failed` with the same message), and one bubble is enough. */
  lastError?: string;
  threadId?: string;
}

export function newCodexCliParseState(): CodexCliParseState {
  return { emitted: new Map(), sawResult: false };
}

export interface CodexCliParsed {
  events: ProviderEvent[];
  /** Announced by thread.started — the runner persists it for `exec resume`. */
  threadId?: string;
}

const HEARTBEAT: ProviderEvent = { type: 'tool_progress', chars: 0 };

interface AnyItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  status?: string;
  exit_code?: number;
  aggregated_output?: string;
  path?: string;
  server?: string;
  tool?: string;
  query?: string;
}

interface AnyLine {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string };
  item?: AnyItem;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
}

function clip(text: string, max: number): string {
  const one = text.trim().split('\n')[0] ?? '';
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** The unseen tail of an item's text, so repeated snapshots print once. */
function suffix(state: CodexCliParseState, item: AnyItem, text: string): string {
  const key = item.id ?? item.type ?? 'item';
  const already = state.emitted.get(key) ?? 0;
  if (text.length <= already) return '';
  state.emitted.set(key, text.length);
  return text.slice(already);
}

/** What the CLI is doing, as one work-log line. Mirrors claude-code's "· name — arg". */
function workLog(item: AnyItem): string {
  switch (item.type) {
    case 'command_execution':
      return item.command ? `\n· shell — ${clip(item.command, 90)}\n` : '';
    case 'file_change':
      return item.path ? `\n· edit — ${clip(item.path, 90)}\n` : '\n· edit\n';
    case 'mcp_tool_call':
      return `\n· ${item.server ?? 'mcp'}.${item.tool ?? 'tool'}\n`;
    case 'web_search':
      return item.query ? `\n· web search — ${clip(item.query, 90)}\n` : '\n· web search\n';
    default:
      return '';
  }
}

/** Codex nests the raw API error JSON inside its message field — a chat
 *  bubble reading `{"type":"error","status":400,…}` is how the first real
 *  failure looked. Unwrap to the human sentence when one is in there. */
function humanDetail(raw: string): string {
  try {
    const j = JSON.parse(raw) as { error?: { message?: string }; message?: string };
    const inner = j.error?.message ?? j.message;
    if (inner) return inner;
  } catch {
    /* already prose */
  }
  return raw;
}

/** Codex's own words for "you are not signed in", including the one a revoked
 *  refresh token produces — the most likely first failure on any machine. */
function isAuthProblem(text: string): boolean {
  return /revoked|sign in|log ?in|logged out|unauthorized|401|authentication|credential|expired/i.test(
    text,
  );
}

function errorEvent(detail: string): ProviderEvent {
  const auth = isAuthProblem(detail);
  // An outdated CLI rejects the server's current default model with a 400
  // every single turn — an agent on "its own default" then looks simply
  // silent (seen live: a group member parked with no output). Name the fix.
  const outdated = /newer version of codex|upgrade to the latest/i.test(detail);
  return {
    type: 'error',
    error: {
      kind: auth ? 'auth' : 'unknown',
      message: auth
        ? `Codex is not signed in: ${detail} Run \`codex login\` in a terminal to sign in with your ChatGPT plan.`
        : outdated
          ? `Codex is outdated: ${detail} Run \`codex update\` in a terminal, or pin this agent to a named model (e.g. gpt-5.5).`
          : `Codex: ${detail}`,
    },
  };
}

/**
 * One JSONL line → provider events. Tolerant by design: an unknown or
 * malformed line is a heartbeat, never an abort — the CLI is free to add event
 * types and to print debug noise (its model-cache warnings do exactly that)
 * without breaking every Vo-Coder turn.
 */
export function parseCodexCliLine(line: string, state: CodexCliParseState): CodexCliParsed {
  let parsed: AnyLine;
  try {
    parsed = JSON.parse(line) as AnyLine;
  } catch {
    return { events: [HEARTBEAT] };
  }
  if (!parsed || typeof parsed !== 'object') return { events: [HEARTBEAT] };

  const out: CodexCliParsed = { events: [] };

  switch (parsed.type) {
    case 'thread.started': {
      if (parsed.thread_id && !state.threadId) {
        state.threadId = parsed.thread_id;
        out.threadId = parsed.thread_id;
      }
      out.events.push(HEARTBEAT);
      return out;
    }

    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const item = parsed.item ?? {};
      if (item.type === 'agent_message') {
        const text = suffix(state, item, typeof item.text === 'string' ? item.text : '');
        if (text) out.events.push({ type: 'text_delta', text });
      } else if (item.type === 'reasoning') {
        const text = suffix(state, item, typeof item.text === 'string' ? item.text : '');
        if (text) out.events.push({ type: 'thinking_delta', text });
      } else if (parsed.type === 'item.started') {
        const log = workLog(item);
        if (log) out.events.push({ type: 'text_delta', text: log });
        out.events.push({ type: 'tool_progress', name: item.type ?? 'tool', chars: 0 });
      } else if (parsed.type === 'item.completed' && item.type === 'command_execution' && item.exit_code) {
        // A failure is worth a visible line: the CLI will route around it and
        // the user deserves to see what it hit. Successes stay heartbeats.
        const detail = clip(item.aggregated_output ?? '', 160);
        out.events.push({
          type: 'text_delta',
          text: `  ✗ exit ${item.exit_code}${detail ? ` — ${detail}` : ''}\n`,
        });
      }
      if (!out.events.length) out.events.push(HEARTBEAT);
      return out;
    }

    case 'turn.completed': {
      state.sawResult = true;
      const u = parsed.usage ?? {};
      out.events.push({
        type: 'usage',
        inputTokens: u.input_tokens ?? 0,
        outputTokens: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0),
        ...(u.cached_input_tokens ? { cacheReadTokens: u.cached_input_tokens } : {}),
      });
      out.events.push({ type: 'done', stopReason: 'end_turn' });
      return out;
    }

    case 'turn.failed':
    case 'error': {
      // Deliberately NOT sawResult: a failed resume must fall through to the
      // fresh-thread retry, exactly as claude-code does with a dead --resume.
      const detail =
        clip(humanDetail(parsed.error?.message ?? parsed.message ?? ''), 300) ||
        'the CLI reported an error';
      if (detail !== state.lastError) {
        state.lastError = detail;
        out.events.push(errorEvent(detail));
      } else {
        out.events.push(HEARTBEAT);
      }
      return out;
    }

    default:
      out.events.push(HEARTBEAT);
      return out;
  }
}

// ---- prompt building ----

/**
 * Codex has no `--append-system-prompt`: a persona reaches the agent only as
 * prose in the first prompt of a thread (later turns carry it in the thread's
 * own history). Kept separate from the history rendering that claude-code
 * already provides, so the runner applies it to fresh threads only.
 */
export function codexCliPrompt(system: string | undefined, body: string): string {
  const persona = system?.trim();
  return persona ? `${persona}\n\n---\n\n${body}` : body;
}
