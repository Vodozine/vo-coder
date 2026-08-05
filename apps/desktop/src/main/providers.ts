import {
  AnthropicProvider,
  LlamaCppProvider,
  LmStudioProvider,
  NvidiaProvider,
  OllamaProvider,
  OpenAIProvider,
  OpenRouterProvider,
  ProviderRegistry,
  XaiProvider,
} from '@vo-coder/providers';
import type { AppConfig, LocalEndpoint } from '../shared/ipc-contract';
import type { ConfigStore } from './config';
import type { SecretStore } from './secrets';

/**
 * Endpoint names become the "@name" suffix in model ids, so they must be
 * clean slugs: no "@" (the separator), no spaces, lowercase. Applied at
 * registration so a sloppy Settings entry can never poison model ids.
 */
export function endpointSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function activeEndpoints(
  list: LocalEndpoint[] | undefined,
): Array<{ name: string; url: string; contextTokens?: number; keepAlive?: number | 'always' }> {
  return (list ?? [])
    .filter((e) => e.enabled && e.url.trim() && endpointSlug(e.name))
    .map((e) => ({
      name: endpointSlug(e.name),
      url: e.url.trim(),
      ...(e.contextTokens ? { contextTokens: e.contextTokens } : {}),
      ...(e.keepAlive !== undefined ? { keepAlive: e.keepAlive } : {}),
    }));
}

/** Where a model id actually runs — the "@name" suffix picks the box. */
export function endpointUrlFor(cfg: AppConfig, modelId: string): string {
  const at = modelId.lastIndexOf('@');
  if (at > 0) {
    const name = modelId.slice(at + 1);
    const hit = (cfg.ollamaExtraEndpoints ?? []).find((e) => endpointSlug(e.name) === name);
    if (hit) return hit.url.trim().replace(/\/+$/, '');
  }
  return cfg.ollamaBaseUrl.replace(/\/+$/, '');
}

/** The VRAM the user stated for the box a model runs on, in bytes. */
export function endpointVramBytes(cfg: AppConfig, modelId: string): number | undefined {
  const at = modelId.lastIndexOf('@');
  if (at > 0) {
    const name = modelId.slice(at + 1);
    const hit = (cfg.ollamaExtraEndpoints ?? []).find((e) => endpointSlug(e.name) === name);
    if (hit) return hit.vramGb ? hit.vramGb * 1e9 : undefined;
  }
  return cfg.ollamaVramGb ? cfg.ollamaVramGb * 1e9 : undefined;
}

/**
 * Builds a fresh registry on demand so key/config changes take effect on the
 * next request without any restart. Provider clients are stateless and cheap
 * to construct.
 */
export class ProviderHub {
  constructor(
    private config: ConfigStore,
    private secrets: SecretStore,
    /** Subscription OAuth bearer (SuperGrok / X Premium) — preferred over the key. */
    private getXaiOAuthToken?: () => string | null,
    /** Measured window per model id, when the box has been probed. */
    private measuredContext?: (modelId: string) => number | undefined,
  ) {}

  /**
   * True when SuperGrok / X Premium OAuth is the live xAI credential.
   * Grok login is subscription-billed (no per-token API charge) even if an
   * API key is also saved — the hub prefers the OAuth bearer for requests.
   */
  usingXaiOAuth(): boolean {
    return !!this.getXaiOAuthToken?.();
  }

  registry(): ProviderRegistry {
    const reg = new ProviderRegistry();
    const cfg = this.config.get();
    // User can turn a provider off without clearing credentials — useful with auto routing.
    // xAI OAuth (Grok login) and the xAI API key share this same On/Off gate.
    const off = new Set((cfg.disabledProviders ?? []).map((p) => p.toLowerCase()));
    const on = (id: string) => !off.has(id.toLowerCase());
    const anthropicKey = this.secrets.get('anthropic');
    if (on('anthropic') && anthropicKey) reg.register(new AnthropicProvider({ apiKey: anthropicKey }));
    const openaiKey = this.secrets.get('openai');
    if (on('openai') && openaiKey) reg.register(new OpenAIProvider({ apiKey: openaiKey }));
    const openrouterKey = this.secrets.get('openrouter');
    if (on('openrouter') && openrouterKey) reg.register(new OpenRouterProvider({ apiKey: openrouterKey }));
    // Prefer SuperGrok / X Premium bearer; fall back to a saved API key.
    const xaiAuth = this.getXaiOAuthToken?.() ?? this.secrets.get('xai');
    if (on('xai') && xaiAuth) reg.register(new XaiProvider({ apiKey: xaiAuth }));
    const nvidiaKey = this.secrets.get('nvidia');
    if (on('nvidia') && nvidiaKey) reg.register(new NvidiaProvider({ apiKey: nvidiaKey }));
    // Local servers need no key; registered when enabled (they error helpfully if not running).
    if (on('ollama')) {
      reg.register(
        new OllamaProvider({
          baseUrl: cfg.ollamaBaseUrl,
          ...(cfg.ollamaContextTokens ? { contextTokens: cfg.ollamaContextTokens } : {}),
          ...(cfg.ollamaKeepAlive !== undefined ? { keepAlive: cfg.ollamaKeepAlive } : {}),
          extraEndpoints: activeEndpoints(cfg.ollamaExtraEndpoints),
          ...(this.measuredContext ? { measuredContext: this.measuredContext } : {}),
        }),
      );
    }
    if (on('lmstudio')) reg.register(new LmStudioProvider({ baseURL: cfg.lmstudioBaseUrl }));
    const llamacpp = activeEndpoints(cfg.llamacppEndpoints);
    if (on('llamacpp') && llamacpp.length) {
      reg.register(new LlamaCppProvider({ endpoints: llamacpp }));
    }
    return reg;
  }
}
