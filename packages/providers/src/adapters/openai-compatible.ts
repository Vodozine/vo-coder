import { errorFromStatus, isAbortError, messageOf, networkError } from '../errors.js';
import { streamLines } from '../internal/ndjson.js';
import type {
  ChatProvider,
  ChatRequest,
  HarnessMessage,
  ModelInfo,
  ProviderEvent,
  ProviderId,
  StopReason,
} from '../types.js';

/**
 * Shared core for OpenAI-wire-compatible providers (OpenAI, OpenRouter, and any
 * self-hosted endpoint speaking /chat/completions SSE).
 */
export interface OpenAICompatibleOptions {
  apiKey: string;
  baseURL: string;
  /** Extra headers, e.g. OpenRouter attribution. */
  headers?: Record<string, string>;
  /** Injectable for fixture tests — no network. */
  fetch?: typeof fetch;
}

interface CompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      /** OpenRouter-style reasoning stream. */
      reasoning?: string | null;
      /** xAI / DeepSeek-style reasoning stream. */
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
  error?: { message?: string };
}

export class OpenAICompatibleProvider implements ChatProvider {
  readonly id: ProviderId;
  protected apiKey: string;
  protected baseURL: string;
  protected extraHeaders: Record<string, string>;
  protected fetchFn: typeof fetch;

  constructor(id: ProviderId, opts: OpenAICompatibleOptions) {
    this.id = id;
    this.apiKey = opts.apiKey;
    this.baseURL = opts.baseURL.replace(/\/+$/, '');
    this.extraHeaders = opts.headers ?? {};
    this.fetchFn = opts.fetch ?? fetch;
  }

  protected headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
      ...this.extraHeaders,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.fetchFn(`${this.baseURL}/models`, { headers: this.headers() });
    if (!res.ok) throw new Error(`${this.id} returned ${res.status} listing models`);
    const json = (await res.json()) as { data?: Array<{ id: string; context_length?: number }> };
    return (json.data ?? []).map((m) => ({
      id: m.id,
      provider: this.id,
      displayName: m.id,
      contextLength: m.context_length,
    }));
  }

  async *stream(
    req: ChatRequest,
    opts: { signal: AbortSignal },
  ): AsyncIterable<ProviderEvent> {
    const body = {
      model: req.model,
      messages: toOpenAIMessages(req.system, req.messages),
      stream: true,
      stream_options: { include_usage: true },
      ...(req.params?.temperature !== undefined ? { temperature: req.params.temperature } : {}),
      ...(req.params?.maxTokens !== undefined ? { max_tokens: req.params.maxTokens } : {}),
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
    };

    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (err) {
      yield opts.signal.aborted || isAbortError(err)
        ? { type: 'done', stopReason: 'aborted' }
        : { type: 'error', error: networkError(messageOf(err)) };
      return;
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      yield { type: 'error', error: errorFromStatus(res.status, detail || res.statusText) };
      return;
    }

    const toolAcc = new Map<number, { id: string; name: string; json: string }>();
    let stopReason: StopReason = 'end_turn';
    let usageEmitted = false;

    const flushTools = function* (): Generator<ProviderEvent> {
      for (const acc of toolAcc.values()) {
        yield {
          type: 'tool_call',
          id: acc.id,
          name: acc.name,
          args: acc.json ? JSON.parse(acc.json) : {},
        };
      }
      toolAcc.clear();
    };

    try {
      for await (const line of streamLines(res.body)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') break;
        const chunk = JSON.parse(payload) as CompletionChunk;
        if (chunk.error?.message) {
          yield { type: 'error', error: { kind: 'unknown', message: chunk.error.message } };
          return;
        }
        const choice = chunk.choices?.[0];
        const reasoning = choice?.delta?.reasoning ?? choice?.delta?.reasoning_content;
        if (reasoning) {
          yield { type: 'thinking_delta', text: reasoning };
        }
        if (choice?.delta?.content) {
          yield { type: 'text_delta', text: choice.delta.content };
        }
        for (const tc of choice?.delta?.tool_calls ?? []) {
          const acc = toolAcc.get(tc.index) ?? { id: '', name: '', json: '' };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.json += tc.function.arguments;
          toolAcc.set(tc.index, acc);
        }
        if (choice?.finish_reason) {
          yield* flushTools();
          stopReason =
            choice.finish_reason === 'tool_calls'
              ? 'tool_use'
              : choice.finish_reason === 'length'
                ? 'max_tokens'
                : 'end_turn';
        }
        if (chunk.usage) {
          usageEmitted = true;
          yield {
            type: 'usage',
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            ...(chunk.usage.prompt_tokens_details?.cached_tokens !== undefined
              ? { cacheReadTokens: chunk.usage.prompt_tokens_details.cached_tokens }
              : {}),
          };
        }
      }
      yield* flushTools();
      if (!usageEmitted) yield { type: 'usage', inputTokens: 0, outputTokens: 0 };
      yield { type: 'done', stopReason };
    } catch (err) {
      yield opts.signal.aborted || isAbortError(err)
        ? { type: 'done', stopReason: 'aborted' }
        : { type: 'error', error: networkError(messageOf(err)) };
    }
  }
}

export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(opts: Omit<OpenAICompatibleOptions, 'baseURL'> & { baseURL?: string }) {
    super('openai', { ...opts, baseURL: opts.baseURL ?? 'https://api.openai.com/v1' });
  }
}

export class XaiProvider extends OpenAICompatibleProvider {
  constructor(opts: Omit<OpenAICompatibleOptions, 'baseURL'> & { baseURL?: string }) {
    super('xai', { ...opts, baseURL: opts.baseURL ?? 'https://api.x.ai/v1' });
  }
}

/** LM Studio's local server speaks the OpenAI wire format; no real key needed. */
export class LmStudioProvider extends OpenAICompatibleProvider {
  constructor(opts: Partial<OpenAICompatibleOptions> = {}) {
    super('lmstudio', {
      apiKey: opts.apiKey ?? 'lm-studio',
      baseURL: opts.baseURL ?? 'http://127.0.0.1:1234/v1',
      headers: opts.headers,
      fetch: opts.fetch,
    });
  }
}

export class OpenRouterProvider extends OpenAICompatibleProvider {
  constructor(opts: Omit<OpenAICompatibleOptions, 'baseURL'> & { baseURL?: string }) {
    super('openrouter', {
      ...opts,
      baseURL: opts.baseURL ?? 'https://openrouter.ai/api/v1',
      headers: {
        'HTTP-Referer': 'https://github.com/vo-coder/vo-coder',
        'X-Title': 'Vo-Coder',
        ...opts.headers,
      },
    });
  }
}

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

type OpenAIMessage =
  | { role: 'system' | 'tool'; content: string; tool_call_id?: string }
  | { role: 'user'; content: string | OpenAIContentPart[] }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };

function toOpenAIMessages(
  system: string | undefined,
  messages: HarnessMessage[],
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const msg of messages) {
    if (msg.role === 'user') {
      const parts: OpenAIContentPart[] = [];
      for (const part of msg.content) {
        if (part.type === 'text') {
          if (part.text) parts.push({ type: 'text', text: part.text });
        } else if (part.type === 'image') {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${part.mediaType};base64,${part.data}` },
          });
        } else if (
          part.mediaType.startsWith('text/') ||
          part.mediaType === 'application/json'
        ) {
          const text = Buffer.from(part.data, 'base64').toString('utf8');
          parts.push({ type: 'text', text: `[Attached file: ${part.name}]\n\n${text}` });
        } else {
          parts.push({
            type: 'text',
            text: `[Attached file "${part.name}" (${part.mediaType}) is not supported by this provider.]`,
          });
        }
      }
      const onlyText = parts.every((p) => p.type === 'text');
      out.push({
        role: 'user',
        content: onlyText ? parts.map((p) => (p as { text: string }).text).join('\n') : parts,
      });
    } else if (msg.role === 'assistant') {
      const texts: string[] = [];
      const toolCalls: Extract<OpenAIMessage, { role: 'assistant' }>['tool_calls'] = [];
      for (const part of msg.content) {
        if (part.type === 'text' && part.text) texts.push(part.text);
        else if (part.type === 'tool_call') {
          toolCalls.push({
            id: part.id,
            type: 'function',
            function: { name: part.name, arguments: JSON.stringify(part.args ?? {}) },
          });
        }
      }
      out.push({
        role: 'assistant',
        content: texts.length ? texts.join('') : null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else {
      out.push({ role: 'tool', content: msg.content, tool_call_id: msg.toolCallId });
    }
  }
  return out;
}
