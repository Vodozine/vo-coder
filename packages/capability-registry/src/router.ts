import { checkFit } from './hardware.js';
import type { HardwareProfile, ModelRecord, RankedModel, TaskSignal } from './types.js';

export function signalFromPrompt(
  text: string,
  opts: {
    needsTools?: boolean;
    needsVision?: boolean;
    wantsThinking?: boolean;
    agentic?: boolean;
  } = {},
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
    agentic: opts.agentic ?? false,
  };
}

/**
 * Does this message actually ask the agent to DO something to the project
 * (build/edit/run), versus chat ("hello", "thanks", "what does this do")? Used
 * to decide whether a folder-backed turn deserves the agentic quality floor —
 * so greetings in a build project stay cheap instead of waking the big brain.
 */
const WORK_INTENT =
  /\b(add|build|make|create|implement|write|code|generate|scaffold|fix|debug|repair|refactor|clean[\s-]?up|change|modify|update|edit|adjust|tweak|rename|move|delete|remove|drop|replace|install|run|execute|test|set[\s-]?up|configure|wire|integrate|hook[\s-]?up|connect|render|deploy|compile|package|redesign|restyle|design|style|lay[\s-]?out|improve|enhance|polish|optimi[sz]e|convert|migrate|port|continue|proceed|resume|keep\s+going|go\s+ahead|finish|next\s+step)\b/i;

export function looksLikeWorkRequest(text: string): boolean {
  return /```/.test(text) || WORK_INTENT.test(text);
}

/** 0 = trivial … 3 = hard reasoning. Drives the minimum quality bar. */
export function complexityOf(signal: TaskSignal): number {
  let c = 0;
  if (signal.promptChars > 1200) c++;
  if (signal.hasCodeFence) c++;
  if (signal.wantsThinking) c++;
  // A folder-backed build turn is real work regardless of how terse the ask is
  // ("make it modern" is 15 chars) — floor it at the "complex" bar so a capable
  // executor is chosen over a cheap model that only describes the change.
  if (signal.agentic) c = Math.max(c, 2);
  return c;
}

// Adequacy bars per complexity tier: trivial work goes to free/small models,
// but "moderate" already demands solid mid-tier — being cheap is not enough.
const MIN_QUALITY = [4, 6, 8, 9] as const;

export function estCostPerExchange(m: ModelRecord): number {
  if (!m.pricing) return 0; // local
  // Rough exchange: ~2k input + 1k output tokens.
  return ((m.pricing.inputPerMTok ?? 0) * 2000 + (m.pricing.outputPerMTok ?? 0) * 1000) / 1e6;
}

export type RouteTier = 'cheap' | 'balanced' | 'best';

/**
 * Advisory-only ranking: filter by hard requirements (vision/tools/hardware
 * fit), demand a quality floor scaled to task complexity, then order by the
 * chosen tier — 'cheap' prefers the cheapest capable model, 'balanced' the
 * most capable among mid-priced options, 'best' pure quality with price only
 * as a tiebreak.
 */
export function suggest(
  signal: TaskSignal,
  catalog: ModelRecord[],
  hw: HardwareProfile,
  limit = 3,
  opts: { tier?: RouteTier } = {},
): RankedModel[] {
  const tier = opts.tier ?? 'cheap';
  const complexity = complexityOf(signal);
  const minQuality = MIN_QUALITY[complexity]!;

  const eligible = catalog.filter((m) => {
    if (m.outputsImage === true) return false; // image generators can't chat
    if (signal.needsVision && m.supportsVision !== true) return false;
    if (signal.needsTools && m.supportsTools !== true) return false;
    if (m.quality === undefined) return false; // unrated models never get auto-suggested
    if (!checkFit(m, hw).fits) return false;
    return true;
  });

  const adequate = eligible.filter((m) => (m.quality ?? 0) >= minQuality);
  let pool = (adequate.length > 0 ? adequate : eligible).map((m) => ({
    model: m,
    cost: estCostPerExchange(m),
  }));

  if (tier === 'best') {
    pool = pool.sort(
      (a, b) => (b.model.quality ?? 0) - (a.model.quality ?? 0) || a.cost - b.cost,
    );
  } else if (tier === 'balanced') {
    // Most capable among the mid-priced: trim the cheapest and priciest
    // quartiles (when the pool is big enough), then rank by quality.
    const byCost = [...pool].sort((a, b) => a.cost - b.cost);
    const band =
      byCost.length >= 8
        ? byCost.slice(Math.floor(byCost.length * 0.25), Math.ceil(byCost.length * 0.75))
        : byCost;
    pool = band.sort(
      (a, b) => (b.model.quality ?? 0) - (a.model.quality ?? 0) || a.cost - b.cost,
    );
  } else {
    pool = pool.sort((a, b) => a.cost - b.cost || (b.model.quality ?? 0) - (a.model.quality ?? 0));
  }

  const label =
    complexity === 0
      ? 'simple task'
      : complexity === 1
        ? 'moderate task'
        : complexity === 2
          ? 'complex task'
          : 'hard reasoning task';
  const tierLabel =
    tier === 'best' ? 'best in class' : tier === 'balanced' ? 'mid-price capable' : 'cheapest capable';

  return pool.slice(0, limit).map(({ model, cost }) => ({
    model,
    estCostPerExchange: cost,
    rationale:
      `${label} → ${model.displayName ?? model.id}` +
      (cost === 0
        ? ' (local, est. $0)'
        : ` (est. $${cost.toFixed(cost < 0.01 ? 4 : 2)}/exchange)`) +
      `, quality ${Number.isInteger(model.quality) ? model.quality : model.quality?.toFixed(1)}/10` +
      (model.qualitySource === 'arena' ? ' (arena elo)' : '') +
      ` · ${tierLabel}` +
      (adequate.length === 0 ? ' — best available below the ideal quality bar' : ''),
  }));
}
