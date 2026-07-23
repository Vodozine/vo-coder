import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCatalog, loadSeed, mergeRecords } from '../src/catalog.ts';
import { checkFit } from '../src/hardware.ts';
import { fetchOpenRouterModels } from '../src/sources/openrouter.ts';
import {
  complexityOf,
  looksLikeWorkRequest,
  signalFromPrompt,
  suggest,
} from '../src/router.ts';
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
    // The fixture carries 4 entries; the `…:batch` variant is dropped because
    // batch has no streaming endpoint — routing to it 404s.
    expect(records).toHaveLength(3);
    expect(records.some((r) => r.id.endsWith(':batch'))).toBe(false);
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
      // Only count the OpenRouter fetch — the arena benchmark fetch has its
      // own (weekly) cache and is covered by its own tests.
      if (String(args[0]).includes('openrouter')) calls++;
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

  it('drops a delisted batch variant already sitting in the cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vo-cat-'));
    dirs.push(dir);
    // Simulate a cache written before the batch guard existed: a `…:batch`
    // record OpenRouter has since delisted, still inside its TTL.
    writeFileSync(
      join(dir, 'catalog-cache.json'),
      JSON.stringify({
        at: 1_000_000,
        records: [
          { id: 'openai/gpt-5-nano', provider: 'openrouter', pricing: { inputPerMTok: 0.05 } },
          { id: 'openai/gpt-5-nano:batch', provider: 'openrouter', pricing: { inputPerMTok: 0.02 } },
        ],
      }),
    );
    const catalog = await buildCatalog({
      cacheDir: dir,
      ttlMs: 1_000_000,
      now: () => 1_100_000,
    });
    expect(catalog.some((m) => m.id === 'openai/gpt-5-nano')).toBe(true);
    expect(catalog.some((m) => m.id === 'openai/gpt-5-nano:batch')).toBe(false);
  });

  it('falls back to the seed when offline', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const catalog = await buildCatalog({ fetchFn: failing });
    expect(catalog.some((m) => m.id === 'claude-sonnet-5')).toBe(true);
  });
});

describe('lmarena benchmark ingestion', async () => {
  const { applyArenaQuality, arenaRatingFor, eloToQuality, fetchArenaRatings } = await import(
    '../src/sources/lmarena.ts'
  );

  it('converts Elo to calibrated 1-10 quality', () => {
    expect(eloToQuality(1525)).toBe(10);
    expect(eloToQuality(1475)).toBe(9);
    expect(eloToQuality(1385)).toBe(7);
    expect(eloToQuality(1250)).toBe(4);
    expect(eloToQuality(700)).toBe(3); // clamped floor
  });

  it('parses the category file with coding weighted double', async () => {
    const file = {
      coding: { 'model-x': { rating: 1500 } },
      creative_writing: { 'model-x': { rating: 1200 }, 'model-y': { rating: 1400 } },
    };
    const fetchFn = (async () =>
      new Response(JSON.stringify(file), { status: 200 })) as unknown as typeof fetch;
    const ratings = await fetchArenaRatings(fetchFn);
    expect(ratings.get('model-x')).toBe(1400); // (1500*2 + 1200) / 3
    expect(ratings.get('model-y')).toBe(1400);
  });

  it('matches catalog ids to arena names across prefixes, dates, and variants', () => {
    const ratings = new Map<string, number>([
      ['gemini-3-pro', 1520],
      ['gpt-5.1-high', 1496],
      ['gpt-5.1', 1480],
      ['grok-4.1-thinking', 1475],
      ['grok-4.1', 1470],
    ]);
    expect(arenaRatingFor('google/gemini-3-pro-preview', ratings)).toBe(1520);
    // An exact arena entry always wins over better-rated siblings — the
    // -thinking/-high variants are different serving modes, not this model.
    expect(arenaRatingFor('openai/gpt-5.1', ratings)).toBe(1480);
    expect(arenaRatingFor('x-ai/grok-4.1', ratings)).toBe(1470);
    // Without an exact entry, the longest prefix relative is used — the base
    // model, not an unrelated -thinking sibling.
    expect(arenaRatingFor('x-ai/grok-4.1-fast', ratings)).toBe(1470);
    // Version guard: a newer model never inherits an older sibling's rating.
    expect(
      arenaRatingFor('anthropic/claude-opus-4.8', new Map([['claude-opus-4-20250514', 1370]])),
    ).toBeUndefined();
    expect(arenaRatingFor('some/unrelated-model', ratings)).toBeUndefined();
  });

  it('never overwrites existing ratings and tags its source', () => {
    const ratings = new Map([['mystery-model-9000', 1475]]);
    const out = applyArenaQuality(
      [
        { id: 'x/mystery-model-9000', tags: [], quality: 5, qualitySource: 'curated' },
        { id: 'y/mystery-model-9000-pro', tags: [] },
      ],
      ratings,
    );
    expect(out[0]!.quality).toBe(5);
    expect(out[1]!.quality).toBe(9);
    expect(out[1]!.qualitySource).toBe('arena');
  });
});

describe('quality pattern annotation', async () => {
  const { annotateQuality, qualityFor } = await import('../src/quality.ts');

  it('rates live-market families sensibly, specific before generic', () => {
    expect(qualityFor('anthropic/claude-opus-4.8')).toBe(10);
    expect(qualityFor('anthropic/claude-sonnet-5')).toBe(9);
    expect(qualityFor('openai/gpt-5.2')).toBe(9);
    expect(qualityFor('openai/gpt-5.2-mini')).toBe(7);
    expect(qualityFor('x-ai/grok-4.5')).toBe(9);
    expect(qualityFor('google/gemini-3-flash-preview')).toBe(8);
    expect(qualityFor('google/gemini-3.5-flash-lite')).toBe(5);
    expect(qualityFor('mistralai/mistral-large-3-2512')).toBe(8);
    expect(qualityFor('minimax/minimax-m2.1')).toBe(7);
    expect(qualityFor('totally/unknown-model')).toBeUndefined();
  });

  it('never overwrites curated ratings', () => {
    const annotated = annotateQuality([
      { id: 'x/claude-sonnet-9000', tags: [], quality: 3 },
      { id: 'mistralai/mistral-large-3', tags: [] },
    ]);
    expect(annotated[0]!.quality).toBe(3);
    expect(annotated[1]!.quality).toBe(8);
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

  it('detects work requests but not chit-chat', () => {
    for (const t of [
      'make it look more modern',
      'add a scoreboard',
      'fix the hover bug',
      'can you refactor this into modules',
      'redesign the header',
      'continue',
      'keep going where you left off',
      '```ts\nconst x = 1\n```',
    ]) {
      expect(looksLikeWorkRequest(t)).toBe(true);
    }
    for (const t of ['hello', 'hey there', 'thanks!', 'what does this project do?', 'nice, cool']) {
      expect(looksLikeWorkRequest(t)).toBe(false);
    }
  });

  it('a terse agentic build turn still demands a capable executor', () => {
    // "make it look more modern" is trivial by length, but in a folder-backed
    // project it means editing code — must not route to a cheap quality-6 model
    // that only narrates the change.
    const chatty = signalFromPrompt('make it look more modern');
    expect(complexityOf(chatty)).toBe(0);

    // Builder mode sets both flags: tools required + agentic quality floor.
    const agentic = signalFromPrompt('make it look more modern', {
      agentic: true,
      needsTools: true,
    });
    expect(complexityOf(agentic)).toBe(2); // floored to the "complex" bar
    const [top] = suggest(agentic, catalog, bigBox);
    expect(top!.model.supportsTools).toBe(true);
    expect(top!.model.quality ?? 0).toBeGreaterThanOrEqual(8);
    expect(top!.rationale).toMatch(/complex task/);
  });

  it('vision requirement filters non-vision models', () => {
    const signal = signalFromPrompt('what is in this screenshot?', { needsVision: true });
    const ranked = suggest(signal, catalog, smallBox);
    expect(ranked.length).toBeGreaterThan(0);
    for (const r of ranked) expect(r.model.supportsVision).toBe(true);
  });

  it('image-generation models never get routed, even at top quality', () => {
    const withImageGen: ModelRecord[] = [
      ...catalog,
      {
        id: 'google/gemini-3-pro-image',
        provider: 'openrouter',
        displayName: 'Nano Banana Pro',
        quality: 9.5,
        outputsImage: true,
        supportsTools: true,
        supportsVision: true,
        tags: [],
        pricing: { inputPerMTok: 1, outputPerMTok: 4 },
      },
    ];
    const ranked = suggest(signalFromPrompt('continue'), withImageGen, bigBox, 50, { tier: 'best' });
    expect(ranked.some((r) => r.model.id === 'google/gemini-3-pro-image')).toBe(false);
  });

  it('routing tiers reorder the same pool: cheap vs balanced vs best', () => {
    const signal = signalFromPrompt('short question');
    const cheap = suggest(signal, catalog, bigBox, 1, { tier: 'cheap' })[0]!;
    const best = suggest(signal, catalog, bigBox, 1, { tier: 'best' })[0]!;
    // Best tier ignores price: quality strictly >= the cheap pick, and the
    // top-quality model of the pool wins.
    expect(best.model.quality ?? 0).toBeGreaterThanOrEqual(cheap.model.quality ?? 0);
    const maxQ = Math.max(...suggest(signal, catalog, bigBox, 50).map((r) => r.model.quality ?? 0));
    expect(best.model.quality).toBe(maxQ);
    expect(best.rationale).toContain('best in class');
    expect(cheap.rationale).toContain('cheapest capable');
    const balanced = suggest(signal, catalog, bigBox, 1, { tier: 'balanced' })[0]!;
    expect(balanced.rationale).toContain('mid-price capable');
  });

  it('hardware filters local models that do not fit', () => {
    const signal = signalFromPrompt('short question');
    const ranked = suggest(signal, catalog, smallBox, 20);
    expect(ranked.some((r) => r.model.id === 'llama3.3:70b')).toBe(false);
    const rankedBig = suggest(signal, catalog, bigBox, 20);
    expect(rankedBig.some((r) => r.model.id === 'llama3.3:70b')).toBe(true);
  });
});
