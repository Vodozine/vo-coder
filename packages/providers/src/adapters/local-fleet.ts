import { LOCAL_STALL_TIMEOUT_MS } from './ollama.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { ChatProvider, ChatRequest, ModelInfo, ProviderEvent } from '../types.js';

/** One local server. Named servers suffix their model ids with "@name". */
export interface LocalFleetEndpoint {
  name: string;
  url: string;
}

export interface LocalFleetOptions {
  /** The unnamed primary server — its models carry no suffix. */
  baseURL?: string;
  /** Extra named servers; their models list as "model@name". */
  extraEndpoints?: LocalFleetEndpoint[];
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

/**
 * These servers speak the OpenAI wire under /v1, but their own UIs show a bare
 * host:port — which people paste, and then every call 404s. Normalizing here
 * means the primary and every extra get the same treatment from one place.
 */
export function v1Base(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * Several boxes of one KIND behind a single provider — a desktop with the big
 * GPU, a laptop serving something small, whatever else is on the LAN. Same
 * shape as Ollama: one unnamed primary plus named extras, and the name is a
 * suffix on every model id from that server. These ids carry "/" and ":"
 * (qwen/qwen3.5-9b, gemma3:4b) but never "@", which is what makes the suffix
 * safe to split on.
 */
export class LocalFleetProvider implements ChatProvider {
  readonly id: string;
  /** Local: silent while loading the model and prefilling — see the Ollama note. */
  readonly stallTimeoutMs = LOCAL_STALL_TIMEOUT_MS;
  /** name → client. The primary is keyed '' and takes no suffix. */
  private clients = new Map<string, OpenAICompatibleProvider>();

  constructor(id: string, defaultBaseURL: string, opts: LocalFleetOptions = {}) {
    this.id = id;
    const client = (url: string) =>
      new OpenAICompatibleProvider(id, {
        // These servers ignore auth; a placeholder bearer keeps the shared
        // client's header shape uniform.
        apiKey: opts.apiKey ?? 'local',
        baseURL: v1Base(url),
        headers: opts.headers,
        fetch: opts.fetch,
      });
    this.clients.set('', client(opts.baseURL ?? defaultBaseURL));
    for (const ep of opts.extraEndpoints ?? []) {
      if (!ep.name || !ep.url.trim()) continue;
      this.clients.set(ep.name, client(ep.url));
    }
  }

  /**
   * Which server a model id names, and the id to send there. An unknown suffix
   * falls back to the primary WITH the id intact — a stale pin then gets LM
   * Studio's own "model not found" rather than a silent wrong-server answer.
   */
  private resolve(modelId: string): { model: string; client: OpenAICompatibleProvider } {
    const at = modelId.lastIndexOf('@');
    if (at > 0) {
      const hit = this.clients.get(modelId.slice(at + 1));
      if (hit) return { model: modelId.slice(0, at), client: hit };
    }
    return { model: modelId, client: this.clients.get('')! };
  }

  async listModels(): Promise<ModelInfo[]> {
    const entries = [...this.clients.entries()];
    const settled = await Promise.allSettled(entries.map(([, c]) => c.listModels()));
    const models: ModelInfo[] = [];
    settled.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      const name = entries[i]![0];
      models.push(
        ...r.value.map((m) =>
          name ? { ...m, id: `${m.id}@${name}`, displayName: `${m.id}@${name}` } : m,
        ),
      );
    });
    // Every server down → surface the primary's real failure; any server
    // answering keeps the provider alive (LAN boxes come and go).
    if (!models.length && settled[0]?.status === 'rejected') {
      throw (settled[0] as PromiseRejectedResult).reason;
    }
    return models;
  }

  async *stream(req: ChatRequest, opts: { signal: AbortSignal }): AsyncIterable<ProviderEvent> {
    const target = this.resolve(req.model);
    yield* target.client.stream({ ...req, model: target.model }, opts);
  }
}

/** LM Studio's local server. */
export class LmStudioProvider extends LocalFleetProvider {
  constructor(opts: LocalFleetOptions = {}) {
    super('lmstudio', 'http://127.0.0.1:1234/v1', { apiKey: 'lm-studio', ...opts });
  }
}

/**
 * FastFlowLM — models running on the laptop's NPU rather than a GPU, so it is
 * a box of its own kind alongside the others. It answers on BOTH wires
 * (OpenAI under /v1 and an Ollama-shaped /api/tags); the OpenAI one is used
 * because that is the path shared with every other local fleet here. Its
 * default port is unusual enough to be worth stating rather than guessing.
 */
export class FlmProvider extends LocalFleetProvider {
  constructor(opts: LocalFleetOptions = {}) {
    super('flm', 'http://127.0.0.1:52625/v1', { apiKey: 'flm', ...opts });
  }
}
