import type { TtsOutput, TtsProvider } from '../types.js';

export interface OpenAiTtsOptions {
  apiKey: string;
  baseURL?: string;
  model?: string;
  voice?: string;
  fetch?: typeof fetch;
}

export class OpenAiTts implements TtsProvider {
  readonly id = 'openai-tts';
  private baseURL: string;
  private abort: AbortController | null = null;

  constructor(private opts: OpenAiTtsOptions) {
    this.baseURL = (opts.baseURL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  }

  async speak(text: string): Promise<TtsOutput> {
    this.abort = new AbortController();
    const res = await (this.opts.fetch ?? fetch)(`${this.baseURL}/audio/speech`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.opts.model ?? 'gpt-4o-mini-tts',
        voice: this.opts.voice ?? 'alloy',
        input: text,
        response_format: 'mp3',
      }),
      signal: this.abort.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`TTS failed (${res.status}): ${detail || res.statusText}`);
    }
    const data = new Uint8Array(await res.arrayBuffer());
    return { kind: 'audio', data, mimeType: 'audio/mpeg' };
  }

  stop(): void {
    this.abort?.abort();
  }
}
