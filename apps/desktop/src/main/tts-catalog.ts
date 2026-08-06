/**
 * What does this OpenAI-compatible speech endpoint actually offer?
 *
 * Typing a model id and a voice name by hand is how you end up sending
 * `canopylabs/orpheus-v1-english` — backticks and all — and reading a 404 that
 * says the model does not exist. So the endpoint is asked instead:
 *
 *   GET {base}/models        every server has it (OpenAI-compatible by definition)
 *   GET {base}/audio/voices  Kokoro-FastAPI and friends; absent on Groq/OpenAI
 *
 * When a server has no voice endpoint, the voices come from what the model id
 * is known to carry. Unknown model, no list — the field stays free text rather
 * than pretending.
 */

/** Paste-damage: backticks from docs, quotes, stray spaces. */
export function cleanIdentifier(raw: string | undefined): string {
  return String(raw ?? '')
    .trim()
    .replace(/^[`'"<]+|[`'">]+$/g, '')
    .trim();
}

/** Voices that ship with a model family, when the server cannot be asked. */
const KNOWN_VOICES: Array<{ match: RegExp; voices: string[] }> = [
  // Groq / Canopy Labs Orpheus (console.groq.com/docs/text-to-speech/orpheus)
  { match: /orpheus.*(arabic|saudi)/i, voices: ['abdullah', 'fahad', 'sultan', 'lulwa', 'noura', 'aisha'] },
  { match: /orpheus/i, voices: ['autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy'] },
  // OpenAI's own speech models — the de-facto default for compatible servers.
  {
    match: /^(tts-1|tts-1-hd|gpt-4o-mini-tts|gpt-4o-audio)/i,
    voices: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'],
  },
];

function voicesForModel(id: string): string[] {
  return KNOWN_VOICES.find((k) => k.match.test(id))?.voices ?? [];
}

/** A model id worth offering for SPEECH — chat and transcription ids are noise. */
function looksLikeSpeech(id: string): boolean {
  return /tts|speech|orpheus|playai|kokoro|xtts|piper|bark|chatterbox|voice|audio/i.test(id);
}

export interface CompatCatalog {
  ok: boolean;
  models: string[];
  voicesFor: Record<string, string[]>;
  error?: string;
}

export async function fetchCompatCatalog(
  rawBaseUrl: string,
  apiKey: string | null,
  fetchFn: typeof fetch = fetch,
): Promise<CompatCatalog> {
  const base = cleanIdentifier(rawBaseUrl).replace(/\/+$/, '');
  if (!base) return { ok: false, models: [], voicesFor: {}, error: 'No base URL yet.' };
  const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};

  let models: string[] = [];
  try {
    const res = await fetchFn(`${base}/models`, { headers });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return {
        ok: false,
        models: [],
        voicesFor: {},
        error:
          res.status === 401 || res.status === 403
            ? 'The endpoint rejected the key — save a valid one below.'
            : `${base}/models answered ${res.status}. ${detail.slice(0, 160)}`,
      };
    }
    const json = (await res.json()) as { data?: Array<{ id?: string }> } | Array<{ id?: string }>;
    const list = Array.isArray(json) ? json : (json.data ?? []);
    models = list.map((m) => String(m?.id ?? '')).filter(Boolean);
  } catch (err) {
    return {
      ok: false,
      models: [],
      voicesFor: {},
      error: `Could not reach ${base} — ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Groq lists chat and transcription models beside the speech ones. Narrow to
  // speech, but never to nothing: an unusual server keeps its whole list.
  const speech = models.filter(looksLikeSpeech);
  const offered = speech.length ? speech : models;

  // One shared voice list if the server publishes one (Kokoro-FastAPI, LiteLLM).
  let serverVoices: string[] = [];
  try {
    const res = await fetchFn(`${base}/audio/voices`, { headers });
    if (res.ok) {
      const json = (await res.json()) as { voices?: unknown } | unknown[];
      const raw = Array.isArray(json) ? json : ((json as { voices?: unknown }).voices ?? []);
      if (Array.isArray(raw)) {
        serverVoices = raw
          .map((v) => (typeof v === 'string' ? v : String((v as { id?: string })?.id ?? '')))
          .filter(Boolean);
      }
    }
  } catch {
    /* No voices endpoint is the norm, not a failure. */
  }

  const voicesFor: Record<string, string[]> = {};
  for (const id of offered) {
    const known = voicesForModel(id);
    const list = serverVoices.length ? serverVoices : known;
    if (list.length) voicesFor[id] = list;
  }

  return { ok: true, models: offered, voicesFor };
}
