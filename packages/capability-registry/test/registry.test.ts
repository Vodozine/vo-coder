import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCatalog, loadSeed, mergeRecords } from '../src/catalog.ts';
import { checkFit } from '../src/hardware.ts';
import { fetchOpenRouterModels } from '../src/sources/openrouter.ts';
import { complexityOf, signalFromPrompt, suggest } from '../src/router.ts';
import type { HardwareProfile, ModelRecord } from '../src/types.ts';

const smallBox: HardwareProfile = {
  totalMemGb: 16,
  freeMemGb: 8,
  cpuCount: 8,
  cpuModel: 'test',
};
const bigBox: HardwareProfile = { ...smallBox, totalMemGb: 96 };

const fixtureFetch = (() => {
  const body = readFileSync(new URL('./fixtures/openrouter-models.json', import.meta.url), 'utf8');
  return (async () =>
    new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
})();

describe('hardware fit rule', () => {
  it('blocks a 70B-class model on a 16 GB machine and allows it on 96 GB', () => {
    const seventyB = loadSeed().find((m) => m.id === 'llama3.3:70b')!;
    expect(checkFit(seventyB, smallBox).fits).toBe(false);
    expect(checkFit(seventyB, smallBox).reason).toMatch(/only ~10 GB is usable/);
    expect(checkFit(seventyB, bigBox).fits).toBe(true);
  });

  it('cloud models always fit', () => {
    const sonnet = loadSeed().find((m) => m.id === 'claude-sonnet-5')!;
    expect(checkFit(sonnet, smallBox).fits).toBe(true);
  });
});

describe('openrouter source', () => {
  it('maps recorded JSON into normalized records', async () => {
    const records = await fetchOpenRouterModels(fixtureFetch);
    expect(records).toHaveLength(3);
    const sonnet = records.find((r) => r.id === 'anthropic/claude-sonnet-5')!;
    expect(sonnet).toMatchObject({
      contextLength: 200000,
      pricing: { inputPerMTok: 3, outputPerMTok: 15 },
      supportsVision: true,
      supportsTools: true,
      supportsThinking: true,
    });
    const llama = records.find((r) => r.id === 'meta-llama/llama-3.3-70b-instruct')!;
    expect(llama.tags).toContain('cheap');
    expect(llama.supportsVision).toBe(false);
  });
});

describe('catalog merge + cache', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('seed stays authoritative for curated fields on id conflicts', () => {
    const seed: ModelRecord[] = [{ id: 'x', tags: ['coding'], quality: 8 }];
    const live: ModelRecord[] = [
      { id: 'x', tags: [], contextLength: 100000, pricing: { inputPerMTok: 1 } },
    ];
    const merged = mergeRecords(seed, live);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      quality: 8,
      tags: ['coding'],
      contextLength: 100000,
      pricing: { inputPerMTok: 1 },
    });
  });

  it('caches live results and skips refetch within the TTL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vo-cat-'));
    dirs.push(dir);
    let calls = 0;
    const countingFetch = (async (...args: Parameters<typeof fetch>) => {
      calls++;
      return (fixtureFetch as (...a: Parameters<typeof fetch>) => Promise<Response>)(...args);
    }) as unknown as typeof fetch;

    let clock = 1_000_000;
    const opts = {
      cacheDir: dir,
      ttlMs: 10_000,
      fetchFn: countingFetch,
      now: () => clock,
    };
    const first = await buildCatalog(opts);
    expect(calls).toBe(1);
    expect(first.some((m) => m.id === 'anthropic/claude-sonnet-5')).toBe(true);

    clock += 5_000; // inside TTL
    await buildCatalog(opts);
    expect(calls).toBe(1);

    clock += 20_000; // past TTL
    await buildCatalog(opts);
    expect(calls).toBe(2);
  });

  it('falls back to the seed when offline', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const catalog = await buildCatalog({ fetchFn: failing });
    expect(catalog.some((m) => m.id === 'claude-sonnet-5')).toBe(true);
  });
});

describe('advisory router', () => {
  const catalog = loadSeed();

  it('routes a trivial prompt to a cheap local model', () => {
    const signal = signalFromPrompt('make this sentence title case please');
    expect(complexityOf(signal)).toBe(0);
    const [top] = suggest(signal, catalog, bigBox);
    expect(top!.estCostPerExchange).toBe(0);
    expect(top!.model.estMemGb).toBeDefined();
    expect(top!.rationale).toMatch(/simple task/);
  });

  it('routes hard reasoning to a frontier model with a rationale', () => {
    const signal = signalFromPrompt(
      'Refactor this concurrency-heavy scheduler:\n```ts\n' + 'x'.repeat(1500) + '\n```',
      { wantsThinking: true },
    );
    expect(complexityOf(signal)).toBe(3);
    const [top] = suggest(signal, catalog, smallBox);
    expect((top!.model.quality ?? 0)).toBeGreaterThanOrEqual(8);
    expect(top!.rationale).toMatch(/hard reasoning task/);
  });

  it('vision requirement filters non-vision models', () => {
    const signal = signalFromPrompt('what is in this screenshot?', { needsVision: true });
    const ranked = suggest(signal, catalog, smallBox);
    expect(ranked.length).toBeGreaterThan(0);
    for (const r of ranked) expect(r.model.supportsVision).toBe(true);
  });

  it('hardware filters local models that do not fit', () => {
    const signal = signalFromPrompt('short question');
    const ranked = suggest(signal, catalog, smallBox, 20);
    expect(ranked.some((r) => r.model.id === 'llama3.3:70b')).toBe(false);
    const rankedBig = suggest(signal, catalog, bigBox, 20);
    expect(rankedBig.some((r) => r.model.id === 'llama3.3:70b')).toBe(true);
  });
});
