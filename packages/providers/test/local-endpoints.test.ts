import { describe, expect, it } from 'vitest';
import { LlamaCppProvider } from '../src/adapters/llamacpp.ts';
import { lmStudioBase, LmStudioProvider } from '../src/adapters/lmstudio.ts';
import {
  contextWindow,
  fitContextWindow,
  keepAliveValue,
  OllamaProvider,
} from '../src/adapters/ollama.ts';
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
  const msg = (chars: number): Array<{ content: string }> => [{ content: 'x'.repeat(chars) }];

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

  it('a pinned window is sent verbatim, so the loaded model is never evicted', () => {
    // Sizing per request would reload the model — minutes on slow storage.
    expect(contextWindow(msg(100), {}, 16384)).toEqual({ num_ctx: 16384 });
    expect(contextWindow(msg(500000), {}, 4096)).toEqual({ num_ctx: 4096 });
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

  it('warms the pinned endpoint with the same keep_alive and window a turn uses', async () => {
    let url = '';
    let body: { model?: string; messages?: unknown[]; keep_alive?: string; options?: unknown } = {};
    const p = new OllamaProvider({
      extraEndpoints: [
        { name: 'gpu2', url: 'http://192.168.1.20:11434', contextTokens: 16384 },
      ],
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        url = String(input);
        body = JSON.parse(String(init?.body));
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch,
    });
    await p.warm('llama3:70b@gpu2');
    expect(url).toBe('http://192.168.1.20:11434/api/chat');
    expect(body.model).toBe('llama3:70b');
    // No messages = "just make it resident". A different window or keep_alive
    // than the real turn would reload the model and waste the warm-up.
    expect(body.messages).toEqual([]);
    expect(body.keep_alive).toBe('30m');
    expect(body.options).toEqual({ num_ctx: 16384 });
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

describe('measuring an endpoint so the window can be arithmetic', () => {
  // The real numbers from the user's P40: a 27B at 128k reported total 26.81G
  // against 17.51G of weights, i.e. ~0.071 MB/token — 3.5x LESS than the
  // architecture formula predicts. Measurement is the whole point.
  const GB = 1e9;
  const boxFetch = (over: Record<string, unknown> = {}): typeof fetch =>
    (async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.endsWith('/api/tags')
        ? { models: [{ name: 'big:27b', size: 17.51 * GB, details: { quantization_level: 'IQ4_XS' } }] }
        : url.endsWith('/api/show')
          ? { model_info: { 'qwen35.context_length': 262144 } }
          : {
              models: [
                {
                  name: 'big:27b',
                  size: 26.81 * GB,
                  size_vram: 21.8 * GB,
                  context_length: 131072,
                  ...over,
                },
              ],
            };
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

  it('derives bytes-per-token from the live instance, not the architecture', async () => {
    const p = new OllamaProvider({ fetch: boxFetch() });
    const m = await p.measure('big:27b');
    expect(m.weightsBytes).toBe(17.51 * GB);
    expect(m.quantization).toBe('IQ4_XS');
    expect(m.trainedContext).toBe(262144);
    expect(m.bytesPerToken).toBeCloseTo((26.81 * GB - 17.51 * GB) / 131072, 0);
    expect(m.spilled).toBe(true); // 21.8G of 26.81G on the card
  });

  it('reports what it can when the model is not loaded, without erroring', async () => {
    const p = new OllamaProvider({
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/ps')) return new Response('{"models":[]}');
        if (url.endsWith('/api/tags')) {
          return new Response(JSON.stringify({ models: [{ name: 'm', size: 5e9 }] }));
        }
        return new Response('{}');
      }) as unknown as typeof fetch,
    });
    const m = await p.measure('m');
    expect(m.weightsBytes).toBe(5e9);
    expect(m.bytesPerToken).toBeUndefined();
  });

  it('measures a sleeping box as unknown rather than throwing', async () => {
    const p = new OllamaProvider({
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    await expect(p.measure('m')).resolves.toEqual({});
  });

  it('picks the largest bucket that fits, never one that spills', () => {
    const m = { weightsBytes: 17.51 * GB, bytesPerToken: 71000, trainedContext: 262144 };
    // 22.5G card: (22.5*0.9 - 17.51)G / 71000 ≈ 38k tokens → 32k, not 64k.
    expect(fitContextWindow(m, 22.5 * GB)).toBe(32768);
    // A 48G card has room for far more, but never past the trained ceiling.
    expect(fitContextWindow({ ...m, trainedContext: 32768 }, 48 * GB)).toBe(32768);
  });

  it('declines to choose when the box has not said enough', () => {
    expect(fitContextWindow({ weightsBytes: 5e9 }, 8e9)).toBeNull();
    expect(fitContextWindow({ weightsBytes: 5e9, bytesPerToken: 100 }, undefined)).toBeNull();
    // Weights alone exceed the card — there is no window to choose.
    expect(fitContextWindow({ weightsBytes: 20e9, bytesPerToken: 100 }, 8e9)).toBeNull();
  });
});

describe('keep-alive is the endpoint owner’s choice', () => {
  it('maps minutes and always-on to Ollama’s wire form', () => {
    expect(keepAliveValue(5)).toBe('5m');
    expect(keepAliveValue(240)).toBe('240m');
    expect(keepAliveValue('always')).toBe(-1);
    expect(keepAliveValue(undefined)).toBe('30m');
  });

  it('sends the endpoint’s own value on both warm and stream', async () => {
    const seen: Array<string | number> = [];
    const p = new OllamaProvider({
      keepAlive: 5,
      extraEndpoints: [{ name: 'gpu2', url: 'http://box:11434', keepAlive: 'always' }],
      fetch: (async (_i: RequestInfo | URL, init?: RequestInit) => {
        seen.push((JSON.parse(String(init?.body)) as { keep_alive: string }).keep_alive);
        return new Response(fixture('ollama-basic.ndjson.txt'), {
          headers: { 'content-type': 'application/x-ndjson' },
        });
      }) as unknown as typeof fetch,
    });
    await p.warm('m');
    await p.warm('m@gpu2');
    await collect(p, { model: 'm@gpu2', messages: [userText('hi')] });
    expect(seen).toEqual(['5m', -1, -1]);
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

describe('LmStudioProvider — several boxes behind one provider', () => {
  const modelsBody = (id: string) => JSON.stringify({ data: [{ id }] });

  it('normalizes a pasted host:port to /v1 for the primary and every extra', () => {
    // LM Studio's own UI shows a bare host:port, so that is what people paste.
    expect(lmStudioBase('http://192.168.1.102:1234')).toBe('http://192.168.1.102:1234/v1');
    expect(lmStudioBase('http://192.168.1.102:1234/')).toBe('http://192.168.1.102:1234/v1');
    expect(lmStudioBase('  http://192.168.1.102:1234/v1  ')).toBe('http://192.168.1.102:1234/v1');
    // Already-versioned URLs are left alone rather than gaining a second /v1.
    expect(lmStudioBase('http://box:1234/v2')).toBe('http://box:1234/v2');
  });

  it('leaves the primary unsuffixed and tags every extra with @name', async () => {
    const p = new LmStudioProvider({
      baseURL: 'http://192.168.1.102:1234',
      extraEndpoints: [{ name: 'laptop', url: 'http://127.0.0.1:1234' }],
      fetch: fetchRouting({
        'http://192.168.1.102:1234/v1/models': { body: modelsBody('qwen/qwen3.5-9b') },
        'http://127.0.0.1:1234/v1/models': { body: modelsBody('google/gemma-4-e2b') },
      }),
    });
    const ids = (await p.listModels()).map((m) => m.id);
    // Model ids carry "/" and must survive it — only the "@" is a pin.
    expect(ids).toEqual(['qwen/qwen3.5-9b', 'google/gemma-4-e2b@laptop']);
  });

  it('keeps answering while one box is asleep', async () => {
    const p = new LmStudioProvider({
      baseURL: 'http://192.168.1.102:1234',
      extraEndpoints: [{ name: 'laptop', url: 'http://127.0.0.1:1234' }],
      fetch: fetchRouting({
        'http://192.168.1.102:1234/v1/models': { body: modelsBody('qwen/qwen3.5-9b') },
        'http://127.0.0.1:1234/v1/models': new TypeError('fetch failed'),
      }),
    });
    expect((await p.listModels()).map((m) => m.id)).toEqual(['qwen/qwen3.5-9b']);
  });

  it('streams to the pinned box with the suffix stripped', async () => {
    let sawUrl = '';
    let sawModel = '';
    const sse = fixture('xai-reasoning.sse.txt');
    const p = new LmStudioProvider({
      baseURL: 'http://192.168.1.102:1234',
      extraEndpoints: [{ name: 'laptop', url: 'http://127.0.0.1:1234' }],
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        sawUrl = String(input);
        sawModel = (JSON.parse(String(init?.body)) as { model: string }).model;
        return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
      }) as unknown as typeof fetch,
    });
    await collect(p, { model: 'google/gemma-4-e2b@laptop', messages: [userText('hi')] });
    expect(sawUrl).toBe('http://127.0.0.1:1234/v1/chat/completions');
    expect(sawModel).toBe('google/gemma-4-e2b');
  });

  it('sends an unpinned id to the primary, id intact', async () => {
    let sawUrl = '';
    let sawModel = '';
    const sse = fixture('xai-reasoning.sse.txt');
    const p = new LmStudioProvider({
      baseURL: 'http://192.168.1.102:1234',
      extraEndpoints: [{ name: 'laptop', url: 'http://127.0.0.1:1234' }],
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        sawUrl = String(input);
        sawModel = (JSON.parse(String(init?.body)) as { model: string }).model;
        return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
      }) as unknown as typeof fetch,
    });
    await collect(p, { model: 'qwen/qwen3.5-9b', messages: [userText('hi')] });
    expect(sawUrl).toBe('http://192.168.1.102:1234/v1/chat/completions');
    expect(sawModel).toBe('qwen/qwen3.5-9b');
  });

  it('falls back to the primary on a stale pin, keeping the id whole', async () => {
    // A leftover "@gpu3" from an Ollama id must not be silently stripped and
    // answered by the wrong box — LM Studio's own 404 says what is missing.
    let sawModel = '';
    const sse = fixture('xai-reasoning.sse.txt');
    const p = new LmStudioProvider({
      baseURL: 'http://192.168.1.102:1234',
      fetch: (async (_i: RequestInfo | URL, init?: RequestInit) => {
        sawModel = (JSON.parse(String(init?.body)) as { model: string }).model;
        return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
      }) as unknown as typeof fetch,
    });
    await collect(p, { model: 'qwen3.5:latest@gpu3', messages: [userText('hi')] });
    expect(sawModel).toBe('qwen3.5:latest@gpu3');
  });
});

describe('a local server can say what its model does', () => {
  it('reads capabilities from the pinned endpoint', async () => {
    let sawUrl = '';
    let sawModel = '';
    const p = new OllamaProvider({
      extraEndpoints: [{ name: 'gpu2', url: 'http://box:11434' }],
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        sawUrl = String(input);
        sawModel = (JSON.parse(String(init?.body)) as { model: string }).model;
        return new Response(JSON.stringify({ capabilities: ['tools', 'completion', 'vision'] }), {
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });
    expect(await p.capabilities('gemma-4-e4b@gpu2')).toEqual(['tools', 'completion', 'vision']);
    expect(sawUrl).toBe('http://box:11434/api/show');
    expect(sawModel).toBe('gemma-4-e4b'); // the pin is an address, not part of the name
  });

  it('a sleeping box measures as unknown, never as an error', async () => {
    const p = new OllamaProvider({
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    expect(await p.capabilities('anything')).toEqual([]);
  });

  it('survives a server that answers without the field', async () => {
    const p = new OllamaProvider({
      fetch: (async () =>
        new Response(JSON.stringify({ model_info: {} }), {
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    });
    expect(await p.capabilities('old-server-model')).toEqual([]);
  });
});
