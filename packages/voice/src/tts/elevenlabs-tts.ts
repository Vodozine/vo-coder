import type { TtsOutput, TtsProvider } from '../types.js';

export interface ElevenLabsTtsOptions {
  apiKey: string;
  /** Voice id from elevenlabs.io → Voices (e.g. "21m00Tcm4TlvDq8ikWAM"). */
  voiceId: string;
  /** Model id; multilingual v2 is the safe default. */
  model?: string;
  fetch?: typeof fetch;
}

/** ElevenLabs — the de-facto standard for natural TTS voices. */
export class ElevenLabsTts implements TtsProvider {
  readonly id = 'elevenlabs';
  private abort: AbortController | null = null;

  constructor(private opts: ElevenLabsTtsOptions) {}

  async speak(text: string): Promise<TtsOutput> {
    this.abort = new AbortController();
    const res = await (this.opts.fetch ?? fetch)(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.opts.voiceId)}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': this.opts.apiKey,
          'content-type': 'application/json',
          accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: this.opts.model ?? 'eleven_multilingual_v2',
        }),
        signal: this.abort.signal,
      },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`ElevenLabs TTS failed (${res.status}): ${detail.slice(0, 200) || res.statusText}`);
    }
    const data = new Uint8Array(await res.arrayBuffer());
    return { kind: 'audio', data, mimeType: 'audio/mpeg' };
  }

  stop(): void {
    this.abort?.abort();
  }
}
