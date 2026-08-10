import type { ModelRecord } from './types.js';

/**
 * Coarse quality ratings by model family, applied to live catalog records that
 * have no curated rating. This is what lets routing choose from the whole live
 * market ("similar price, better performance") instead of a handful of seeded
 * ids. Order matters: specific patterns first. Curated seed entries always win.
 */
export const QUALITY_PATTERNS: Array<[RegExp, number]> = [
  // Specific sub-tiers must precede their frontier families.
  [/gpt-5.*-(mini|nano)/i, 7],
  // Frontier tier
  [/claude-opus/i, 10],
  [/claude-sonnet/i, 9],
  [/gpt-5(\.\d+)?(-pro|-codex)?($|[^a-z-])/i, 9],
  [/grok-4/i, 9],
  [/gemini-\d(\.\d+)?-pro/i, 9],
  [/qwen3-max/i, 8],
  [/deepseek-(v\d|r\d)/i, 8],
  [/kimi-k\d/i, 8],
  [/mistral-large/i, 8],
  [/gemini-\d(\.\d+)?-flash(?!-lite)/i, 8],
  [/claude-haiku/i, 7],
  [/gpt-5.*-mini/i, 7],
  [/minimax-m\d/i, 7],
  [/glm-\d/i, 7],
  [/llama-?4/i, 7],
  [/-codex|coder|devstral|kat-coder/i, 7],
  [/llama-?3\.\d-70b/i, 6],
  [/seed-\d/i, 6],
  [/magistral|mistral-medium|longcat/i, 6],
  // Small / budget tier
  [/flash-lite|-lite($|[^a-z])/i, 5],
  [/-mini($|[^a-z])|ministral|-small/i, 5],
  [/-nano|-tiny/i, 4],
];

/**
 * Parameter count → quality band, for the open-weight models whose id states
 * their size. This used to be one blunt pattern (\b\d{1,2}b\b → 4) that read
 * "has a number followed by b" as "small and cheap" — so a 70B and a 4B scored
 * identically, and a 27B local model looked no more capable than a 4B one.
 * Size is not the whole story, but between two open models it is the strongest
 * cheap signal there is.
 */
const PARAM_BANDS: Array<[minB: number, quality: number]> = [
  [70, 8],
  [30, 7],
  [20, 6],
  [12, 5],
  [7, 4],
  [0, 3],
];

/**
 * The largest parameter count an id states, in billions. Handles the shapes
 * that actually appear: "-9b", "27B", "E4B" (Gemma's letter prefix), MoE ids
 * carrying both totals and active params ("gemma-4-26b-a4b" → 26, the total,
 * because that is what the weights cost and roughly what it knows), and the
 * "8x22b" expert form, counted as one expert rather than eight — the safe
 * reading, since active parameters are what answer a turn.
 * Quantization tags never match: "IQ4_XS" and "Q4_K_M" have no b after the
 * digits.
 */
export function paramBillions(text: string): number | undefined {
  let max: number | undefined;
  for (const m of text.matchAll(
    /(?:^|[^a-z0-9.])(?:\d+\s*x\s*)?[a-z]?(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/gi,
  )) {
    const n = Number(m[1]);
    // 0.5b is real (small embedders); 2000b is a year or a run id, not a size.
    if (!Number.isFinite(n) || n <= 0 || n > 1500) continue;
    if (max === undefined || n > max) max = n;
  }
  return max;
}

export function qualityFor(id: string, displayName?: string): number | undefined {
  const haystack = `${id} ${displayName ?? ''}`;
  for (const [pattern, quality] of QUALITY_PATTERNS) {
    if (pattern.test(haystack)) return quality;
  }
  const params = paramBillions(haystack);
  if (params !== undefined) return PARAM_BANDS.find(([min]) => params >= min)![1];
  return undefined;
}

/** Fill quality for unrated records; curated ratings are never overwritten. */
export function annotateQuality(records: ModelRecord[]): ModelRecord[] {
  return records.map((record) =>
    record.quality !== undefined
      ? record
      : { ...record, quality: qualityFor(record.id, record.displayName) },
  );
}
