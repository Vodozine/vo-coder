import {
  AnthropicProvider,
  LmStudioProvider,
  NvidiaProvider,
  OllamaProvider,
  OpenAIProvider,
  OpenRouterProvider,
  ProviderRegistry,
  XaiProvider,
} from '@vo-coder/providers';
import type { ConfigStore } from './config';
import type { SecretStore } from './secrets';

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
    if (on('ollama')) reg.register(new OllamaProvider({ baseUrl: cfg.ollamaBaseUrl }));
    if (on('lmstudio')) reg.register(new LmStudioProvider({ baseURL: cfg.lmstudioBaseUrl }));
    return reg;
  }
}
