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

  it('streams tool-arg chunks as tool_progress heartbeats before the assembled tool_call', async () => {
    // A model writing a whole file into one call produces minutes of arg
    // chunks and nothing else — without heartbeats the stall watchdog kills
    // the healthiest turn of the run (seen live, always mid-assembly).
    const sse =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"ws_write","arguments":"{\\"path\\":"}}]}}]}\n\n' +
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"index.html\\"}"}}]}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
      'data: [DONE]\n\n';
    const p = new XaiProvider({ apiKey: 'test-key', fetch: fetchReturning(sse) });
    const events = await collect(p, { model: 'grok-4', messages: [userText('build')] });
    expect(events).toEqual([
      { type: 'tool_progress', name: 'ws_write', chars: 8 },
      { type: 'tool_progress', name: 'ws_write', chars: 21 },
      { type: 'tool_call', id: 'call_1', name: 'ws_write', args: { path: 'index.html' } },
      { type: 'usage', inputTokens: 0, outputTokens: 0 },
      { type: 'done', stopReason: 'tool_use' },
    ]);
  });

  it('declares a stall budget that covers server-side tool-call buffering', () => {
    // xAI (seen live) sends NOTHING while the model generates a whole tool
    // call — the harness default 120s killed healthy builds at the same spot
    // every time.
    expect(new XaiProvider({ apiKey: 'k' }).stallTimeoutMs).toBeGreaterThanOrEqual(300_000);
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

  it('retries a 429 (busy free endpoint) and succeeds on a later attempt', async () => {
    let calls = 0;
    const ok =
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n';
    const flaky: typeof fetch = (async () => {
      calls += 1;
      if (calls < 3) {
        return new Response('{"detail":"ResourceExhausted: Worker local total request limit reached (48/48)"}', {
          status: 429,
          headers: { 'retry-after': '0.01' },
        });
      }
      return new Response(ok, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const p = new NvidiaProvider({ apiKey: 'nvapi-test', fetch: flaky });
    const events = await collect(p, { model: 'z-ai/glm-5.2', messages: [userText('hi')] });
    expect(calls).toBe(3);
    expect(events).toContainEqual({ type: 'text_delta', text: 'hi' });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
  });

  it('gives up after max attempts with a humanized rate-limit error', async () => {
    let calls = 0;
    const alwaysBusy: typeof fetch = (async () => {
      calls += 1;
      return new Response('{"detail":"ResourceExhausted: limit reached (48/48)"}', {
        status: 429,
        headers: { 'retry-after': '0.01' },
      });
    }) as unknown as typeof fetch;
    const p = new NvidiaProvider({ apiKey: 'nvapi-test', fetch: alwaysBusy });
    const events = await collect(p, { model: 'z-ai/glm-5.2', messages: [userText('hi')] });
    expect(calls).toBe(3);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'rate_limit' } });
    expect(events[0]!.type === 'error' ? events[0]!.error.message : '').toMatch(/rate-limited/i);
  });

  it('does NOT retry a 404 dead model — one call, humanized error, no account id', async () => {
    let calls = 0;
    const dead: typeof fetch = (async () => {
      calls += 1;
      return new Response(
        '{"status":404,"title":"Not Found","detail":"Function \'23d4f03a\' Not found for account \'JTVehpeK-secret\'"}',
        { status: 404 },
      );
    }) as unknown as typeof fetch;
    const p = new NvidiaProvider({ apiKey: 'nvapi-test', fetch: dead });
    const events = await collect(p, {
      model: 'nvidia/nemotron-4-340b-instruct',
      messages: [userText('hi')],
    });
    expect(calls).toBe(1);
    const msg = events[0]!.type === 'error' ? events[0]!.error.message : '';
    expect(msg).toMatch(/not available on this endpoint/i);
    expect(msg).not.toContain('JTVehpeK');
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
