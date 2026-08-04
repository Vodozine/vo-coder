import { errorFromStatus, isAbortError, messageOf, networkError } from '../errors.js';
import { streamLines } from '../internal/ndjson.js';
import type {
  ChatProvider,
  ChatRequest,
  HarnessMessage,
  ModelInfo,
  ProviderEvent,
} from '../types.js';

export interface OllamaEndpoint {
  /** Short name; becomes the "@name" suffix in this endpoint's model ids. */
  name: string;
  url: string;
  /**
   * Pin this server's context window instead of sizing it per request. Set it
   * to the server's own OLLAMA_CONTEXT_LENGTH: Ollama RELOADS the model
   * whenever num_ctx differs from the loaded instance, and on a box where
   * loading costs a minute or more that eviction is the dominant cost.
   */
  contextTokens?: number;
}

export interface OllamaProviderOptions {
  /** Defaults to http://127.0.0.1:11434 */
  baseUrl?: string;
  /** Pin the primary server's context window — see OllamaEndpoint.contextTokens. */
  contextTokens?: number;
  /**
   * Additional named servers (one per GPU/box). Their models list as
   * "model@name" and requests carrying that suffix go to that server, so an
   * agent pinned to "llama3:70b@gpu2" always runs there.
   */
  extraEndpoints?: OllamaEndpoint[];
  /** Injectable for fixture tests — no network. */
  fetch?: typeof fetch;
}

interface OllamaChatChunk {
  message?: {
    role: string;
    content?: string;
    thinking?: string;
    tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/**
 * A local server answers nothing while it loads weights and prefills the
 * prompt — on an older card (P4/P40 class) with a few thousand tokens of
 * agent prompt that is minutes, not seconds. Shared by every local adapter.
 */
export const LOCAL_STALL_TIMEOUT_MS = 600_000;

/**
 * Keep the model resident between messages. Ollama's own default unloads
 * after 5 minutes, so a chat resumed after a coffee break pays the whole
 * load again — the single biggest source of "why is it so slow".
 */
const KEEP_ALIVE = '30m';

export class OllamaProvider implements ChatProvider {
  readonly id = 'ollama' as const;
  readonly stallTimeoutMs = LOCAL_STALL_TIMEOUT_MS;
  private baseUrl: string;
  private contextTokens?: number;
  /** name → endpoint. The primary server has no name and no suffix. */
  private extras: Map<string, { url: string; contextTokens?: number }>;
  private fetchFn: typeof fetch;

  constructor(opts: OllamaProviderOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
    this.contextTokens = opts.contextTokens;
    this.extras = new Map(
      (opts.extraEndpoints ?? [])
        .filter((e) => e.name && e.url)
        .map((e) => [
          e.name,
          { url: e.url.replace(/\/+$/, ''), contextTokens: e.contextTokens },
        ]),
    );
    this.fetchFn = opts.fetch ?? fetch;
  }

  /**
   * Ollama tags never contain "@", so a trailing "@name" can only be an
   * endpoint pin. Unknown names fall back to the primary server rather than
   * erroring, so a stale pin still answers (Ollama then 404s the bare tag with
   * its own clear message if the model truly is not there).
   */
  private resolve(modelId: string): {
    model: string;
    url: string;
    label: string;
    contextTokens?: number;
  } {
    const at = modelId.lastIndexOf('@');
    if (at > 0) {
      const ep = this.extras.get(modelId.slice(at + 1));
      if (ep) {
        return {
          model: modelId.slice(0, at),
          url: ep.url,
          label: ` (${modelId.slice(at + 1)})`,
          contextTokens: ep.contextTokens,
        };
      }
    }
    return { model: modelId, url: this.baseUrl, label: '', contextTokens: this.contextTokens };
  }

  async listModels(): Promise<ModelInfo[]> {
    const endpoints: Array<{ suffix: string; url: string }> = [
      { suffix: '', url: this.baseUrl },
      ...[...this.extras].map(([name, ep]) => ({ suffix: `@${name}`, url: ep.url })),
    ];
    const settled = await Promise.allSettled(
      endpoints.map(async ({ suffix, url }) => {
        const res = await this.fetchFn(`${url}/api/tags`);
        if (!res.ok) throw new Error(`Ollama returned ${res.status} listing models`);
        const json = (await res.json()) as { models?: Array<{ name: string }> };
        return (json.models ?? []).map((m) => ({
          id: `${m.name}${suffix}`,
          provider: this.id,
          displayName: `${m.name}${suffix}`,
        }));
      }),
    );
    const models = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    // Every endpoint down → surface the primary's failure like before; any
    // endpoint answering keeps the provider alive (LAN boxes come and go).
    if (!models.length && settled[0]?.status === 'rejected') {
      throw (settled[0] as PromiseRejectedResult).reason;
    }
    return models;
  }

  /**
   * Load the model and return — Ollama treats a request with no messages as
   * "make this resident". Sent with the SAME keep_alive and context window a
   * real turn would use, because a mismatch on either would just reload it
   * again and undo the warm-up.
   */
  async warm(modelId: string): Promise<void> {
    const target = this.resolve(modelId);
    await this.fetchFn(`${target.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: target.model,
        messages: [],
        stream: false,
        keep_alive: KEEP_ALIVE,
        ...(target.contextTokens ? { options: { num_ctx: target.contextTokens } } : {}),
      }),
    });
  }

  async *stream(
    req: ChatRequest,
    opts: { signal: AbortSignal },
  ): AsyncIterable<ProviderEvent> {
    const target = this.resolve(req.model);
    const messages = toOllamaMessages(req.system, req.messages);
    const body = {
      model: target.model,
      messages,
      stream: true,
      keep_alive: KEEP_ALIVE,
      ...(req.thinking?.enabled ? { think: true } : {}),
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              type: 'function',
              function: {
                name: t.name,
                description: t.description,
                parameters: t.inputSchema,
              },
            })),
          }
        : {}),
      options: {
        ...(req.params?.temperature !== undefined ? { temperature: req.params.temperature } : {}),
        ...(req.params?.maxTokens !== undefined ? { num_predict: req.params.maxTokens } : {}),
        ...contextWindow(messages, req, target.contextTokens),
      },
    };

    let res: Response;
    try {
      res = await this.fetchFn(`${target.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (err) {
      yield opts.signal.aborted || isAbortError(err)
        ? { type: 'done', stopReason: 'aborted' }
        : {
            type: 'error',
            error: networkError(
              `Could not reach Ollama${target.label} at ${target.url} — is it running? (${messageOf(err)})`,
            ),
          };
      return;
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      yield { type: 'error', error: errorFromStatus(res.status, detail || res.statusText) };
      return;
    }

    let toolIdx = 0;
    let sawToolCall = false;
    try {
      for await (const line of streamLines(res.body)) {
        const chunk = JSON.parse(line) as OllamaChatChunk;
        if (chunk.error) {
          yield { type: 'error', error: { kind: 'bad_request', message: chunk.error } };
          return;
        }
        if (chunk.message?.thinking) {
          yield { type: 'thinking_delta', text: chunk.message.thinking };
        }
        if (chunk.message?.content) {
          yield { type: 'text_delta', text: chunk.message.content };
        }
        for (const tc of chunk.message?.tool_calls ?? []) {
          sawToolCall = true;
          yield {
            type: 'tool_call',
            id: `ollama_call_${toolIdx++}`,
            name: tc.function.name,
            args: tc.function.arguments,
          };
        }
        if (chunk.done) {
          yield {
            type: 'usage',
            inputTokens: chunk.prompt_eval_count ?? 0,
            outputTokens: chunk.eval_count ?? 0,
          };
          yield {
            type: 'done',
            stopReason: sawToolCall
              ? 'tool_use'
              : chunk.done_reason === 'length'
                ? 'max_tokens'
                : 'end_turn',
          };
        }
      }
    } catch (err) {
      yield opts.signal.aborted || isAbortError(err)
        ? { type: 'done', stopReason: 'aborted' }
        : { type: 'error', error: networkError(messageOf(err)) };
    }
  }
}

interface OllamaMessage {
  role: string;
  content: string;
  images?: string[];
  tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
}

/**
 * Ollama silently TRUNCATES the prompt to the server's context window
 * (num_ctx, default 4096) — an agent prompt with tool definitions blows past
 * that, the model loses its instructions mid-sentence, and the classic symptom
 * is a "reply" of a few counted tokens with no visible text (the cut lands
 * inside a tool JSON and the output is template junk the parser eats).
 *
 * Size the window to the request instead: rough token estimate (chars/3.5 is
 * a safe over-count for mostly-English text) plus response headroom, bucketed
 * to coarse steps so the value stays stable across a conversation — Ollama
 * reloads the model when num_ctx changes, so a per-request exact value would
 * thrash. Left unset when the default window already fits.
 */
export function contextWindow(
  messages: Array<{ content: string }>,
  req: { system?: string; tools?: Array<unknown> },
  pinned?: number,
): { num_ctx?: number } {
  // A pinned window is the endpoint's own setting: send it unchanged on every
  // request so the loaded instance is never evicted. Sizing per request would
  // reload the model — a minute or more on a box with slow storage — and would
  // also fight anything else using that server at its default window.
  if (pinned && pinned > 0) return { num_ctx: pinned };
  const chars =
    messages.reduce((n, m) => n + m.content.length, 0) +
    (req.tools?.length ? JSON.stringify(req.tools).length : 0);
  const estTokens = Math.ceil(chars / 3.5) + 2048; // + response headroom
  if (estTokens <= 4096) return {};
  for (const bucket of [8192, 16384, 32768]) {
    if (estTokens <= bucket) return { num_ctx: bucket };
  }
  // Beyond 32k: cap — bigger KV caches OOM small GPUs; the buffer/compaction
  // layer above is responsible for keeping conversations inside bounds.
  return { num_ctx: 32768 };
}

function toOllamaMessages(
  system: string | undefined,
  messages: HarnessMessage[],
): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const msg of messages) {
    if (msg.role === 'user') {
      const texts: string[] = [];
      const images: string[] = [];
      for (const part of msg.content) {
        if (part.type === 'text') {
          if (part.text) texts.push(part.text);
        } else if (part.type === 'image') {
          images.push(part.data);
        } else if (
          part.mediaType.startsWith('text/') ||
          part.mediaType === 'application/json'
        ) {
          const text = Buffer.from(part.data, 'base64').toString('utf8');
          texts.push(`[Attached file: ${part.name}]\n\n${text}`);
        } else {
          texts.push(`[Attached file "${part.name}" (${part.mediaType}) is not supported by this provider.]`);
        }
      }
      out.push({
        role: 'user',
        content: texts.join('\n'),
        ...(images.length ? { images } : {}),
      });
    } else if (msg.role === 'assistant') {
      const texts: string[] = [];
      const toolCalls: OllamaMessage['tool_calls'] = [];
      for (const part of msg.content) {
        if (part.type === 'text' && part.text) texts.push(part.text);
        else if (part.type === 'tool_call') {
          toolCalls.push({ function: { name: part.name, arguments: part.args } });
        }
        // thinking parts are not replayed
      }
      out.push({
        role: 'assistant',
        content: texts.join(''),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else {
      out.push({ role: 'tool', content: msg.content });
    }
  }
  return out;
}
