import { describe, expect, it } from 'vitest';
import { OpenAiStt } from '../src/stt/openai-stt.ts';
import { humanizeTtsError, OpenAiTts } from '../src/tts/openai-tts.ts';

describe('OpenAiStt', () => {
  it('posts multipart WAV and returns trimmed text', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response('  hello from voice \n', { status: 200 });
    }) as unknown as typeof fetch;

    const stt = new OpenAiStt({ apiKey: 'k', model: 'whisper-1', fetch: fetchFn });
    const text = await stt.transcribe(new Uint8Array([1, 2, 3]));
    expect(text).toBe('hello from voice');
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    const form = calls[0]!.init.body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('response_format')).toBe('text');
    expect((form.get('file') as Blob).type).toBe('audio/wav');
  });

  it('surfaces provider errors with status and detail', async () => {
    const fetchFn = (async () =>
      new Response('{"error":"bad audio"}', { status: 400 })) as unknown as typeof fetch;
    const stt = new OpenAiStt({ apiKey: 'k', fetch: fetchFn });
    await expect(stt.transcribe(new Uint8Array())).rejects.toThrow(/400.*bad audio/s);
  });
});

describe('OpenAiTts', () => {
  it('requests mp3 synthesis and returns audio bytes', async () => {
    const calls: Array<{ init: RequestInit }> = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      calls.push({ init: init ?? {} });
      return new Response(new Uint8Array([9, 9, 9]).buffer, { status: 200 });
    }) as unknown as typeof fetch;

    const tts = new OpenAiTts({ apiKey: 'k', voice: 'nova', fetch: fetchFn });
    const out = await tts.speak('hello');
    expect(out).toMatchObject({ kind: 'audio', mimeType: 'audio/mpeg' });
    if (out.kind === 'audio') expect([...out.data]).toEqual([9, 9, 9]);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ voice: 'nova', input: 'hello', response_format: 'mp3' });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer k');
  });

  it('sends speed only when it is not the default', async () => {
    const bodies: string[] = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(new Uint8Array([1]).buffer, { status: 200 });
    }) as unknown as typeof fetch;

    // 1 changes nothing, and an endpoint that never heard of the parameter
    // should not have to ignore it.
    await new OpenAiTts({ apiKey: 'k', speed: 1, fetch: fetchFn }).speak('a');
    expect(JSON.parse(bodies[0]!)).not.toHaveProperty('speed');

    await new OpenAiTts({ apiKey: 'k', speed: 1.35, fetch: fetchFn }).speak('a');
    expect(JSON.parse(bodies[1]!).speed).toBe(1.35);

    // Groq's documented range is 0.5 … 5.
    await new OpenAiTts({ apiKey: 'k', speed: 12, fetch: fetchFn }).speak('a');
    expect(JSON.parse(bodies[2]!).speed).toBe(5);
    await new OpenAiTts({ apiKey: 'k', speed: 0.1, fetch: fetchFn }).speak('a');
    expect(JSON.parse(bodies[3]!).speed).toBe(0.5);
  });

  it('turns a provider failure into something actionable', async () => {
    // Groq's real answer for a model whose terms have not been accepted — it
    // used to reach the chat as raw JSON, which read like a missing key.
    const terms = JSON.stringify({
      error: {
        message:
          'The model `canopylabs/orpheus-v1-english` requires terms acceptance. Please have the org admin accept the terms at https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english',
        type: 'invalid_request_error',
        code: 'model_terms_required',
      },
    });
    expect(humanizeTtsError(400, terms, 'canopylabs/orpheus-v1-english')).toBe(
      '"canopylabs/orpheus-v1-english" needs its terms accepted once on the provider\'s site before it will speak — open https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english, accept, then try again.',
    );
    expect(humanizeTtsError(401, '{"error":{"message":"Invalid API Key"}}')).toMatch(/rejected the key/);
    expect(humanizeTtsError(404, '{"error":{"code":"model_not_found"}}', 'kokoro')).toMatch(
      /"kokoro" is not available/,
    );
    expect(humanizeTtsError(500, 'upstream exploded')).toBe('Speech failed (500): upstream exploded');
  });
});
