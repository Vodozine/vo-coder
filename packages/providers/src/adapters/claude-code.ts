import type { HarnessMessage, ModelInfo, ProviderEvent } from '../types.js';

/**
 * Claude Code as a provider — the PURE half.
 *
 * The user's installed `claude` CLI is itself a complete coding agent: it holds
 * the conversation, runs its own tools, and edits files in the working folder.
 * Vo-Coder does not reimplement any of that; it spawns the CLI headless
 * (`-p --output-format stream-json`) once per turn and narrates what comes back.
 * This module is everything about that dialogue that needs no process: argv
 * building, the stream-json → ProviderEvent mapping, history rendering, and the
 * seed model list. The spawn/kill half lives in the desktop main process.
 *
 * THE ONE INVARIANT: never emit a `tool_call` event. The harness executes
 * those — but the CLI already ran its tools inside the child, and a tool_call
 * that ends `end_turn` lands in history as a call with no result, corrupting
 * every later request. Tool activity surfaces as `tool_progress` heartbeats
 * (they reset the stall watchdog) and short work-log text lines.
 */

export const CLAUDE_CODE_ID = 'claude-code';

/** A CLI turn can be legitimately silent while a build runs inside the child —
 *  same budget the local-model providers claim. */
export const CLAUDE_CODE_STALL_MS = 600_000;

/** 'default' means "let the CLI use its own configured model" — no --model flag. */
export const CLAUDE_CODE_DEFAULT_MODEL = 'default';

export function claudeCodeSeedModels(): ModelInfo[] {
  const entry = (id: string, displayName: string): ModelInfo => ({
    id,
    provider: CLAUDE_CODE_ID,
    displayName,
    supportsTools: true,
  });
  return [
    entry(CLAUDE_CODE_DEFAULT_MODEL, 'Claude Code (its own default)'),
    entry('fable', 'Claude Code — Fable'),
    entry('opus', 'Claude Code — Opus'),
    entry('sonnet', 'Claude Code — Sonnet'),
    entry('haiku', 'Claude Code — Haiku'),
  ];
}

/**
 * Vo-Coder approval mode → the CLI's --permission-mode.
 *
 * auto → bypassPermissions: Vo-Coder's Auto already means "agents act, no
 * prompts" (ws_run runs unprompted there), and headless cannot prompt anyway.
 * plan → plan: same meaning on both sides.
 * manual → dontAsk: the honest analog of "approve everything" when nobody can
 * be asked — anything not pre-allowed in Claude Code's OWN settings is denied
 * rather than silently approved.
 */
export function claudeCodePermissionMode(approvalMode: 'auto' | 'plan' | 'manual'): string {
  return approvalMode === 'plan' ? 'plan' : approvalMode === 'manual' ? 'dontAsk' : 'bypassPermissions';
}

export interface ClaudeCodeTurn {
  /** Fresh session: the UUID Vo-Coder assigns (exclusive with resumeId). */
  newSessionId?: string;
  /** Continue the CLI-side conversation with this id. */
  resumeId?: string;
  model: string;
  /** Persona — first (session-creating) turn only; resumed turns carry it already. */
  system?: string;
  permissionMode: string;
}

/** argv AFTER the binary. The prompt goes via STDIN, never argv — Windows has a
 *  32k command-line ceiling and a prompt is user prose. */
export function claudeCodeArgs(turn: ClaudeCodeTurn): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    turn.permissionMode,
  ];
  if (turn.resumeId) args.push('--resume', turn.resumeId);
  else if (turn.newSessionId) args.push('--session-id', turn.newSessionId);
  if (turn.model && turn.model !== CLAUDE_CODE_DEFAULT_MODEL) args.push('--model', turn.model);
  if (!turn.resumeId && turn.system?.trim()) args.push('--append-system-prompt', turn.system);
  return args;
}

// ---- stream-json parsing ----

export interface ClaudeCodeParseState {
  /** Name of the tool whose input is currently streaming, for the progress line. */
  toolName?: string;
  toolChars: number;
  /** Chars of prose already emitted via partial deltas since the last assistant
   *  message — the dedupe signal (assistant events repeat the same text whole). */
  deltaChars: number;
  sawResult: boolean;
  sessionId?: string;
}

export function newClaudeCodeParseState(): ClaudeCodeParseState {
  return { toolChars: 0, deltaChars: 0, sawResult: false };
}

export interface ClaudeCodeParsed {
  events: ProviderEvent[];
  /** Announced by the CLI's init line — the runner persists it for --resume. */
  sessionId?: string;
}

const HEARTBEAT: ProviderEvent = { type: 'tool_progress', chars: 0 };

interface AnyLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  event?: {
    type?: string;
    content_block?: { type?: string; name?: string };
    delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
  };
  message?: { content?: unknown };
}

/** One salient argument, so the work log reads "what" not "JSON". */
function toolArgSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const a = input as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'description', 'prompt']) {
    const v = a[key];
    if (typeof v === 'string' && v.trim()) {
      const one = v.trim().split('\n')[0]!;
      return one.length > 90 ? `${one.slice(0, 90)}…` : one;
    }
  }
  return '';
}

function firstLine(v: unknown): string {
  const text =
    typeof v === 'string'
      ? v
      : Array.isArray(v)
        ? v
            .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : ''))
            .join(' ')
        : '';
  const one = text.trim().split('\n')[0] ?? '';
  return one.length > 160 ? `${one.slice(0, 160)}…` : one;
}

/**
 * One NDJSON line → provider events. Tolerant by design: an unknown or
 * malformed line is a heartbeat, never an abort — the CLI is free to add event
 * types and to print debug noise without breaking every Vo-Coder turn.
 */
export function parseClaudeCodeLine(line: string, state: ClaudeCodeParseState): ClaudeCodeParsed {
  let parsed: AnyLine;
  try {
    parsed = JSON.parse(line) as AnyLine;
  } catch {
    return { events: [HEARTBEAT] };
  }
  if (!parsed || typeof parsed !== 'object') return { events: [HEARTBEAT] };

  const out: ClaudeCodeParsed = { events: [] };
  if (parsed.session_id && !state.sessionId) {
    state.sessionId = parsed.session_id;
    out.sessionId = parsed.session_id;
  }

  switch (parsed.type) {
    case 'system':
      out.events.push(HEARTBEAT);
      return out;

    case 'stream_event': {
      const ev = parsed.event ?? {};
      if (ev.type === 'content_block_start') {
        const block = ev.content_block ?? {};
        if (block.type === 'tool_use') {
          state.toolName = block.name ?? 'tool';
          state.toolChars = 0;
          out.events.push({ type: 'tool_progress', name: state.toolName, chars: 0 });
          return out;
        }
        out.events.push(HEARTBEAT);
        return out;
      }
      if (ev.type === 'content_block_delta') {
        const delta = ev.delta ?? {};
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          state.deltaChars += delta.text.length;
          out.events.push({ type: 'text_delta', text: delta.text });
          return out;
        }
        if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          out.events.push({ type: 'thinking_delta', text: delta.thinking });
          return out;
        }
        if (delta.type === 'input_json_delta') {
          state.toolChars += delta.partial_json?.length ?? 0;
          out.events.push({ type: 'tool_progress', name: state.toolName, chars: state.toolChars });
          return out;
        }
      }
      out.events.push(HEARTBEAT);
      return out;
    }

    case 'assistant': {
      const content = Array.isArray(parsed.message?.content) ? (parsed.message!.content as unknown[]) : [];
      for (const raw of content) {
        const block = (raw ?? {}) as { type?: string; text?: string; name?: string; input?: unknown };
        if (block.type === 'text' && typeof block.text === 'string') {
          // Already streamed as partial deltas — repeating the whole message
          // would double every paragraph. Only when NO deltas arrived (older
          // CLI, flag ignored) is this the one copy of the prose.
          if (state.deltaChars === 0 && block.text) {
            out.events.push({ type: 'text_delta', text: block.text });
          }
        } else if (block.type === 'tool_use') {
          const summary = toolArgSummary(block.input);
          const name = block.name ?? 'tool';
          out.events.push({
            type: 'text_delta',
            text: `\n· ${name}${summary ? ` — ${summary}` : ''}\n`,
          });
        }
      }
      state.deltaChars = 0;
      if (!out.events.length) out.events.push(HEARTBEAT);
      return out;
    }

    case 'user': {
      // Tool results flowing back inside the CLI. Successes are heartbeats;
      // a failure is worth a visible line, because the CLI will route around
      // it and the user deserves to see what it hit.
      const content = Array.isArray(parsed.message?.content) ? (parsed.message!.content as unknown[]) : [];
      for (const raw of content) {
        const block = (raw ?? {}) as { type?: string; is_error?: boolean; content?: unknown };
        if (block.type === 'tool_result' && block.is_error) {
          const line1 = firstLine(block.content);
          if (line1) out.events.push({ type: 'text_delta', text: `  ✗ ${line1}\n` });
        }
      }
      if (!out.events.length) out.events.push(HEARTBEAT);
      return out;
    }

    case 'result': {
      if (parsed.is_error || (parsed.subtype && parsed.subtype !== 'success')) {
        // Deliberately NOT sawResult: a failed resume must fall through to the
        // fresh-session retry, and "exited without a result" stays covered by
        // the error event itself.
        const detail = firstLine(parsed.result) || parsed.subtype || 'the CLI reported an error';
        const auth = /log ?in|logged out|authentication|unauthorized|api key|oauth|credential/i.test(
          String(parsed.result ?? '') + String(parsed.subtype ?? ''),
        );
        out.events.push({
          type: 'error',
          error: {
            kind: auth ? 'auth' : 'unknown',
            message: auth
              ? `Claude Code is not signed in: ${detail}. Run \`claude\` once in a terminal to sign in.`
              : `Claude Code: ${detail}`,
          },
        });
        return out;
      }
      state.sawResult = true;
      const u = parsed.usage ?? {};
      out.events.push({
        type: 'usage',
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        ...(u.cache_read_input_tokens ? { cacheReadTokens: u.cache_read_input_tokens } : {}),
      });
      out.events.push({ type: 'done', stopReason: 'end_turn' });
      return out;
    }

    default:
      out.events.push(HEARTBEAT);
      return out;
  }
}

// ---- prompt building ----

const ATTACHMENT_STUB = '[attachment omitted — not visible to CLI agents]';

function userText(content: Array<{ type: string }>): string {
  return content
    .map((p) => (p.type === 'text' ? (p as unknown as { text: string }).text : ATTACHMENT_STUB))
    .join('\n')
    .trim();
}

/** The newest user message's text — what a resumed CLI session is sent. */
export function latestUserText(messages: HarnessMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user') return userText(m.content);
  }
  return '';
}

/**
 * A chat that lived on ordinary providers before the CLI took over: its history
 * exists only on Vo-Coder's side, so the first CLI turn carries a compact
 * rendering. Tail-capped — the recent end matters, and the CLI can read the
 * code itself.
 */
export function renderHistoryPrompt(messages: HarnessMessage[], maxChars = 30_000): string {
  const prior = messages.slice(0, -1);
  const newest = latestUserText(messages);
  if (!prior.length) return newest;

  const lines: string[] = [];
  for (const m of prior) {
    if (m.role === 'user') {
      const text = userText(m.content);
      if (text) lines.push(`User: ${text}`);
    } else if (m.role === 'assistant') {
      for (const part of m.content) {
        if (part.type === 'text' && part.text.trim()) lines.push(`Assistant: ${part.text.trim()}`);
        else if (part.type === 'tool_call') lines.push(`Assistant: · used ${part.name}`);
      }
    }
    // tool results are noise at this altitude — the outcomes are restated in prose
  }
  let rendered = lines.join('\n\n');
  if (rendered.length > maxChars) rendered = `…\n${rendered.slice(-maxChars)}`;
  return (
    'Context — this conversation started before you joined. What was said so far:\n\n' +
    `${rendered}\n\n` +
    `New user message:\n${newest}`
  );
}
