import { describe, expect, it } from 'vitest';
import type { ChatProvider, ChatRequest, ProviderEvent } from '@vo-coder/providers';
import { AgentSession } from '../src/agent/session.ts';
import type { AgentSessionOptions, SessionEvent, ToolExecutor } from '../src/agent/session.ts';

/** Deterministic provider: yields turns[n] on the nth stream call, records requests. */
function scripted(turns: ProviderEvent[][]) {
  const requests: ChatRequest[] = [];
  const provider: ChatProvider = {
    id: 'fake',
    listModels: async () => [],
    stream: async function* (req) {
      requests.push(structuredClone(req));
      const events = turns[Math.min(requests.length - 1, turns.length - 1)]!;
      for (const ev of events) yield ev;
    },
  };
  return { provider, requests };
}

const usage: ProviderEvent = { type: 'usage', inputTokens: 1, outputTokens: 1 };

function makeSession(
  provider: ChatProvider,
  opts: Partial<AgentSessionOptions> = {},
): { session: AgentSession; events: SessionEvent[]; done: Promise<void> } {
  const events: SessionEvent[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const session = new AgentSession({
    id: 's1',
    spec: { id: 'a1', name: 'test-agent' },
    resolve: () => ({ provider, model: 'fake-model' }),
    emit: (_id, ev) => {
      events.push(ev);
      if (ev.type === 'status' && ev.status === 'idle') resolveDone();
    },
    ...opts,
  });
  return { session, events, done };
}

const executor = (impl: Partial<ToolExecutor> = {}): ToolExecutor => ({
  tools: () => [{ name: 'fs__read', description: 'read a file', inputSchema: { type: 'object' } }],
  execute: async () => ({ content: 'file contents' }),
  ...impl,
});

describe('window-as-buffer (contextStart)', () => {
  it('slices the request at the given index while history stays complete', async () => {
    const { provider, requests } = scripted([
      [{ type: 'text_delta', text: 'ok' }, usage, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const { session, done } = makeSession(provider, {
      contextStart: (history) => {
        // Drop everything before the final (just-pushed) user message.
        for (let i = history.length - 1; i >= 0; i--) {
          if (history[i]!.role === 'user') return i;
        }
        return 0;
      },
    });
    // Pre-seed an old conversation the request should NOT replay.
    session.history.push(
      { role: 'user', content: [{ type: 'text', text: 'old question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
    );
    session.send('new question');
    await done;
    // Request carried only the new user turn…
    expect(requests[0]!.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'new question' }] },
    ]);
    // …while the full history (old + new + reply) is intact.
    expect(session.history).toHaveLength(4);
  });

  it('prepareMessages adapts the request without touching history', async () => {
    const { provider, requests } = scripted([
      [{ type: 'text_delta', text: 'ok' }, usage, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const { session, done } = makeSession(provider, {
      prepareMessages: (messages) =>
        messages.map((m) =>
          m.role === 'user'
            ? {
                ...m,
                content: m.content.map((p) =>
                  p.type === 'image' ? ({ type: 'text', text: '[image stub]' } as const) : p,
                ),
              }
            : m,
        ),
    });
    session.history.push({
      role: 'user',
      content: [{ type: 'image', mediaType: 'image/png', data: 'abc' }],
    });
    session.history.push({ role: 'assistant', content: [{ type: 'text', text: 'seen' }] });
    session.send('now change the layout');
    await done;
    // The wire request carries the stub…
    expect(requests[0]!.messages[0]!.content).toEqual([{ type: 'text', text: '[image stub]' }]);
    // …but the real history still holds the image.
    expect(session.history[0]!.content[0]!.type).toBe('image');
  });

  it('absent contextStart keeps full replay', async () => {
    const { provider, requests } = scripted([
      [{ type: 'text_delta', text: 'ok' }, usage, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const { session, done } = makeSession(provider);
    session.history.push({ role: 'user', content: [{ type: 'text', text: 'old' }] });
    session.history.push({ role: 'assistant', content: [{ type: 'text', text: 'reply' }] });
    session.send('new');
    await done;
    expect(requests[0]!.messages).toHaveLength(3);
  });
});

describe('AgentSession loop', () => {
  it('text-only turn: streams, finalizes history, returns to idle', async () => {
    const { provider } = scripted([
      [{ type: 'text_delta', text: 'Hi' }, usage, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const { session, events, done } = makeSession(provider);
    expect(session.send('hello').ok).toBe(true);
    await done;
    expect(session.history).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
    ]);
    expect(events.filter((e) => e.type === 'status').map((e) => e.status)).toEqual([
      'streaming',
      'idle',
    ]);
    expect(session.getStatus()).toBe('idle');
  });

  it('single tool call: executes, feeds result back, continues to final answer', async () => {
    const { provider, requests } = scripted([
      [
        { type: 'tool_call', id: 't1', name: 'fs__read', args: { path: 'a.txt' } },
        usage,
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'text_delta', text: 'It says hi.' }, usage, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const { session, events, done } = makeSession(provider, { toolExecutor: executor() });
    session.send('read a.txt');
    await done;

    expect(session.history).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'read a.txt' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 't1', name: 'fs__read', args: { path: 'a.txt' } }],
      },
      { role: 'tool', toolCallId: 't1', content: 'file contents', isError: undefined },
      { role: 'assistant', content: [{ type: 'text', text: 'It says hi.' }] },
    ]);
    expect(events).toContainEqual({
      type: 'tool_started',
      callId: 't1',
      name: 'fs__read',
      args: { path: 'a.txt' },
    });
    expect(events).toContainEqual({
      type: 'tool_result',
      callId: 't1',
      name: 'fs__read',
      result: 'file contents',
      isError: false,
    });
    // Second request must include the tool result in history and offer tools.
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.some((m) => m.role === 'tool')).toBe(true);
    expect(requests[1]!.tools?.length).toBe(1);
  });

  it('multiple tool calls in one turn execute in order', async () => {
    const calls: string[] = [];
    const { provider } = scripted([
      [
        { type: 'tool_call', id: 't1', name: 'fs__read', args: { path: 'a' } },
        { type: 'tool_call', id: 't2', name: 'fs__read', args: { path: 'b' } },
        usage,
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'text_delta', text: 'done' }, usage, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const { session, done } = makeSession(provider, {
      toolExecutor: executor({
        execute: async (_name, args) => {
          calls.push((args as { path: string }).path);
          return { content: `content of ${(args as { path: string }).path}` };
        },
      }),
    });
    session.send('read both');
    await done;
    expect(calls).toEqual(['a', 'b']);
    const toolMsgs = session.history.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual(['t1', 't2']);
  });

  it('permission deny feeds an error result back to the model', async () => {
    const { provider, requests } = scripted([
      [
        { type: 'tool_call', id: 't1', name: 'fs__read', args: {} },
        usage,
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'text_delta', text: 'Understood.' }, usage, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const { session, events, done } = makeSession(provider, {
      toolExecutor: executor(),
      permission: async () => 'deny',
    });
    session.send('read it');
    await done;
    const toolMsg = session.history.find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({ isError: true });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool_result', isError: true }),
    );
    // No tool_started for a denied call.
    expect(events.some((e) => e.type === 'tool_started')).toBe(false);
    // Model still got a second turn to react to the denial.
    expect(requests).toHaveLength(2);
  });

  it('provider error ends the loop but keeps partial text', async () => {
    const { provider, requests } = scripted([
      [
        { type: 'text_delta', text: 'partial' },
        { type: 'error', error: { kind: 'rate_limit', message: 'slow down' } },
      ],
    ]);
    const { session, done } = makeSession(provider, { toolExecutor: executor() });
    session.send('go');
    await done;
    expect(requests).toHaveLength(1);
    expect(session.history.at(-1)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'partial' }],
    });
    expect(session.getStatus()).toBe('idle');
  });

  it('abort keeps partial content and does not continue tool turns', async () => {
    const { provider, requests } = scripted([
      [
        { type: 'text_delta', text: 'part' },
        { type: 'tool_call', id: 't1', name: 'fs__read', args: {} },
        { type: 'done', stopReason: 'aborted' },
      ],
    ]);
    const { session, done } = makeSession(provider, { toolExecutor: executor() });
    session.send('go');
    await done;
    expect(requests).toHaveLength(1);
    expect(session.history.at(-1)?.role).toBe('assistant');
    expect(session.getStatus()).toBe('idle');
  });

  it('turn cap stops runaway tool loops with an explicit error', async () => {
    const { provider, requests } = scripted([
      [
        { type: 'tool_call', id: 't1', name: 'fs__read', args: {} },
        usage,
        { type: 'done', stopReason: 'tool_use' },
      ],
    ]);
    const { session, events, done } = makeSession(provider, {
      toolExecutor: executor(),
      maxToolTurns: 2,
    });
    session.send('loop forever');
    await done;
    expect(requests).toHaveLength(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({ message: expect.stringContaining('2 tool turns') }),
      }),
    );
  });

  it('rejects sends while busy', async () => {
    const { provider } = scripted([
      [{ type: 'text_delta', text: 'hi' }, usage, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const { session, done } = makeSession(provider);
    session.send('first');
    const second = session.send('second');
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/busy/);
    await done;
  });
});

describe('stall watchdog', () => {
  it('aborts a silent provider and ends the turn with a clear error', async () => {
    let aborted = false;
    const provider: ChatProvider = {
      id: 'fake',
      listModels: async () => [],
      stream: async function* (_req, opts) {
        yield { type: 'text_delta', text: 'partial ' } as ProviderEvent;
        // Then go silent forever — only the abort signal ends the hang.
        await new Promise<void>((resolve) => {
          opts.signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        });
      },
    };
    const { session, events, done } = makeSession(provider, { stallTimeoutMs: 40 });
    session.send('hello');
    await done;
    expect(aborted).toBe(true);
    const err = events.find((e) => e.type === 'error');
    expect(err && err.type === 'error' ? err.error.message : '').toMatch(/stalled/);
    // The partial text survives in history; the session is idle again.
    expect(session.history.at(-1)).toMatchObject({ role: 'assistant' });
    expect(session.getStatus()).toBe('idle');
  });
});

describe('Stop interrupts a hanging tool', () => {
  it('aborts a tool that only resolves on signal, and returns to idle', async () => {
    const { provider } = scripted([
      // Turn 1: ask for a tool. The tool then hangs until Stop aborts it.
      [
        { type: 'tool_call', id: 't1', name: 'fs__read', args: {} },
        usage,
        { type: 'done', stopReason: 'tool_use' },
      ],
    ]);
    let sawAbort = false;
    let started = false;
    const hangingExec: ToolExecutor = {
      tools: () => [{ name: 'fs__read', description: 'read', inputSchema: { type: 'object' } }],
      execute: (_name, _args, signal) =>
        new Promise((resolve) => {
          started = true;
          signal?.addEventListener('abort', () => {
            sawAbort = true;
            resolve({ content: '[stopped by user]', isError: true });
          });
        }),
    };
    const { session, done } = makeSession(provider, { toolExecutor: hangingExec });
    session.send('read the file');
    // Let the tool phase begin, then hit Stop.
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(true);
    session.stop();
    await done;
    expect(sawAbort).toBe(true);
    expect(session.getStatus()).toBe('idle');
  });
});
