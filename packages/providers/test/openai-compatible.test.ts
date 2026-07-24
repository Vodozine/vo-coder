import { describe, expect, it } from 'vitest';
import { NvidiaProvider, XaiProvider } from '../src/adapters/openai-compatible.ts';
import { collect, fetchReturning, fixture, userText } from './helpers.ts';

describe('OpenAI-compatible adapter (via XaiProvider)', () => {
  it('maps reasoning_content deltas to thinking_delta and emits usage + done', async () => {
    const p = new XaiProvider({
      apiKey: 'test-key',
      fetch: fetchReturning(fixture('xai-reasoning.sse.txt')),
    });
    const events = await collect(p, { model: 'grok-4', messages: [userText('hi')] });
    expect(events).toEqual([
      { type: 'thinking_delta', text: 'Weighing the options...' },
      { type: 'text_delta', text: 'Grok' },
      { type: 'text_delta', text: ' here.' },
      { type: 'usage', inputTokens: 9, outputTokens: 4 },
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('normalizes auth failures into a single error event', async () => {
    const p = new XaiProvider({
      apiKey: 'bad-key',
      fetch: fetchReturning('{"error":"Incorrect API key"}', {
        status: 401,
        contentType: 'application/json',
      }),
    });
    const events = await collect(p, { model: 'grok-4', messages: [userText('hi')] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'auth', status: 401 } });
  });

  it('NvidiaProvider has the right id and posts to the NVIDIA NIM endpoint', async () => {
    let seenUrl = '';
    const spy: typeof fetch = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      return fetchReturning('data: [DONE]\n\n')(url, init);
    }) as unknown as typeof fetch;
    const p = new NvidiaProvider({ apiKey: 'nvapi-test', fetch: spy });
    expect(p.id).toBe('nvidia');
    await collect(p, { model: 'meta/llama-3.1-70b-instruct', messages: [userText('hi')] });
    expect(seenUrl).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
  });
});
