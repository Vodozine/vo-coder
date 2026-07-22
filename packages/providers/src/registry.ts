import type { AgentSpec, ChatProvider, ProviderId } from './types.js';

export interface ResolveDefaults {
  provider: ProviderId;
  model: string;
}

export interface BoundModel {
  provider: ChatProvider;
  model: string;
}

/**
 * Holds one configured client per provider id. Resolution cascade:
 * agent override → app defaults → descriptive error.
 */
export class ProviderRegistry {
  private providers = new Map<string, ChatProvider>();

  register(provider: ChatProvider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  get(id: ProviderId): ChatProvider | undefined {
    return this.providers.get(id);
  }

  ids(): ProviderId[] {
    return [...this.providers.keys()];
  }

  resolve(
    spec: Pick<AgentSpec, 'provider' | 'model'>,
    defaults: ResolveDefaults,
  ): BoundModel {
    const providerId = spec.provider ?? defaults.provider;
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(
        `Provider "${providerId}" is not configured. Add its API key or endpoint in Settings.`,
      );
    }
    // A model default only carries over when the provider is the default one —
    // model ids are not portable across providers.
    const model = spec.model ?? (providerId === defaults.provider ? defaults.model : undefined);
    if (!model) {
      throw new Error(
        `No model selected for provider "${providerId}". Set a model on the agent or in Settings.`,
      );
    }
    return { provider, model };
  }
}
