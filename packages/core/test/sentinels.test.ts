import { describe, expect, it } from 'vitest';
import type { ChatProvider, ProviderEvent } from '@vo-coder/providers';
import { AgentSession, scrubTemplateSentinels } from '../src/agent/session.ts';
import type { SessionEvent } from '../src/agent/session.ts';

describe('scrubTemplateSentinels', () => {
  it('strips leaked tool/chat template tokens and reports them', () => {
    const { text, found } = scrubTemplateSentinels(
      'I will fix it now. <|tool_call_begin|>assistant <|tool_call_argument_begin|>{"a":1}<|tool_call_end|>',
    );
    expect(found).toContain('<|tool_call_begin|>');
    expect(text).not.toMatch(/<\|/);
    expect(text).toContain('I will fix it now.');
  });

  it('leaves clean text untouched', () => {
    const clean = 'normal reply with math: a < b || c, and a |> pipe';
    expect(scrubTemplateSentinels(clean)).toEqual({ text: clean, found: [] });
  });
});

describe('sentinel scrub in the run loop', () => {
  it('records scrubbed text in history and warns once', async () => {
    const events: SessionEvent[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const provider: ChatProvider = {
      id: 'fake',
      listModels: async () => [],
      stream: async function* () {
        yield { type: 'text_delta', text: 'On it <|tool_call_begin|>assistant' } as ProviderEvent;
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 } as ProviderEvent;
        yield { type: 'done', stopReason: 'end_turn' } as ProviderEvent;
      },
    };
    const session = new AgentSession({
      id: 's1',
      spec: { id: 'a1', name: 'test-agent' },
      resolve: () => ({ provider, model: 'local-kimi' }),
      emit: (_id, ev) => {
        events.push(ev);
        if (ev.type === 'status' && ev.status === 'idle') resolveDone();
      },
    });
    session.send('go');
    await done;
    const asst = session.history.find((m) => m.role === 'assistant');
    expect(JSON.stringify(asst)).not.toContain('<|');
    expect(JSON.stringify(asst)).toContain('On it');
    const warns = events.filter((e) => e.type === 'error');
    expect(warns).toHaveLength(1);
    expect((warns[0] as { error: { message: string } }).error.message).toContain('local-kimi');
  });
});
