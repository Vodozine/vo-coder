import { errorFromStatus, isAbortError, messageOf, networkError } from '../errors.js';
import { streamLines } from '../internal/ndjson.js';
import type {
  ChatProvider,
  ChatRequest,
  HarnessMessage,
  ModelInfo,
  ProviderEvent,
} from '../types.js';

export interface OllamaProviderOptions {
  /** Defaults to http://127.0.0.1:11434 */
  baseUrl?: string;
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

export class OllamaProvider implements ChatProvider {
  readonly id = 'ollama' as const;
  private baseUrl: string;
  private fetchFn: typeof fetch;

  constructor(opts: OllamaProviderOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
    this.fetchFn = opts.fetch ?? fetch;
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.fetchFn(`${this.baseUrl}/api/tags`);
    if (!res.ok) throw new Error(`Ollama returned ${res.status} listing models`);
    const json = (await res.json()) as { models?: Array<{ name: string }> };
    return (json.models ?? []).map((m) => ({
      id: m.name,
      provider: this.id,
      displayName: m.name,
    }));
  }

  async *stream(
    req: ChatRequest,
    opts: { signal: AbortSignal },
  ): AsyncIterable<ProviderEvent> {
    const body = {
      model: req.model,
      messages: toOllamaMessages(req.system, req.messages),
      stream: true,
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
      },
    };

    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/api/chat`, {
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
              `Could not reach Ollama at ${this.baseUrl} — is it running? (${messageOf(err)})`,
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
