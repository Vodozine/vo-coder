import type {
  AgentSpec,
  AssistantPart,
  BoundModel,
  HarnessMessage,
  ProviderEvent,
  ToolSpec,
  UserPart,
} from '@vo-coder/providers';

export type SessionStatus = 'idle' | 'streaming' | 'awaiting_tool';

/**
 * Superset of ProviderEvent — the desktop app forwards these verbatim over IPC,
 * so the renderer consumes one event vocabulary end to end.
 */
export type SessionEvent =
  | ProviderEvent
  | { type: 'status'; status: SessionStatus }
  | { type: 'tool_started'; callId: string; name: string; args: unknown }
  | {
      type: 'tool_result';
      callId: string;
      name: string;
      result: string;
      isError: boolean;
      /** Generated image on disk — UI-only; never enters token-bearing history. */
      imagePath?: string;
    };

export interface ToolExecutor {
  tools(): ToolSpec[];
  execute(
    name: string,
    args: unknown,
  ): Promise<{ content: string; isError?: boolean; imagePath?: string }>;
}

export type PermissionDecision = 'allow' | 'deny';

export interface PermissionRequest {
  sessionId: string;
  callId: string;
  name: string;
  args: unknown;
}

export type PermissionCallback = (req: PermissionRequest) => Promise<PermissionDecision>;

export interface AgentSessionOptions {
  id: string;
  spec: AgentSpec;
  /** Resolves the agent's provider/model cascade at send time (fresh keys/config). */
  resolve: (spec: AgentSpec) => BoundModel;
  emit: (sessionId: string, event: SessionEvent) => void;
  toolExecutor?: ToolExecutor;
  /** Absent → tool calls are auto-allowed (host is expected to wire prompts). */
  permission?: PermissionCallback;
  /** Max provider round-trips per user send. Default 16. */
  maxToolTurns?: number;
  /**
   * Context assembly (window-as-buffer): called once per user send with the
   * full history; returns the index of the first message to include in
   * provider requests for that run. Older messages stay in `history` (UI,
   * persistence, archive) but drop out of the wire request. The index MUST
   * point at a user message so tool_call/result pairs are never split.
   * Absent or 0 → full replay (today's behavior).
   */
  contextStart?: (history: readonly HarnessMessage[]) => number;
  /**
   * Last-mile adaptation of the outgoing request for the resolved model
   * (e.g. stubbing image parts for non-vision models). Never mutates
   * `history` — return a new array.
   */
  prepareMessages?: (
    messages: readonly HarnessMessage[],
    bound: BoundModel,
  ) => HarnessMessage[];
}

export interface SendResult {
  ok: boolean;
  error?: string;
  /** True when the message was queued behind the in-flight run. */
  queued?: boolean;
}

const DENIED_RESULT = 'The user denied permission for this tool call.';

/**
 * The agent loop state machine: idle → streaming → awaiting_tool → streaming …
 * → idle. Each session owns its own history and bound model — isolation between
 * concurrent agents comes from here, not from provider clients (those are
 * stateless).
 */
export class AgentSession {
  readonly id: string;
  spec: AgentSpec;
  readonly history: HarnessMessage[] = [];
  private status: SessionStatus = 'idle';
  private abortCtl: AbortController | null = null;
  private cancelled = false;
  private injectQueue: UserPart[][] = [];
  /** First history index sent to the provider this run (window-as-buffer). */
  private startIdx = 0;

  constructor(private opts: AgentSessionOptions) {
    this.id = opts.id;
    this.spec = opts.spec;
  }

  getStatus(): SessionStatus {
    return this.status;
  }

  send(
    input: string | UserPart[],
    override?: Pick<AgentSpec, 'provider' | 'model'>,
  ): SendResult {
    if (this.status !== 'idle') {
      return { ok: false, error: 'Session is busy — stop the current run first.' };
    }
    let bound: BoundModel;
    try {
      bound = this.opts.resolve(override ? { ...this.spec, ...override } : this.spec);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const parts: UserPart[] = typeof input === 'string' ? [{ type: 'text', text: input }] : input;
    this.history.push({ role: 'user', content: parts });
    // Anchor the buffer cut once per send — recomputing mid-run could shift
    // the boundary under an in-flight tool loop.
    this.startIdx = Math.max(0, Math.min(this.opts.contextStart?.(this.history) ?? 0, this.history.length - 1));
    void this.runLoop(bound);
    return { ok: true };
  }

  stop(): void {
    this.cancelled = true;
    this.abortCtl?.abort();
  }

  /**
   * Graceful mid-task user input — the model must not treat it as a reset.
   *
   * 'queue' (default): hold the message until the current run finishes, then
   * send it as the next turn.
   * 'abort-and-resend': the only universal primitive — cancel the stream,
   * KEEP the partial assistant content in history, then send the new message
   * so the model sees its own partial work plus the user's addition.
   */
  inject(input: string | UserPart[]): SendResult {
    if (this.status === 'idle') return this.send(input);
    const parts: UserPart[] = typeof input === 'string' ? [{ type: 'text', text: input }] : input;
    const mode = this.spec.injectionMode ?? 'queue';
    this.injectQueue.push(parts);
    if (mode === 'abort-and-resend') {
      this.stop();
      return { ok: true };
    }
    return { ok: true, queued: true };
  }

  private drainInjectQueue(): void {
    if (this.status !== 'idle') return;
    const next = this.injectQueue.shift();
    if (next) {
      const result = this.send(next);
      if (!result.ok) {
        this.opts.emit(this.id, {
          type: 'error',
          error: { kind: 'unknown', message: `Queued message failed: ${result.error}` },
        });
      }
    }
  }

  reset(): void {
    this.injectQueue.length = 0;
    this.stop();
    this.history.length = 0;
  }

  private setStatus(status: SessionStatus): void {
    this.status = status;
    this.opts.emit(this.id, { type: 'status', status });
  }

  private async runLoop(bound: BoundModel): Promise<void> {
    this.cancelled = false;
    const maxTurns = this.opts.maxToolTurns ?? 16;
    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        this.setStatus('streaming');
        const ac = new AbortController();
        this.abortCtl = ac;
        const tools = this.opts.toolExecutor?.tools() ?? [];

        let text = '';
        let thinking = '';
        const toolCalls: Array<{ id: string; name: string; args: unknown }> = [];
        let wantsTools = false;
        let erred = false;

        for await (const event of bound.provider.stream(
          {
            model: bound.model,
            system: this.spec.systemPrompt,
            messages: (() => {
              const window =
                this.startIdx > 0 ? this.history.slice(this.startIdx) : this.history;
              return this.opts.prepareMessages?.(window, bound) ?? (window as HarnessMessage[]);
            })(),
            params: this.spec.params,
            ...(this.spec.thinking ? { thinking: this.spec.thinking } : {}),
            ...(tools.length ? { tools } : {}),
          },
          { signal: ac.signal },
        )) {
          this.opts.emit(this.id, event);
          switch (event.type) {
            case 'text_delta':
              text += event.text;
              break;
            case 'thinking_delta':
              thinking += event.text;
              break;
            case 'tool_call':
              toolCalls.push({ id: event.id, name: event.name, args: event.args });
              break;
            case 'done':
              if (event.stopReason === 'aborted') this.cancelled = true;
              else wantsTools = event.stopReason === 'tool_use' && toolCalls.length > 0;
              break;
            case 'error':
              erred = true;
              break;
            case 'usage':
              break;
          }
        }
        this.abortCtl = null;

        const parts: AssistantPart[] = [];
        if (thinking) parts.push({ type: 'thinking', text: thinking });
        if (text) parts.push({ type: 'text', text });
        for (const tc of toolCalls) parts.push({ type: 'tool_call', ...tc });
        if (parts.length) this.history.push({ role: 'assistant', content: parts });

        if (this.cancelled || erred || !wantsTools) return;

        if (turn === maxTurns - 1) {
          this.opts.emit(this.id, {
            type: 'error',
            error: {
              kind: 'unknown',
              message: `Stopped after ${maxTurns} tool turns without a final answer.`,
            },
          });
          return;
        }

        this.setStatus('awaiting_tool');
        for (const tc of toolCalls) {
          if (this.cancelled) return;
          const decision = this.opts.permission
            ? await this.opts.permission({
                sessionId: this.id,
                callId: tc.id,
                name: tc.name,
                args: tc.args,
              })
            : 'allow';
          if (this.cancelled) return;
          if (decision === 'deny') {
            this.history.push({
              role: 'tool',
              toolCallId: tc.id,
              content: DENIED_RESULT,
              isError: true,
            });
            this.opts.emit(this.id, {
              type: 'tool_result',
              callId: tc.id,
              name: tc.name,
              result: DENIED_RESULT,
              isError: true,
            });
            continue;
          }
          this.opts.emit(this.id, {
            type: 'tool_started',
            callId: tc.id,
            name: tc.name,
            args: tc.args,
          });
          let result: { content: string; isError?: boolean; imagePath?: string };
          try {
            result = this.opts.toolExecutor
              ? await this.opts.toolExecutor.execute(tc.name, tc.args)
              : { content: 'No tool executor configured.', isError: true };
          } catch (err) {
            result = {
              content: `Tool failed: ${err instanceof Error ? err.message : String(err)}`,
              isError: true,
            };
          }
          this.history.push({
            role: 'tool',
            toolCallId: tc.id,
            content: result.content,
            isError: result.isError,
          });
          this.opts.emit(this.id, {
            type: 'tool_result',
            callId: tc.id,
            name: tc.name,
            result: result.content,
            isError: !!result.isError,
            ...(result.imagePath ? { imagePath: result.imagePath } : {}),
          });
        }
        if (this.cancelled) return;
      }
    } finally {
      this.abortCtl = null;
      this.setStatus('idle');
      // Microtask so the finally block fully unwinds before a queued or
      // injected message starts the next run.
      queueMicrotask(() => this.drainInjectQueue());
    }
  }
}
