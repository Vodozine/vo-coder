import type { ModelRecord } from '../types.js';

/**
 * Measured quality from the LMArena leaderboard — Elo ratings from millions of
 * blind human votes, published as JSON by the lmarena org itself (keyless).
 * Scores are near-static per model; new models appear every few weeks, so a
 * long cache TTL is plenty.
 */

export const ARENA_URL =
  'https://raw.githubusercontent.com/lmarena/arena-catalog/main/data/leaderboard-text.json';

type ArenaFile = Record<string, Record<string, { rating?: number }>>;

/** Elo → 1-10 quality. Calibration: ~1250→4, ~1385→7, ~1475→9, ≥1520→10. */
export function eloToQuality(rating: number): number {
  const quality = 4 + (rating - 1250) / 45;
  return Math.round(Math.min(10, Math.max(3, quality)) * 10) / 10;
}

/**
 * Per-model rating across categories: 'coding' counts double (this is a
 * coding harness), everything else averages in.
 */
export async function fetchArenaRatings(
  fetchFn: typeof fetch = fetch,
): Promise<Map<string, number>> {
  const res = await fetchFn(ARENA_URL);
  if (!res.ok) throw new Error(`LMArena data returned ${res.status}`);
  const file = (await res.json()) as ArenaFile;

  const sums = new Map<string, { total: number; weight: number }>();
  for (const [category, entries] of Object.entries(file)) {
    if (typeof entries !== 'object' || entries === null) continue;
    const weight = category === 'coding' ? 2 : 1;
    for (const [name, entry] of Object.entries(entries)) {
      const rating = entry?.rating;
      if (typeof rating !== 'number') continue;
      const acc = sums.get(name) ?? { total: 0, weight: 0 };
      acc.total += rating * weight;
      acc.weight += weight;
      sums.set(name, acc);
    }
  }
  const ratings = new Map<string, number>();
  for (const [name, { total, weight }] of sums) {
    ratings.set(name.toLowerCase(), total / weight);
  }
  return ratings;
}

/** Strip provider prefix, date stamps, and channel suffixes for matching. */
function normalizeId(id: string): string {
  return id
    .toLowerCase()
    .split('/')
    .pop()!
    .replace(/:(free|extended|nitro)$/g, '')
    .replace(/-\d{8}$/g, '')
    .replace(/-(preview|latest|beta|exp)(-\d+)?$/g, '');
}

/**
 * Match a catalog id to arena entries: exact normalized match first, then the
 * longest containment either way (≥6 chars so "pro" never matches "grok-pro").
 * Multiple arena variants (…-thinking, …-high) resolve to the best rating.
 */
/** First version-looking token: claude-opus-4.8 → "4.8", gpt-5.1-high → "5.1". */
function versionOf(name: string): string | null {
  return name.match(/(?:^|-)v?(\d+(?:\.\d+)?)(?=$|[-.])/)?.[1] ?? null;
}

export function arenaRatingFor(id: string, ratings: Map<string, number>): number | undefined {
  const tail = normalizeId(id);
  if (tail.length < 4) return undefined;
  const exact = ratings.get(tail);
  if (exact !== undefined) return exact;
  const tailVersion = versionOf(tail);
  let best: { len: number; rating: number } | undefined;
  for (const [name, rating] of ratings) {
    const arena = normalizeId(name);
    const overlap = Math.min(arena.length, tail.length);
    if (overlap < 6) continue;
    if (!(arena.startsWith(tail) || tail.startsWith(arena))) continue;
    // Version guard: opus-4.8 must never inherit opus-4's (older) rating.
    if (versionOf(arena) !== tailVersion) continue;
    if (!best || overlap > best.len || (overlap === best.len && rating > best.rating)) {
      best = { len: overlap, rating };
    }
  }
  return best?.rating;
}

/** Fill measured quality on records the curation didn't rate. */
export function applyArenaQuality(
  records: ModelRecord[],
  ratings: Map<string, number>,
): ModelRecord[] {
  if (ratings.size === 0) return records;
  return records.map((record) => {
    if (record.quality !== undefined) return record;
    const rating = arenaRatingFor(record.id, ratings);
    if (rating === undefined) return record;
    return { ...record, quality: eloToQuality(rating), qualitySource: 'arena' as const };
  });
}
