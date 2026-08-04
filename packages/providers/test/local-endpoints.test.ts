import { describe, expect, it } from 'vitest';
import { LlamaCppProvider } from '../src/adapters/llamacpp.ts';
import { contextWindow, OllamaProvider } from '../src/adapters/ollama.ts';
import { collect, fixture, userText } from './helpers.ts';

/** A fetch stub that routes by URL prefix, so each endpoint answers differently. */
function fetchRouting(
  routes: Record<string, { body: string; status?: number } | Error>,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) throw new TypeError(`fetch failed (no route for ${url})`);
    const [, r] = hit;
    if (r instanceof Error) throw r;
    return new Response(r.body, {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const tags = (...names: string[]) => JSON.stringify({ models: names.map((name) => ({ name })) });

describe('OllamaProvider with extra endpoints', () => {
  it('merges endpoint model lists, suffixing extras with @name', async () => {
    const p = new OllamaProvider({
      baseUrl: 'http://127.0.0.1:11434',
      extraEndpoints: [
        { name: 'gpu2', url: 'http://192.168.1.20:11434' },
        { name: 'gpu3', url: 'http://192.168.1.30:11434' },
      ],
      fetch: fetchRouting({
        'http://127.0.0.1:11434': { body: tags('llama3.2') },
        'http://192.168.1.20:11434': { body: tags('llama3:70b') },
        'http://192.168.1.30:11434': new TypeError('fetch failed'), // box is off
      }),
    });
    const ids = (await p.listModels()).map((m) => m.id);
    expect(ids).toEqual(['llama3.2', 'llama3:70b@gpu2']);
  });

  it('routes a pinned model to its endpoint with the suffix stripped', async () => {
    let sawUrl = '';
    let sawModel = '';
    const p = new OllamaProvider({
      baseUrl: 'http://127.0.0.1:11434',
      extraEndpoints: [{ name: 'gpu2', url: 'http://192.168.1.20:11434' }],
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        sawUrl = String(input);
        sawModel = (JSON.parse(String(init?.body)) as { model: string }).model;
        return new Response(fixture('ollama-basic.ndjson.txt'), {
          headers: { 'content-type': 'application/x-ndjson' },
        });
      }) as unknown as typeof fetch,
    });
    const events = await collect(p, { model: 'llama3:70b@gpu2', messages: [userText('hi')] });
    expect(sawUrl).toBe('http://192.168.1.20:11434/api/chat');
    expect(sawModel).toBe('llama3:70b');
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
  });

  it('falls back to the primary server for unknown or absent suffixes', async () => {
    let sawUrl = '';
    const p = new OllamaProvider({
      extraEndpoints: [{ name: 'gpu2', url: 'http://192.168.1.20:11434' }],
      fetch: (async (input: RequestInfo | URL) => {
        sawUrl = String(input);
        return new Response(fixture('ollama-basic.ndjson.txt'), {
          headers: { 'content-type': 'application/x-ndjson' },
        });
      }) as unknown as typeof fetch,
    });
    await collect(p, { model: 'llama3:70b@gone', messages: [userText('hi')] });
    expect(sawUrl).toBe('http://127.0.0.1:11434/api/chat');
  });

  it('names the endpoint in network errors', async () => {
    const p = new OllamaProvider({
      extraEndpoints: [{ name: 'gpu2', url: 'http://192.168.1.20:11434' }],
      fetch: fetchRouting({}),
    });
    const events = await collect(p, { model: 'x@gpu2', messages: [userText('hi')] });
    expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'network' } });
    expect((events[0] as { error: { message: string } }).error.message).toContain('(gpu2)');
    expect((events[0] as { error: { message: string } }).error.message).toContain(
      'http://192.168.1.20:11434',
    );
  });
});

describe('contextWindow sizing (Ollama truncates silently at server num_ctx)', () => {
  const msg = (chars: number) => [{ content: 'x'.repeat(chars) }];

  it('leaves the server default alone when the prompt fits', () => {
    expect(contextWindow(msg(1000), {})).toEqual({});
  });

  it('buckets oversized prompts coarsely so the model is not reloaded per turn', () => {
    expect(contextWindow(msg(9000), {})).toEqual({ num_ctx: 8192 });
    expect(contextWindow(msg(30000), {})).toEqual({ num_ctx: 16384 });
    expect(contextWindow(msg(500000), {})).toEqual({ num_ctx: 32768 });
  });

  it('counts tool definitions toward the window', () => {
    expect(contextWindow(msg(100), { tools: [{ big: 'y'.repeat(20000) }] })).toEqual({
      num_ctx: 8192,
    });
  });

  it('keeps the model resident between messages', async () => {
    let body: { keep_alive?: string } = {};
    const p = new OllamaProvider({
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as { keep_alive?: string };
        return new Response(fixture('ollama-basic.ndjson.txt'), {
          headers: { 'content-type': 'application/x-ndjson' },
        });
      }) as unknown as typeof fetch,
    });
    await collect(p, { model: 'llama3.2', messages: [userText('hi')] });
    // Ollama's own default unloads after 5 minutes; a resumed chat would then
    // pay the whole model load again.
    expect(body.keep_alive).toBe('30m');
  });

  it('claims a stall budget large enough to cover model load + prefill', () => {
    expect(new OllamaProvider().stallTimeoutMs).toBeGreaterThanOrEqual(300_000);
    expect(new LlamaCppProvider({ endpoints: [] }).stallTimeoutMs).toBeGreaterThanOrEqual(300_000);
  });

  it('is sent on the wire for an agent-sized prompt', async () => {
    let sawOptions: { num_ctx?: number } = {};
    const p = new OllamaProvider({
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        sawOptions = (JSON.parse(String(init?.body)) as { options: { num_ctx?: number } }).options;
        return new Response(fixture('ollama-basic.ndjson.txt'), {
          headers: { 'content-type': 'application/x-ndjson' },
        });
      }) as unknown as typeof fetch,
    });
    await collect(p, {
      model: 'qwen2:7b-instruct',
      system: 'agent prompt '.repeat(2000),
      messages: [userText('hello')],
    });
    expect(sawOptions.num_ctx).toBe(16384);
  });
});

describe('LlamaCppProvider', () => {
  const modelsBody = (id: string) => JSON.stringify({ data: [{ id }] });

  it('lists every endpoint model as model@endpoint', async () => {
    const p = new LlamaCppProvider({
      endpoints: [
        { name: 'gpu2', url: 'http://192.168.1.20:8080/v1' },
        { name: 'gpu3', url: 'http://192.168.1.30:8080/v1' },
      ],
      fetch: fetchRouting({
        'http://192.168.1.20:8080/v1/models': { body: modelsBody('qwen3-32b') },
        'http://192.168.1.30:8080/v1/models': new TypeError('fetch failed'),
      }),
    });
    const ids = (await p.listModels()).map((m) => m.id);
    expect(ids).toEqual(['qwen3-32b@gpu2']);
  });

  it('streams through the pinned endpoint with the bare model id', async () => {
    let sawUrl = '';
    let sawModel = '';
    const sse = fixture('xai-reasoning.sse.txt'); // any OpenAI-wire SSE stream works
    const p = new LlamaCppProvider({
      endpoints: [{ name: 'gpu2', url: 'http://192.168.1.20:8080/v1' }],
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        sawUrl = String(input);
        sawModel = (JSON.parse(String(init?.body)) as { model: string }).model;
        return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
      }) as unknown as typeof fetch,
    });
    const events = await collect(p, { model: 'qwen3-32b@gpu2', messages: [userText('hi')] });
    expect(sawUrl).toBe('http://192.168.1.20:8080/v1/chat/completions');
    expect(sawModel).toBe('qwen3-32b');
    expect(events.at(-1)?.type).toBe('done');
  });

  it('yields a clear error for an unknown endpoint pin', async () => {
    const p = new LlamaCppProvider({
      endpoints: [{ name: 'gpu2', url: 'http://192.168.1.20:8080/v1' }],
    });
    const events = await collect(p, { model: 'qwen3-32b@gone', messages: [userText('hi')] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'bad_request' } });
    expect((events[0] as { error: { message: string } }).error.message).toContain('"gone"');
  });
});
