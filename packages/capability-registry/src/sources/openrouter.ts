import type { ModelRecord } from '../types.js';

/**
 * OpenRouter lists async Batch API variants (`…:batch`) at roughly half price.
 * They have no streaming endpoint, so a live chat request against one 404s
 * ("No endpoints found for …:batch"). Vodo optimises for cheapest-adequate and
 * is therefore pulled straight toward them — so they must never enter the
 * catalog. Applied at every point models flow in (fetch and cache read) so a
 * variant that OpenRouter later delists can't linger in a still-valid cache.
 */
export function isStreamableModelId(id: string): boolean {
  return !id.endsWith(':batch');
}

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
  return (json.data ?? []).filter((m) => isStreamableModelId(m.id)).map((m) => {
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
