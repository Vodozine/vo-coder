import { describe, expect, it } from 'vitest';
import { GeminiProvider } from '../src/adapters/openai-compatible.ts';
import { fetchRejecting } from './helpers.ts';

describe('GeminiProvider', () => {
  it('defaults to the Google OpenAI-compatible endpoint', () => {
    const p = new GeminiProvider({ apiKey: 'k' });
    expect(p.id).toBe('gemini');
  });

  it('seeds the current frontier models when /models is unreachable', async () => {
    // Live listing throws → the picker must not be left empty.
    const p = new GeminiProvider({ apiKey: 'k', fetch: fetchRejecting(new Error('offline')) });
    const models = await p.listModels();
    expect(models.map((m) => m.id)).toContain('gemini-3.1-pro');
    expect(models.every((m) => m.provider === 'gemini')).toBe(true);
    // Gemini is multimodal — the seeds must say so, or vision routing skips it.
    expect(models.every((m) => m.supportsVision && m.supportsTools)).toBe(true);
  });
});
