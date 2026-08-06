/**
 * The load-bearing contract of the harness. Every provider adapter normalizes its
 * wire format into `ProviderEvent`s; everything downstream (agent loop, thinking
 * pane, injection, routing) consumes only this vocabulary.
 *
 * Streaming error contract: `stream()` never throws for expected failures. It
 * yields `{ type: 'error' }` as its final event, or `{ type: 'done',
 * stopReason: 'aborted' }` when the caller aborts. A successful stream always
 * ends with a `usage` event followed by `done`.
 */

export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'openrouter'
  | 'ollama'
  | 'xai'
  | 'zai'
  | 'nvidia'
  | 'lmstudio'
  | 'llamacpp'
  | (string & {});

/**
 * What a local server can tell us about a model, so its context window can be
 * arithmetic instead of a guess. All-optional on purpose: a box may be asleep,
 * and a model that is not currently loaded cannot report its real cache cost.
 */
export interface EndpointMeasurement {
  /** Weights on disk. */
  weightsBytes?: number;
  quantization?: string;
  /** The model's own ceiling — never exceed it. */
  trainedContext?: number;
  /** Observed on a loaded instance. */
  loadedContext?: number;
  totalBytes?: number;
  vramBytes?: number;
  /**
   * (total − weights) / loadedContext. The one number that makes fitting
   * computable — and it must be MEASURED: the architecture formula
   * over-predicts by ~3.5x on models using sliding-window attention or a
   * quantised KV cache.
   */
  bytesPerToken?: number;
  /** The loaded instance did not fit entirely on the GPU — the 20x cliff. */
  spilled?: boolean;
}

export interface ModelInfo {
  id: string;
  provider: ProviderId;
  displayName?: string;
  contextLength?: number;
  /** Weights on disk. Local servers report it; cloud models have no such thing. */
  sizeBytes?: number;
  quantization?: string;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsThinking?: boolean;
}

// ---- Message parts (multimodal from day 1) ----

export interface TextPart {
  type: 'text';
  text: string;
}

/** Raw base64 payload (no data: URI prefix). */
export interface ImagePart {
  type: 'image';
  mediaType: string;
  data: string;
}

/** Raw base64 payload. PDFs and text files supported in v1. */
export interface FilePart {
  type: 'file';
  mediaType: string;
  name: string;
  data: string;
}

export type UserPart = TextPart | ImagePart | FilePart;

export interface ThinkingPart {
  type: 'thinking';
  text: string;
  /** Provider-issued signature (Anthropic). Thinking parts without one are dropped on replay. */
  signature?: string;
}

export interface ToolCallPart {
  type: 'tool_call';
  id: string;
  name: string;
  args: unknown;
}

export type AssistantPart = TextPart | ThinkingPart | ToolCallPart;

export type HarnessMessage =
  | { role: 'user'; content: UserPart[] }
  | { role: 'assistant'; content: AssistantPart[] }
  | { role: 'tool'; toolCallId: string; content: string; isError?: boolean };

// ---- Requests ----

export interface ToolSpec {
  name: string;
  description?: string;
  /** JSON Schema for the tool's parameters. */
  inputSchema: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  system?: string;
  messages: HarnessMessage[];
  tools?: ToolSpec[];
  params?: {
    temperature?: number;
    maxTokens?: number;
  };
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
  };
}

// ---- Events ----

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted';

export type ProviderErrorKind = 'auth' | 'rate_limit' | 'network' | 'bad_request' | 'unknown';

export interface ProviderErrorInfo {
  kind: ProviderErrorKind;
  message: string;
  status?: number;
}

export type ProviderEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  /**
   * Tool-call arguments are streaming in (chars accumulated so far). A model
   * writing a 40KB file inside one call produces MINUTES of otherwise-silent
   * generation — without this heartbeat the stall watchdog kills healthy
   * turns, always at the worst moment: mid-assembly of the biggest artifact.
   */
  | { type: 'tool_progress'; name?: string; chars: number }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens?: number }
  | { type: 'done'; stopReason: StopReason }
  | { type: 'error'; error: ProviderErrorInfo };

// ---- The provider interface ----

export interface ChatProvider {
  readonly id: ProviderId;
  /**
   * How long this provider may legitimately produce NOTHING before a run is
   * declared stalled. Cloud APIs answer in seconds, so the harness default is
   * tight; a local server loading weights and prefilling a long prompt on an
   * older GPU is silent for minutes and needs its own, much larger budget.
   */
  readonly stallTimeoutMs?: number;
  /**
   * Ask the backend to make this model ready without generating anything.
   * Only meaningful where readiness is expensive and observable — a local
   * server that must read gigabytes off disk before its first token.
   */
  warm?(model: string): Promise<void>;
  /**
   * What the backend can tell us about a model's real memory cost, so the
   * caller can size the context window instead of guessing. Only meaningful
   * where the window is the caller's to choose — i.e. local servers.
   */
  measure?(model: string): Promise<EndpointMeasurement>;
  listModels(): Promise<ModelInfo[]>;
  stream(req: ChatRequest, opts: { signal: AbortSignal }): AsyncIterable<ProviderEvent>;
}

/** Per-agent configuration; unset fields fall back to app defaults. */
export interface AgentSpec {
  id: string;
  name: string;
  systemPrompt?: string;
  provider?: ProviderId;
  model?: string;
  params?: ChatRequest['params'];
  mcpServers?: string[];
  /** How a mid-stream user message is handled. Default: 'queue'. */
  injectionMode?: 'abort-and-resend' | 'queue';
  /** Comma-separated specialty keywords used when Vodo delegates work. */
  routingHints?: string;
  thinkingVisibility?: 'visible' | 'hidden';
  /** Request extended thinking/reasoning from providers that support it. */
  thinking?: ChatRequest['thinking'];
}
