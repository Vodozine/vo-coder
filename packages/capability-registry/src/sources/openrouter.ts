import type { ModelRecord } from '../types.js';

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { input_modalities?: string[] };
  supported_parameters?: string[];
}

/** Richest free live metadata: pricing, context, modality. No key required. */
export async function fetchOpenRouterModels(
  fetchFn: typeof fetch = fetch,
): Promise<ModelRecord[]> {
  const res = await fetchFn('https://openrouter.ai/api/v1/models');
  if (!res.ok) throw new Error(`OpenRouter model list returned ${res.status}`);
  const json = (await res.json()) as { data?: OpenRouterModel[] };
  return (json.data ?? []).map((m) => {
    const inputPerTok = Number(m.pricing?.prompt ?? 0);
    const outputPerTok = Number(m.pricing?.completion ?? 0);
    const vision = m.architecture?.input_modalities?.includes('image') ?? false;
    const tools = m.supported_parameters?.includes('tools') ?? false;
    const thinking = m.supported_parameters?.includes('reasoning') ?? false;
    return {
      id: m.id,
      provider: 'openrouter',
      displayName: m.name ?? m.id,
      contextLength: m.context_length,
      pricing: {
        inputPerMTok: Math.round(inputPerTok * 1e6 * 100) / 100,
        outputPerMTok: Math.round(outputPerTok * 1e6 * 100) / 100,
      },
      tags: [
        ...(vision ? ['vision'] : []),
        ...(tools ? ['tool-use'] : []),
        ...(inputPerTok * 1e6 < 0.5 ? ['cheap'] : []),
      ],
      supportsTools: tools,
      supportsVision: vision,
      supportsThinking: thinking,
    } satisfies ModelRecord;
  });
}
