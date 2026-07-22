import { describe, expect, it } from 'vitest';
import type { ChatProvider, ChatRequest, ProviderEvent } from '@vo-coder/providers';
import { AgentSession } from '../src/agent/session.ts';
import type { AgentSessionOptions, SessionEvent } from '../src/agent/session.ts';

/**
 * Abort-aware scripted provider: yields turn events with a microtask gap and
 * honors the AbortSignal between events (like real adapters do), ending with
 * done:aborted.
 */
function abortable(turns: ProviderEvent[][]) {
  const requests: ChatRequest[] = [];
  const provider: ChatProvider = {
    id: 'fake',
    listModels: async () => [],
    stream: async function* (req, opts) {
      requests.push(structuredClone(req));
      const events = turns[Math.min(requests.length - 1, turns.length - 1)]!;
      for (const ev of events) {
        // Macrotask gap so a test's setTimeout(0) can interleave mid-stream.
        await new Promise((r) => setTimeout(r, 0));
        if (opts.signal.aborted) {
          yield { type: 'done', stopReason: 'aborted' };
          return;
        }
        yield ev;
      }
    },
  };
  return { provider, requests };
}

const usage: ProviderEvent = { type: 'usage', inputTokens: 1, outputTokens: 1 };
const textTurn = (text: string): ProviderEvent[] => [
  { type: 'text_delta', text },
  usage,
  { type: 'done', stopReason: 'end_turn' },
];

function harness(
  provider: ChatProvider,
  opts: Partial<AgentSessionOptions> = {},
): {
  session: AgentSession;
  events: SessionEvent[];
  idle: (count: number) => Promise<void>;
} {
  const events: SessionEvent[] = [];
  let idleCount = 0;
  const waiters: Array<{ target: number; resolve: () => void }> = [];
  const session = new AgentSession({
    id: 's1',
    spec: { id: 'a1', name: 'inject-test' },
    resolve: () => ({ provider, model: 'fake-model' }),
    emit: (_id, ev) => {
      events.push(ev);
      if (ev.type === 'status' && ev.status === 'idle') {
        idleCount++;
        for (const w of [...waiters]) {
          if (idleCount >= w.target) {
            w.resolve();
            waiters.splice(waiters.indexOf(w), 1);
          }
        }
      }
    },
    ...opts,
  });
  const idle = (target: number) =>
    idleCount >= target
      ? Promise.resolve()
      : new Promise<void>((resolve) => waiters.push({ target, resolve }));
  return { session, events, idle };
}

describe('mid-task injection', () => {
  it('queue mode holds the message and runs it as the next turn', async () => {
    const { provider, requests } = abortable([textTurn('first answer'), textTurn('second answer')]);
    const { session, idle } = harness(provider, {
      spec: { id: 'a1', name: 't', injectionMode: 'queue' },
    } as Partial<AgentSessionOptions>);

    expect(session.send('first question').ok).toBe(true);
    const injected = session.inject('also consider X');
    expect(injected).toEqual({ ok: true, queued: true });

    await idle(2);
    expect(requests).toHaveLength(2);
    // First run completed untouched; injected message became the next turn.
    expect(session.history.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(session.history[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'first answer' }],
    });
    expect(session.history[2]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'also consider X' }],
    });
  });

  it('abort-and-resend cancels the stream, keeps the partial, and resends', async () => {
    // Turn 1 streams many chunks so the abort lands mid-stream.
    const longTurn: ProviderEvent[] = [
      ...Array.from({ length: 50 }, (_, i) => ({ type: 'text_delta' as const, text: `c${i} ` })),
      usage,
      { type: 'done', stopReason: 'end_turn' },
    ];
    const { provider, requests } = abortable([longTurn, textTurn('revised answer')]);
    const { session, idle } = harness(provider, {
      spec: { id: 'a1', name: 't', injectionMode: 'abort-and-resend' },
    } as Partial<AgentSessionOptions>);

    session.send('long question');
    // Let a few chunks stream before injecting.
    await new Promise((r) => setTimeout(r, 0));
    const result = session.inject('actually, shorter please');
    expect(result.ok).toBe(true);
    expect(result.queued).toBeUndefined();

    await idle(2);
    expect(requests).toHaveLength(2);
    const roles = session.history.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant']);
    // Partial content was kept, not discarded…
    const partial = session.history[1]!;
    expect(partial.role).toBe('assistant');
    const partialText = (partial.content as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(partialText.length).toBeGreaterThan(0);
    expect(partialText).not.toContain('c49'); // …but the stream really was cut short.
    // The second request contains both the partial and the injected message.
    expect(requests[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(session.history[3]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'revised answer' }],
    });
  });

  it('inject on an idle session is just a send', async () => {
    const { provider, requests } = abortable([textTurn('hi')]);
    const { session, idle } = harness(provider);
    expect(session.inject('hello').ok).toBe(true);
    await idle(1);
    expect(requests).toHaveLength(1);
  });

  it('plain stop does not resend anything', async () => {
    const longTurn: ProviderEvent[] = [
      ...Array.from({ length: 50 }, (_, i) => ({ type: 'text_delta' as const, text: `c${i} ` })),
      usage,
      { type: 'done', stopReason: 'end_turn' },
    ];
    const { provider, requests } = abortable([longTurn]);
    const { session, idle } = harness(provider);
    session.send('question');
    await new Promise((r) => setTimeout(r, 0));
    session.stop();
    await idle(1);
    await new Promise((r) => setTimeout(r, 5));
    expect(requests).toHaveLength(1);
    expect(session.getStatus()).toBe('idle');
  });
});
