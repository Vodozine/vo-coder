import type { TtsOutput, TtsProvider } from '../types.js';

/**
 * Speech endpoints answer failures as JSON, and dumping that raw into the chat
 * turns a one-click fix into a puzzle — a Groq model that simply needs its terms
 * accepted read as "the key is not being used".
 */
export function humanizeTtsError(status: number, body: string, model?: string): string {
  let message = '';
  let code = '';
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; code?: string } };
    message = String(parsed.error?.message ?? '').trim();
    code = String(parsed.error?.code ?? '');
  } catch {
    message = body.trim();
  }
  const named = model ? `"${model}"` : 'This model';
  const link = /https?:\/\/\S+?(?=["\s]|$)/.exec(message)?.[0];

  if (code === 'model_terms_required' || /requires terms acceptance/i.test(message)) {
    return (
      `${named} needs its terms accepted once on the provider's site before it will speak` +
      (link ? ` — open ${link}, accept, then try again.` : '. Accept them in the provider console, then try again.')
    );
  }
  if (status === 401 || status === 403) {
    return `The speech endpoint rejected the key (${status}). Check the key saved under Settings → Voice.`;
  }
  if (status === 404 || code === 'model_not_found') {
    return `${named} is not available on this endpoint (404). Pick another from the model list.`;
  }
  if (status === 429) {
    return 'The speech endpoint is rate-limiting (429). Wait a moment and try again.';
  }
  return `Speech failed (${status})${message ? `: ${message}` : ''}`;
}

export interface OpenAiTtsOptions {
  apiKey: string;
  baseURL?: string;
  model?: string;
  voice?: string;
  /**
   * 0.5 … 5, where 1 is the voice's own pace. Sent ONLY when it differs from 1:
   * an endpoint that has never heard of the parameter should not be handed it
   * for a default that changes nothing. (There is no pitch counterpart — no
   * OpenAI-compatible speech API exposes one.)
   */
  speed?: number;
  /** Audio container to ask for. Default mp3, renegotiated if refused. */
  format?: AudioFormat;
  fetch?: typeof fetch;
}

export type AudioFormat = 'mp3' | 'wav' | 'ogg' | 'flac' | 'opus' | 'aac' | 'mulaw' | 'pcm';

const MIME: Record<AudioFormat, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  mulaw: 'audio/basic',
  pcm: 'audio/wav',
};

/**
 * What each endpoint+model turned out to accept. Groq's Orpheus answers only
 * WAV and rejects the mp3 default outright — so the format is negotiated from
 * the refusal ("response_format must be one of [wav]") and remembered, which
 * costs one extra round trip once instead of on every sentence spoken.
 */
const formatMemo = new Map<string, AudioFormat>();

/** Pull the accepted formats out of a 400 and pick the best one we can play. */
export function formatFromRefusal(body: string): AudioFormat | null {
  const list = /response_format must be one of \[([^\]]+)\]/i.exec(body)?.[1];
  if (!list) return null;
  const offered = list
    .split(/[,\s]+/)
    .map((s) => s.replace(/['"]/g, '').trim().toLowerCase())
    .filter(Boolean) as AudioFormat[];
  // Browser-playable first; mulaw/pcm are raw and would need a WAV header.
  const preference: AudioFormat[] = ['mp3', 'wav', 'ogg', 'opus', 'aac', 'flac'];
  return preference.find((p) => offered.includes(p)) ?? offered[0] ?? null;
}

export class OpenAiTts implements TtsProvider {
  readonly id = 'openai-tts';
  private baseURL: string;
  private abort: AbortController | null = null;

  constructor(private opts: OpenAiTtsOptions) {
    this.baseURL = (opts.baseURL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  }

  async speak(text: string): Promise<TtsOutput> {
    const abort = new AbortController();
    this.abort = abort;
    const model = this.opts.model ?? 'gpt-4o-mini-tts';
    const memoKey = `${this.baseURL}|${model}`;
    const post = (format: AudioFormat) =>
      (this.opts.fetch ?? fetch)(`${this.baseURL}/audio/speech`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          voice: this.opts.voice ?? 'alloy',
          input: text,
          response_format: format,
          ...(Number.isFinite(this.opts.speed) && this.opts.speed !== 1
            ? { speed: Math.max(0.5, Math.min(5, this.opts.speed!)) }
            : {}),
        }),
        // Captured, not read off `this`: stop() clears the field, and a
        // renegotiation retry must still be cancellable by the same barge-in.
        signal: abort.signal,
      });

    let format: AudioFormat = formatMemo.get(memoKey) ?? this.opts.format ?? 'mp3';
    let res = await post(format);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // "response_format must be one of [wav]" is an instruction, not a wall.
      const offered = res.status === 400 ? formatFromRefusal(detail) : null;
      if (!offered || offered === format) {
        throw new Error(humanizeTtsError(res.status, detail || res.statusText, model));
      }
      format = offered;
      formatMemo.set(memoKey, format);
      res = await post(format);
      if (!res.ok) {
        const second = await res.text().catch(() => '');
        throw new Error(humanizeTtsError(res.status, second || res.statusText, model));
      }
    } else {
      formatMemo.set(memoKey, format);
    }
    const data = new Uint8Array(await res.arrayBuffer());
    return { kind: 'audio', data, mimeType: MIME[format] ?? 'audio/mpeg' };
  }

  stop(): void {
    this.abort?.abort();
  }
}
