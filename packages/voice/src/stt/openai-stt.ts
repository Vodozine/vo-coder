import type { SttProvider, TranscribeOptions } from '../types.js';

export interface OpenAiSttOptions {
  apiKey: string;
  baseURL?: string;
  /** e.g. 'whisper-1', 'gpt-4o-mini-transcribe' */
  model?: string;
  fetch?: typeof fetch;
}

/** Works against OpenAI or any compatible /audio/transcriptions endpoint. */
export class OpenAiStt implements SttProvider {
  readonly id = 'openai-stt';
  private baseURL: string;
  private model: string;
  private fetchFn: typeof fetch;

  constructor(private opts: OpenAiSttOptions) {
    this.baseURL = (opts.baseURL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.model = opts.model ?? 'whisper-1';
    this.fetchFn = opts.fetch ?? fetch;
  }

  async transcribe(wav: Uint8Array, transcribeOpts?: TranscribeOptions): Promise<string> {
    const form = new FormData();
    // The mic sends WAV, but a Telegram voice note is Opus and an attached clip
    // is whatever the user had. Whisper endpoints sniff the container — they
    // just need to be told the truth about it, and a filename whose extension
    // agrees, which some servers use in place of the type.
    const type = transcribeOpts?.mimeType ?? 'audio/wav';
    const name = transcribeOpts?.fileName ?? 'audio.wav';
    form.append('file', new Blob([wav as unknown as ArrayBuffer], { type }), name);
    form.append('model', this.model);
    form.append('response_format', 'text');
    if (transcribeOpts?.language) form.append('language', transcribeOpts.language);
    const res = await this.fetchFn(`${this.baseURL}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.opts.apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Transcription failed (${res.status}): ${detail || res.statusText}`);
    }
    return (await res.text()).trim();
  }
}
