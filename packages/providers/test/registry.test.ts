import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../src/registry.ts';
import type { ChatProvider } from '../src/types.ts';

const fake = (id: string): ChatProvider => ({
  id,
  listModels: async () => [],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  stream: async function* (_req, _opts) {},
});

const defaults = { provider: 'anthropic', model: 'claude-sonnet-5' };

describe('ProviderRegistry.resolve', () => {
  it('falls back to app defaults when the agent has no overrides', () => {
    const reg = new ProviderRegistry().register(fake('anthropic'));
    const bound = reg.resolve({}, defaults);
    expect(bound.provider.id).toBe('anthropic');
    expect(bound.model).toBe('claude-sonnet-5');
  });

  it('uses agent provider+model overrides', () => {
    const reg = new ProviderRegistry().register(fake('anthropic')).register(fake('ollama'));
    const bound = reg.resolve({ provider: 'ollama', model: 'llama3.2' }, defaults);
    expect(bound.provider.id).toBe('ollama');
    expect(bound.model).toBe('llama3.2');
  });

  it('does not carry the default model onto a different provider', () => {
    const reg = new ProviderRegistry().register(fake('anthropic')).register(fake('ollama'));
    expect(() => reg.resolve({ provider: 'ollama' }, defaults)).toThrow(/No model selected/);
  });

  it('names the missing provider in the error', () => {
    const reg = new ProviderRegistry();
    expect(() => reg.resolve({ provider: 'openai' }, defaults)).toThrow(/"openai"/);
  });
});
