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
        ...(Number.isFinite(this.opts.speed) && this.opts.speed !== 1
          ? { speed: Math.max(0.5, Math.min(5, this.opts.speed!)) }
          : {}),
      }),
      signal: this.abort.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(humanizeTtsError(res.status, detail || res.statusText, this.opts.model));
    }
    const data = new Uint8Array(await res.arrayBuffer());
    return { kind: 'audio', data, mimeType: 'audio/mpeg' };
  }

  stop(): void {
    this.abort?.abort();
  }
}
