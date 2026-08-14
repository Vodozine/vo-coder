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
  /**
   * A queued injection left the queue: the next turn opened with it (`ok`) or
   * the send failed and the message was dropped (`!ok`). This is the moment
   * the UI's "queued" note can honestly become "seen".
   */
  | { type: 'inject_delivered'; injectionId: number; ok: boolean }
  | { type: 'tool_started'; callId: string; name: string; args: unknown }
  | {
      type: 'tool_result';
      callId: string;
      name: string;
      result: string;
      isError: boolean;
      /** Generated image on disk — UI-only; never enters token-bearing history. */
      imagePath?: string;
      /** Generated video on disk — same side-channel, same rule. */
      videoPath?: string;
      /** Generated audio on disk — plays in the chat; the bytes stay on disk. */
      audioPath?: string;
    };

export interface ToolExecutor {
  tools(): ToolSpec[];
  execute(
    name: string,
    args: unknown,
    /** Aborted when the user stops the run — long tools (ws_run) must honor it. */
    signal?: AbortSignal,
  ): Promise<{
    content: string;
    isError?: boolean;
    imagePath?: string;
    videoPath?: string;
    audioPath?: string;
  }>;
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
  /**
   * Ms of provider silence before the run is declared stalled. Overrides
   * everything (both phases exactly); unset lets each provider state its own
   * budget (local servers need minutes) before falling back to 120s.
   */
  stallTimeoutMs?: number;
  /**
   * Prefill budget: silence allowed before the FIRST meaningful event of each
   * request, when stallTimeoutMs is not set. Default 5 min — big contexts
   * legitimately prefill for minutes on every tool round.
   */
  firstEventGraceMs?: number;
}

export interface SendResult {
  ok: boolean;
  error?: string;
  /** True when the message was queued behind the in-flight run. */
  queued?: boolean;
  /** Handle for a queued injection — cancelInjection() takes it, and the
   *  inject_delivered event echoes it when the message actually goes out. */
  injectionId?: number;
}

const DENIED_RESULT = 'The user denied permission for this tool call.';
const BUDGET_RESULT =
  'Tool-step budget reached — this call was NOT executed. The run paused here; it resumes when ' +
  'the user says continue.';
const INTERRUPTED_RESULT = 'Stopped before this tool ran.';

/**
 * Chat-template sentinels that leak into TEXT when a local endpoint fails to
 * parse the model's native tool-call / role syntax (seen live: a Kimi-family
 * model printing "<|tool_call_begin|>assistant" as prose because the server
 * had no tool parsing for its template). Left in history, the debris replays
 * every round-trip and teaches the model to chat instead of act — so it is
 * scrubbed before the turn is recorded, and the first hit per run raises a
 * visible warning naming the model: the ENDPOINT is misconfigured, not the
 * agent. Covers Kimi/DeepSeek tool syntax, ChatML, Llama-3 headers, GLM roles.
 */
const TEMPLATE_SENTINELS =
  /<\|(?:tool_calls?_(?:section_)?(?:begin|end)|tool_call_argument_begin|tool▁(?:calls?|outputs?|sep)(?:▁(?:begin|end))?|im_start|im_end|im_sep|start_header_id|end_header_id|eot_id|eom_id|python_tag|endoftext|end|assistant|user|system|observation|end▁of▁sentence)\|>/giu;

/** Strip leaked sentinels; report the distinct tokens found (empty = clean). */
export function scrubTemplateSentinels(text: string): { text: string; found: string[] } {
  const found = text.match(TEMPLATE_SENTINELS);
  if (!found) return { text, found: [] };
  return {
    text: text.replace(TEMPLATE_SENTINELS, '').replace(/[ \t]+\n/g, '\n').trim(),
    found: [...new Set(found)],
  };
}

const STALL_TIMEOUT_MS = 120_000;
/**
 * Until the FIRST meaningful event of a request the model is prefilling: a
 * 165k-token context on a cloud reasoning model legitimately takes over two
 * minutes before the first delta, and every tool round re-prefills the whole
 * grown history. Seen live: the watchdog killed a coordinator mid-assembly.
 * Mid-stream the tight budget still applies — silence after tokens started
 * flowing really does mean a dead connection.
 */
const FIRST_TOKEN_GRACE_MS = 300_000;

/**
 * A provider that goes silent (queued free-tier model, dead connection, proxy
 * black hole) must not hang the turn forever: when no event arrives for `ms`
 * (`firstMs` before the first meaningful event — prefill budget), abort the
 * underlying request and synthesize error+done so the run ends loudly —
 * instead of the UI spinning "streaming" until the user gives up.
 */
async function* guardStall(
  src: AsyncIterable<ProviderEvent>,
  ms: number,
  firstMs: number,
  abort: () => void,
): AsyncIterable<ProviderEvent> {
  const it = src[Symbol.asyncIterator]();
  // Only MEANINGFUL events extend the deadline. Some gateways trickle empty /
  // whitespace deltas as keep-alives while a queued model produces nothing —
  // those must not keep a dead turn "streaming" forever.
  const meaningful = (e: ProviderEvent): boolean =>
    !((e.type === 'text_delta' || e.type === 'thinking_delta') && e.text.trim() === '');
  let seenMeaningful = false;
  let deadline = Date.now() + firstMs;
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<'stalled'>((resolve) => {
      timer = setTimeout(() => resolve('stalled'), Math.max(0, deadline - Date.now()));
    });
    let winner: 'stalled' | IteratorResult<ProviderEvent>;
    try {
      // race attaches a handler to it.next(), so its post-abort rejection
      // never becomes an unhandled rejection.
      winner = await Promise.race([it.next(), stalled]);
    } catch {
      return; // iterator threw (abort etc.) — session's loop simply ends
    } finally {
      clearTimeout(timer);
    }
    if (winner === 'stalled') {
      abort();
      yield {
        type: 'error',
        error: {
          kind: 'network',
          message:
            `No data from the model for ${Math.round((seenMeaningful ? ms : firstMs) / 1000)}s — ` +
            'the request stalled and was aborted. Send again to retry, or switch models if it ' +
            'keeps happening.',
        },
      };
      yield { type: 'done', stopReason: 'aborted' };
      return;
    }
    if (winner.done) return;
    if (meaningful(winner.value)) {
      seenMeaningful = true;
      deadline = Date.now() + ms;
    }
    yield winner.value;
  }
}

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
  /** Aborts the current provider stream (per turn). */
  private abortCtl: AbortController | null = null;
  /**
   * The CURRENT run's cancel token. Per-run, not a shared boolean: a reset
   * followed immediately by a new send used to clear one shared `cancelled`
   * flag that an older loop — suspended at an await (a pending permission
   * prompt) — was still relying on, so the stale loop resumed and executed
   * into the fresh history. Each runLoop closes over its own token; stop()
   * flips whichever run is active, and a newer run cannot un-cancel an older.
   */
  private activeCancel: { flag: boolean } | null = null;
  /** Aborts the whole run including a running tool — this is what Stop hits. */
  private runAbort: AbortController | null = null;
  private injectQueue: Array<{ id: number; parts: UserPart[] }> = [];
  private nextInjectionId = 1;
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
    if (this.activeCancel) this.activeCancel.flag = true;
    // Abort the in-flight stream AND the run — the latter reaches a hung tool
    // (ws_run launching a GUI app, a wedged MCP call) so Stop always bites.
    this.abortCtl?.abort();
    this.runAbort?.abort();
  }

  /**
   * Every tool_call in the just-streamed assistant turn must have a matching
   * tool result before the loop yields, or the next request opens on an
   * unanswered tool_use and strict providers (Anthropic) 400. On a mid-flight
   * Stop or stream error some calls have not run — stub those. Guarded on the
   * tool_call still being PRESENT in history, so a reset() that cleared the
   * turn leaves the fresh history untouched.
   */
  private sealToolCalls(toolCalls: ReadonlyArray<{ id: string }>): void {
    if (!toolCalls.length) return;
    const present = new Set<string>();
    const answered = new Set<string>();
    for (const m of this.history) {
      if (m.role === 'assistant') {
        for (const p of m.content) if (p.type === 'tool_call') present.add(p.id);
      } else if (m.role === 'tool') {
        answered.add(m.toolCallId);
      }
    }
    for (const tc of toolCalls) {
      if (present.has(tc.id) && !answered.has(tc.id)) {
        this.history.push({
          role: 'tool',
          toolCallId: tc.id,
          content: INTERRUPTED_RESULT,
          isError: true,
        });
      }
    }
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
    const id = this.nextInjectionId++;
    this.injectQueue.push({ id, parts });
    if (mode === 'abort-and-resend') {
      this.stop();
      return { ok: true, injectionId: id };
    }
    return { ok: true, queued: true, injectionId: id };
  }

  /**
   * Remove a still-pending queued injection. False means it's no longer in the
   * queue — already delivered (or never existed) — so the caller must treat
   * the message as sent, not as cancelled.
   */
  cancelInjection(injectionId: number): boolean {
    const idx = this.injectQueue.findIndex((q) => q.id === injectionId);
    if (idx === -1) return false;
    this.injectQueue.splice(idx, 1);
    return true;
  }

  private drainInjectQueue(): void {
    if (this.status !== 'idle') return;
    const next = this.injectQueue.shift();
    if (next) {
      const result = this.send(next.parts);
      if (!result.ok) {
        this.opts.emit(this.id, {
          type: 'error',
          error: { kind: 'unknown', message: `Queued message failed: ${result.error}` },
        });
      }
      this.opts.emit(this.id, {
        type: 'inject_delivered',
        injectionId: next.id,
        ok: result.ok,
      });
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
    const cancel = { flag: false };
    this.activeCancel = cancel;
    const runAbort = new AbortController();
    this.runAbort = runAbort;
    let warnedSentinels = false;
    const maxTurns = this.opts.maxToolTurns ?? 16;
    const stallBudget =
      this.opts.stallTimeoutMs ?? bound.provider.stallTimeoutMs ?? STALL_TIMEOUT_MS;
    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        this.setStatus('streaming');
        const ac = new AbortController();
        this.abortCtl = ac;
        const tools = this.opts.toolExecutor?.tools() ?? [];

        let text = '';
        let thinking = '';
        let thinkingSig: string | undefined;
        const toolCalls: Array<{ id: string; name: string; args: unknown }> = [];
        let wantsTools = false;
        let erred = false;

        for await (const event of guardStall(
          bound.provider.stream(
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
          ),
          stallBudget,
          // An EXPLICIT option is an exact contract (tests, callers that know
          // their model); only default-derived budgets get the prefill grace.
          this.opts.stallTimeoutMs !== undefined
            ? stallBudget
            : Math.max(stallBudget, this.opts.firstEventGraceMs ?? FIRST_TOKEN_GRACE_MS),
          () => ac.abort(),
        )) {
          this.opts.emit(this.id, event);
          switch (event.type) {
            case 'text_delta':
              text += event.text;
              break;
            case 'thinking_delta':
              thinking += event.text;
              break;
            case 'thinking_signature':
              thinkingSig = event.signature;
              break;
            case 'tool_call':
              toolCalls.push({ id: event.id, name: event.name, args: event.args });
              break;
            case 'tool_progress':
              // Heartbeat only: keeps guardStall fed and the UI honest while a
              // big tool call streams its args. Never enters history.
              break;
            case 'done':
              if (event.stopReason === 'aborted') cancel.flag = true;
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

        if (text) {
          const scrubbed = scrubTemplateSentinels(text);
          if (scrubbed.found.length) {
            text = scrubbed.text;
            if (!warnedSentinels) {
              warnedSentinels = true;
              this.opts.emit(this.id, {
                type: 'error',
                error: {
                  kind: 'unknown',
                  message:
                    `Model "${bound.model}" printed raw tool-call template tokens as text ` +
                    `(${scrubbed.found.slice(0, 3).join(' ')}). Its endpoint failed to parse ` +
                    `a tool call — check the server's chat template / tool support. The ` +
                    `tokens were removed from the transcript.`,
                },
              });
            }
          }
        }

        const parts: AssistantPart[] = [];
        if (thinking) parts.push({ type: 'thinking', text: thinking, ...(thinkingSig ? { signature: thinkingSig } : {}) });
        if (text) parts.push({ type: 'text', text });
        for (const tc of toolCalls) parts.push({ type: 'tool_call', ...tc });
        if (parts.length) this.history.push({ role: 'assistant', content: parts });

        if (cancel.flag || erred || !wantsTools) {
          // Bail with the assistant turn well-formed: a Stop or stream error
          // after tool_calls were collected must not leave them unanswered.
          this.sealToolCalls(toolCalls);
          return;
        }

        if (turn === maxTurns - 1) {
          // The model asked for tools we won't run (budget hit). Those tool_call
          // parts are already in history — leaving them without matching results
          // makes the NEXT send malformed for strict providers (Anthropic 400s),
          // so "continue" would fail. Stub a result for each, then pause with an
          // actionable message instead of a dead error.
          for (const tc of toolCalls) {
            this.history.push({
              role: 'tool',
              toolCallId: tc.id,
              content: BUDGET_RESULT,
              isError: true,
            });
            this.opts.emit(this.id, {
              type: 'tool_result',
              callId: tc.id,
              name: tc.name,
              result: BUDGET_RESULT,
              isError: true,
            });
          }
          this.opts.emit(this.id, {
            type: 'error',
            error: {
              kind: 'unknown',
              message:
                `Paused after ${maxTurns} tool steps to check in — this run did a lot of work. ` +
                `Say "continue" to keep going, or tell me what to adjust.`,
            },
          });
          return;
        }

        this.setStatus('awaiting_tool');
        for (const tc of toolCalls) {
          if (cancel.flag) {
            this.sealToolCalls(toolCalls);
            return;
          }
          const decision = this.opts.permission
            ? await this.opts.permission({
                sessionId: this.id,
                callId: tc.id,
                name: tc.name,
                args: tc.args,
              })
            : 'allow';
          if (cancel.flag) {
            this.sealToolCalls(toolCalls);
            return;
          }
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
          let result: {
            content: string;
            isError?: boolean;
            imagePath?: string;
            videoPath?: string;
            audioPath?: string;
          };
          try {
            result = this.opts.toolExecutor
              ? await this.opts.toolExecutor.execute(tc.name, tc.args, runAbort.signal)
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
            ...(result.videoPath ? { videoPath: result.videoPath } : {}),
            ...(result.audioPath ? { audioPath: result.audioPath } : {}),
          });
          // Stop pressed while (or just after) the tool ran — end now instead
          // of feeding the aborted result back for another turn.
          if (cancel.flag) {
            this.sealToolCalls(toolCalls);
            return;
          }
        }
        if (cancel.flag) {
          this.sealToolCalls(toolCalls);
          return;
        }
      }
    } finally {
      this.abortCtl = null;
      this.runAbort = null;
      // Only clear the token if a newer run has not already taken the slot.
      if (this.activeCancel === cancel) this.activeCancel = null;
      this.setStatus('idle');
      // Microtask so the finally block fully unwinds before a queued or
      // injected message starts the next run.
      queueMicrotask(() => this.drainInjectQueue());
    }
  }
}
