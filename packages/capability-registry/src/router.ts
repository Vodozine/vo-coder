import { checkFit } from './hardware.js';
import type { HardwareProfile, ModelRecord, RankedModel, TaskSignal } from './types.js';

export function signalFromPrompt(
  text: string,
  opts: { needsTools?: boolean; needsVision?: boolean; wantsThinking?: boolean } = {},
): TaskSignal {
  return {
    promptChars: text.length,
    hasCodeFence:
      /```|\b(function|class|import |def |const |refactor|debug|stack ?trace|compile)\b/i.test(
        text,
      ),
    needsTools: opts.needsTools ?? false,
    needsVision: opts.needsVision ?? false,
    wantsThinking: opts.wantsThinking ?? false,
  };
}

/** 0 = trivial … 3 = hard reasoning. Drives the minimum quality bar. */
export function complexityOf(signal: TaskSignal): number {
  let c = 0;
  if (signal.promptChars > 1200) c++;
  if (signal.hasCodeFence) c++;
  if (signal.wantsThinking) c++;
  return c;
}

const MIN_QUALITY = [2, 4, 6, 8] as const;

export function estCostPerExchange(m: ModelRecord): number {
  if (!m.pricing) return 0; // local
  // Rough exchange: ~2k input + 1k output tokens.
  return ((m.pricing.inputPerMTok ?? 0) * 2000 + (m.pricing.outputPerMTok ?? 0) * 1000) / 1e6;
}

/**
 * Advisory-only "cheapest adequate" ranking: filter by hard requirements
 * (vision/tools/hardware fit), demand a quality floor scaled to task
 * complexity, then prefer the cheapest — the always-on local foundation takes
 * simple work, the big brain only fires when the task earns it.
 */
export function suggest(
  signal: TaskSignal,
  catalog: ModelRecord[],
  hw: HardwareProfile,
  limit = 3,
): RankedModel[] {
  const complexity = complexityOf(signal);
  const minQuality = MIN_QUALITY[complexity]!;

  const eligible = catalog.filter((m) => {
    if (signal.needsVision && m.supportsVision !== true) return false;
    if (signal.needsTools && m.supportsTools !== true) return false;
    if (m.quality === undefined) return false; // unrated models never get auto-suggested
    if (!checkFit(m, hw).fits) return false;
    return true;
  });

  const adequate = eligible.filter((m) => (m.quality ?? 0) >= minQuality);
  const pool = adequate.length > 0 ? adequate : eligible; // degrade gracefully

  const label =
    complexity === 0
      ? 'simple task'
      : complexity === 1
        ? 'moderate task'
        : complexity === 2
          ? 'complex task'
          : 'hard reasoning task';

  return pool
    .map((m) => ({ model: m, cost: estCostPerExchange(m) }))
    .sort((a, b) => a.cost - b.cost || (b.model.quality ?? 0) - (a.model.quality ?? 0))
    .slice(0, limit)
    .map(({ model, cost }) => ({
      model,
      estCostPerExchange: cost,
      rationale:
        `${label} → ${model.displayName ?? model.id}` +
        (cost === 0
          ? ' (local, est. $0)'
          : ` (est. $${cost.toFixed(cost < 0.01 ? 4 : 2)}/exchange)`) +
        `, quality ${model.quality}/10` +
        (adequate.length === 0 ? ' — best available below the ideal quality bar' : ''),
    }));
}
