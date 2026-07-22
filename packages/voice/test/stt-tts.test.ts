import { describe, expect, it } from 'vitest';
import { OpenAiStt } from '../src/stt/openai-stt.ts';
import { OpenAiTts } from '../src/tts/openai-tts.ts';

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
  });
});
