import {
  AnthropicProvider,
  LmStudioProvider,
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

  registry(): ProviderRegistry {
    const reg = new ProviderRegistry();
    const anthropicKey = this.secrets.get('anthropic');
    if (anthropicKey) reg.register(new AnthropicProvider({ apiKey: anthropicKey }));
    const openaiKey = this.secrets.get('openai');
    if (openaiKey) reg.register(new OpenAIProvider({ apiKey: openaiKey }));
    const openrouterKey = this.secrets.get('openrouter');
    if (openrouterKey) reg.register(new OpenRouterProvider({ apiKey: openrouterKey }));
    const xaiAuth = this.getXaiOAuthToken?.() ?? this.secrets.get('xai');
    if (xaiAuth) reg.register(new XaiProvider({ apiKey: xaiAuth }));
    // Local servers need no key; always registered (they error helpfully if not running).
    reg.register(new OllamaProvider({ baseUrl: this.config.get().ollamaBaseUrl }));
    reg.register(new LmStudioProvider({ baseURL: this.config.get().lmstudioBaseUrl }));
    return reg;
  }
}
