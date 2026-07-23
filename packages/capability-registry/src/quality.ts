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
  [/-nano|-tiny|\b\d{1,2}b\b/i, 4],
];

export function qualityFor(id: string, displayName?: string): number | undefined {
  const haystack = `${id} ${displayName ?? ''}`;
  for (const [pattern, quality] of QUALITY_PATTERNS) {
    if (pattern.test(haystack)) return quality;
  }
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
