import {
  AnthropicProvider,
  FlmProvider,
  GeminiProvider,
  LlamaCppProvider,
  LmStudioProvider,
  NvidiaProvider,
  OllamaProvider,
  OpenAIProvider,
  OpenRouterProvider,
  ProviderRegistry,
  XaiProvider,
  ZaiProvider,
} from '@vo-coder/providers';
import type { ChatProvider } from '@vo-coder/providers';
import type { AppConfig, LocalEndpoint } from '../shared/ipc-contract';
import {
  ClaudeCodeCliProvider,
  type CliSessionBinding,
} from './claude-code-provider';
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
    // Z.ai (GLM). A Coding Plan key bills against that plan's quota, not
    // per token — the usage meter treats it as subscription-billed.
    const zaiKey = this.secrets.get('zai');
    if (on('zai') && zaiKey) reg.register(new ZaiProvider({ apiKey: zaiKey }));
    // Google Gemini via its OpenAI-compatible endpoint. A free AI Studio key
    // works; billing is per-token (not a plan), so the meter prices it from the
    // catalog like any cloud model.
    const geminiKey = this.secrets.get('gemini');
    if (on('gemini') && geminiKey) reg.register(new GeminiProvider({ apiKey: geminiKey }));
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
    // One primary plus any extra boxes, same as Ollama — the adapter owns the
    // /v1 normalization for all of them, because people paste the bare
    // host:port that LM Studio's own UI shows them.
    if (on('lmstudio')) {
      reg.register(
        new LmStudioProvider({
          baseURL: cfg.lmstudioBaseUrl || 'http://127.0.0.1:1234/v1',
          extraEndpoints: activeEndpoints(cfg.lmstudioExtraEndpoints),
        }),
      );
    }
    // FastFlowLM: the NPU box. Same wire and same fleet shape as LM Studio,
    // so the only thing it needs of its own is its port.
    if (on('flm')) {
      reg.register(
        new FlmProvider({
          baseURL: cfg.flmBaseUrl || 'http://127.0.0.1:52625/v1',
          extraEndpoints: activeEndpoints(cfg.flmExtraEndpoints),
        }),
      );
    }
    const llamacpp = activeEndpoints(cfg.llamacppEndpoints);
    if (on('llamacpp') && llamacpp.length) {
      reg.register(new LlamaCppProvider({ endpoints: llamacpp }));
    }
    // Claude Code CLI: the user's installed, logged-in `claude` as an agent
    // brain. No key gate on purpose — a missing binary must surface as a
    // readable chat error, not as "provider not configured".
    if (on('claude-code')) reg.register(this.cliAgent());
    return reg;
  }

  /**
   * The CLI provider is the one provider with state (session bindings, binary
   * cache), so unlike the HTTP adapters it is a singleton across registry()
   * rebuilds. Config still applies live — it reads through a closure.
   */
  cliAgent(): ClaudeCodeCliProvider {
    this.cli ??= new ClaudeCodeCliProvider(() => this.config.get());
    return this.cli;
  }

  /** Tie a resolved claude-code provider to a chat or mission; other providers
   *  pass through untouched, so callers need no provider-specific branching. */
  bindCli(provider: ChatProvider, binding: CliSessionBinding): ChatProvider {
    return provider instanceof ClaudeCodeCliProvider ? provider.forSession(binding) : provider;
  }

  private cli?: ClaudeCodeCliProvider;
}
