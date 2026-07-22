import Anthropic from '@anthropic-ai/sdk';
import { errorFromStatus, isAbortError, messageOf, networkError } from '../errors.js';
import type {
  ChatProvider,
  ChatRequest,
  HarnessMessage,
  ModelInfo,
  ProviderErrorInfo,
  ProviderEvent,
  StopReason,
  UserPart,
} from '../types.js';

export interface AnthropicProviderOptions {
  apiKey: string;
  baseURL?: string;
  /** Injectable for fixture tests — no network. */
  fetch?: typeof fetch;
}

const DEFAULT_MAX_TOKENS = 4096;

export class AnthropicProvider implements ChatProvider {
  readonly id = 'anthropic' as const;
  private client: Anthropic;

  constructor(opts: AnthropicProviderOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      fetch: opts.fetch,
      maxRetries: 2,
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    const page = await this.client.models.list({ limit: 100 });
    return page.data.map((m) => ({
      id: m.id,
      provider: this.id,
      displayName: m.display_name,
      supportsTools: true,
      supportsVision: true,
      supportsThinking: true,
    }));
  }

  async *stream(
    req: ChatRequest,
    opts: { signal: AbortSignal },
  ): AsyncIterable<ProviderEvent> {
    let maxTokens = req.params?.maxTokens ?? DEFAULT_MAX_TOKENS;
    let thinking: Anthropic.ThinkingConfigParam | undefined;
    if (req.thinking?.enabled) {
      const budget = Math.max(1024, req.thinking.budgetTokens ?? 4096);
      thinking = { type: 'enabled', budget_tokens: budget };
      maxTokens = Math.max(maxTokens, budget + 1024);
    }

    let stream: AsyncIterable<Anthropic.RawMessageStreamEvent>;
    try {
      stream = await this.client.messages.create(
        {
          model: req.model,
          max_tokens: maxTokens,
          system: req.system,
          messages: toAnthropicMessages(req.messages),
          stream: true,
          ...(thinking ? { thinking } : {}),
          // Anthropic rejects temperature != 1 when extended thinking is on.
          ...(req.params?.temperature !== undefined && !thinking
            ? { temperature: req.params.temperature }
            : {}),
          ...(req.tools?.length
            ? {
                tools: req.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
                })),
              }
            : {}),
        },
        { signal: opts.signal },
      );
    } catch (err) {
      yield terminal(err, opts.signal);
      return;
    }

    let inputTokens = 0;
    let cacheReadTokens: number | undefined;
    let stopReason: StopReason = 'end_turn';
    let toolAcc: { id: string; name: string; json: string } | null = null;

    try {
      for await (const ev of stream) {
        switch (ev.type) {
          case 'message_start':
            inputTokens = ev.message.usage.input_tokens;
            cacheReadTokens = ev.message.usage.cache_read_input_tokens ?? undefined;
            break;
          case 'content_block_start':
            if (ev.content_block.type === 'tool_use') {
              toolAcc = { id: ev.content_block.id, name: ev.content_block.name, json: '' };
            }
            break;
          case 'content_block_delta':
            if (ev.delta.type === 'text_delta') {
              yield { type: 'text_delta', text: ev.delta.text };
            } else if (ev.delta.type === 'thinking_delta') {
              yield { type: 'thinking_delta', text: ev.delta.thinking };
            } else if (ev.delta.type === 'input_json_delta' && toolAcc) {
              toolAcc.json += ev.delta.partial_json;
            }
            break;
          case 'content_block_stop':
            if (toolAcc) {
              yield {
                type: 'tool_call',
                id: toolAcc.id,
                name: toolAcc.name,
                args: toolAcc.json ? JSON.parse(toolAcc.json) : {},
              };
              toolAcc = null;
            }
            break;
          case 'message_delta':
            stopReason = mapStopReason(ev.delta.stop_reason);
            yield {
              type: 'usage',
              inputTokens,
              outputTokens: ev.usage.output_tokens,
              ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
            };
            break;
          case 'message_stop':
            yield { type: 'done', stopReason };
            break;
        }
      }
    } catch (err) {
      yield terminal(err, opts.signal);
    }
  }
}

function terminal(err: unknown, signal: AbortSignal): ProviderEvent {
  if (signal.aborted || isAbortError(err)) {
    return { type: 'done', stopReason: 'aborted' };
  }
  return { type: 'error', error: normalizeError(err) };
}

function normalizeError(err: unknown): ProviderErrorInfo {
  if (err instanceof Anthropic.APIConnectionError) {
    return networkError(err.message);
  }
  if (err instanceof Anthropic.APIError) {
    return errorFromStatus(err.status, err.message);
  }
  return { kind: 'unknown', message: messageOf(err) };
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    default:
      return 'end_turn';
  }
}

function toAnthropicMessages(messages: HarnessMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      const blocks = msg.content.map(userPartToBlock).filter((b) => b !== null);
      if (blocks.length) out.push({ role: 'user', content: blocks });
    } else if (msg.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = [];
      for (const part of msg.content) {
        if (part.type === 'text') {
          if (part.text) blocks.push({ type: 'text', text: part.text });
        } else if (part.type === 'thinking') {
          // Anthropic requires the original signature to replay thinking blocks.
          if (part.signature) {
            blocks.push({ type: 'thinking', thinking: part.text, signature: part.signature });
          }
        } else {
          blocks.push({
            type: 'tool_use',
            id: part.id,
            name: part.name,
            input: part.args ?? {},
          });
        }
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
    } else {
      // Tool results ride in user turns; consecutive results merge into one turn.
      const block: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: msg.toolCallId,
        content: msg.content,
        ...(msg.isError ? { is_error: true } : {}),
      };
      const prev = out[out.length - 1];
      if (
        prev &&
        prev.role === 'user' &&
        Array.isArray(prev.content) &&
        prev.content.every((b) => b.type === 'tool_result')
      ) {
        (prev.content as Anthropic.ToolResultBlockParam[]).push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    }
  }
  return out;
}

function userPartToBlock(part: UserPart): Anthropic.ContentBlockParam | null {
  switch (part.type) {
    case 'text':
      return part.text ? { type: 'text', text: part.text } : null;
    case 'image':
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: part.mediaType as 'image/png',
          data: part.data,
        },
      };
    case 'file':
      if (part.mediaType === 'application/pdf') {
        return {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: part.data },
        };
      }
      if (part.mediaType.startsWith('text/') || part.mediaType === 'application/json') {
        const text = Buffer.from(part.data, 'base64').toString('utf8');
        return { type: 'text', text: `[Attached file: ${part.name}]\n\n${text}` };
      }
      return {
        type: 'text',
        text: `[Attached file "${part.name}" (${part.mediaType}) could not be inlined for this provider.]`,
      };
  }
}
