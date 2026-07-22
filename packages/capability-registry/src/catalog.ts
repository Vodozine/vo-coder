import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fetchOpenRouterModels } from './sources/openrouter.js';
import type { ModelRecord } from './types.js';

export function loadSeed(): ModelRecord[] {
  // Fallback chain covers bundled/packaged hosts where import.meta.url no
  // longer points into this package (env override → Electron resources dir).
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  const candidates: Array<URL | string> = [
    ...(process.env.VO_CAPABILITY_SEED ? [process.env.VO_CAPABILITY_SEED] : []),
    new URL('../data/static-seed.json', import.meta.url),
    ...(resourcesPath ? [join(resourcesPath, 'capability-data', 'static-seed.json')] : []),
  ];
  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, 'utf8');
      return (JSON.parse(raw) as { models: ModelRecord[] }).models;
    } catch {
      /* try next */
    }
  }
  return [];
}

export interface CatalogOptions {
  /** Directory for the TTL disk cache; omit to skip caching. */
  cacheDir?: string;
  ttlMs?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
  /** Extra records to merge, e.g. locally installed Ollama models. */
  extra?: ModelRecord[];
}

interface CacheFile {
  at: number;
  records: ModelRecord[];
}

const DEFAULT_TTL = 24 * 60 * 60 * 1000;

/**
 * Merge order (later wins on id conflicts EXCEPT curated fields): live sources
 * fill pricing/context; the seed stays authoritative for quality/tags/estMemGb.
 */
export function mergeRecords(seed: ModelRecord[], live: ModelRecord[]): ModelRecord[] {
  const byId = new Map<string, ModelRecord>();
  for (const r of live) byId.set(r.id, r);
  for (const s of seed) {
    const l = byId.get(s.id);
    byId.set(s.id, l ? { ...l, ...s, pricing: s.pricing ?? l.pricing } : s);
  }
  return [...byId.values()];
}

export async function buildCatalog(opts: CatalogOptions = {}): Promise<ModelRecord[]> {
  const now = opts.now ?? Date.now;
  const seed = loadSeed();
  let live: ModelRecord[] = [];

  const cachePath = opts.cacheDir ? join(opts.cacheDir, 'catalog-cache.json') : null;
  const ttl = opts.ttlMs ?? DEFAULT_TTL;

  if (cachePath) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as CacheFile;
      if (now() - cached.at < ttl) live = cached.records;
    } catch {
      /* cache miss */
    }
  }
  if (live.length === 0) {
    try {
      live = await fetchOpenRouterModels(opts.fetchFn);
      if (cachePath) {
        mkdirSync(dirname(cachePath), { recursive: true });
        writeFileSync(cachePath, JSON.stringify({ at: now(), records: live }), 'utf8');
      }
    } catch {
      // Offline is fine — the curated seed is the ground truth fallback.
    }
  }

  return mergeRecords(seed, [...live, ...(opts.extra ?? [])]);
}
