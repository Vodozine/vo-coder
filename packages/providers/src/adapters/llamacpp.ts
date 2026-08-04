import type { ChatProvider, ChatRequest, ModelInfo, ProviderEvent } from '../types.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

export interface LlamaCppEndpoint {
  /** Short name; becomes the "@name" suffix in this endpoint's model ids. */
  name: string;
  /** OpenAI-compatible base, e.g. http://192.168.1.20:8080/v1 */
  url: string;
}

export interface LlamaCppProviderOptions {
  endpoints: LlamaCppEndpoint[];
  /** Injectable for fixture tests — no network. */
  fetch?: typeof fetch;
}

/**
 * llama.cpp's llama-server speaks the OpenAI wire format, so each endpoint is
 * a thin OpenAI-compatible client. A server typically holds ONE model on ONE
 * GPU, which is the point: every endpoint gets a name, every model id carries
 * it ("qwen3-32b@gpu2"), and an agent pinned to that id always runs on that
 * box. One sub-client per endpoint — never a shared mutable baseURL — so
 * concurrent streams to different GPUs cannot interfere.
 */
export class LlamaCppProvider implements ChatProvider {
  readonly id = 'llamacpp' as const;
  private clients = new Map<string, OpenAICompatibleProvider>();

  constructor(opts: LlamaCppProviderOptions) {
    for (const ep of opts.endpoints) {
      if (!ep.name || !ep.url) continue;
      this.clients.set(
        ep.name,
        new OpenAICompatibleProvider('llamacpp', {
          // llama-server without --api-key ignores auth; a placeholder bearer
          // keeps the shared client's header shape uniform.
          apiKey: 'none',
          baseURL: ep.url,
          fetch: opts.fetch,
        }),
      );
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const entries = [...this.clients.entries()];
    const settled = await Promise.allSettled(entries.map(([, client]) => client.listModels()));
    const models: ModelInfo[] = [];
    settled.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      const name = entries[i][0];
      models.push(
        ...r.value.map((m) => ({ ...m, id: `${m.id}@${name}`, displayName: `${m.id}@${name}` })),
      );
    });
    // Every endpoint down → surface one real failure; any endpoint answering
    // keeps the provider alive (LAN boxes come and go).
    if (!models.length && settled[0]?.status === 'rejected') {
      throw (settled[0] as PromiseRejectedResult).reason;
    }
    return models;
  }

  async *stream(req: ChatRequest, opts: { signal: AbortSignal }): AsyncIterable<ProviderEvent> {
    const at = req.model.lastIndexOf('@');
    const name = at > 0 ? req.model.slice(at + 1) : '';
    const client = this.clients.get(name);
    if (!client) {
      yield {
        type: 'error',
        error: {
          kind: 'bad_request',
          message:
            `No llama.cpp endpoint named "${name || '(none)'}" — model ids look like ` +
            `"model@endpoint"; check Settings → Local model servers.`,
        },
      };
      return;
    }
    yield* client.stream({ ...req, model: req.model.slice(0, at) }, opts);
  }
}
