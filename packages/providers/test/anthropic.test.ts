import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../src/adapters/anthropic.ts';
import { collect, fetchReturning, fixture, userText } from './helpers.ts';

function provider(fixtureName: string, init?: { status?: number; contentType?: string }) {
  return new AnthropicProvider({
    apiKey: 'test-key',
    fetch: fetchReturning(fixture(fixtureName), init),
  });
}

const req = { model: 'claude-sonnet-5', messages: [userText('hi')] };

describe('AnthropicProvider event normalization', () => {
  it('normalizes a plain text stream', async () => {
    const events = await collect(provider('anthropic-basic.sse.txt'), req);
    expect(events).toEqual([
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ' world' },
      { type: 'usage', inputTokens: 12, outputTokens: 5 },
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('accumulates input_json_delta into a single tool_call', async () => {
    const events = await collect(provider('anthropic-tooluse.sse.txt'), req);
    expect(events).toEqual([
      { type: 'text_delta', text: 'Let me check.' },
      { type: 'tool_call', id: 'toolu_01', name: 'get_weather', args: { city: 'Paris' } },
      { type: 'usage', inputTokens: 30, outputTokens: 18 },
      { type: 'done', stopReason: 'tool_use' },
    ]);
  });

  it('surfaces thinking deltas alongside text', async () => {
    const events = await collect(provider('anthropic-thinking.sse.txt'), req);
    expect(events).toEqual([
      { type: 'thinking_delta', text: 'Considering the question...' },
      { type: 'text_delta', text: 'The answer is 4.' },
      { type: 'usage', inputTokens: 20, outputTokens: 12 },
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('normalizes auth failures into a single error event', async () => {
    const p = new AnthropicProvider({
      apiKey: 'bad-key',
      fetch: fetchReturning(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' },
        }),
        { status: 401, contentType: 'application/json' },
      ),
    });
    const events = await collect(p, req);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'auth', status: 401 } });
  });
});
