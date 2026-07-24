import { describe, expect, it } from 'vitest';
import { BENCH_MS, MAX_STRIKES, ModelStrikes } from '../src/strikes.ts';

describe('ModelStrikes', () => {
  it('benches a model after MAX_STRIKES consecutive failures', () => {
    const s = new ModelStrikes();
    expect(s.fail('openai', 'gpt-5-codex', 'deprecated')).toBe(false);
    expect(s.benched('openai', 'gpt-5-codex')).toBe(false); // one strike — still routable
    expect(s.fail('openai', 'gpt-5-codex', 'deprecated')).toBe(true);
    expect(s.benched('openai', 'gpt-5-codex')).toBe(true);
    expect(s.benchedModels()).toEqual(['gpt-5-codex']);
  });

  it('a successful run clears the record', () => {
    const s = new ModelStrikes();
    s.fail('openai', 'gpt-5-codex');
    s.ok('openai', 'gpt-5-codex');
    s.fail('openai', 'gpt-5-codex');
    expect(s.benched('openai', 'gpt-5-codex')).toBe(false); // never reached 2 in a row
  });

  it('the bench expires and the model gets a fresh set of tries', () => {
    let t = 1_000;
    const s = new ModelStrikes(() => t);
    for (let i = 0; i < MAX_STRIKES; i++) s.fail('openai', 'gpt-5-codex');
    expect(s.benched('openai', 'gpt-5-codex')).toBe(true);
    t += BENCH_MS + 1;
    expect(s.benched('openai', 'gpt-5-codex')).toBe(false);
    // Fresh window: one new failure is not an instant re-bench.
    expect(s.fail('openai', 'gpt-5-codex')).toBe(false);
    expect(s.benched('openai', 'gpt-5-codex')).toBe(false);
  });

  it('strikes are per provider:model and case-insensitive', () => {
    const s = new ModelStrikes();
    s.fail('openai', 'GPT-5-Codex');
    s.fail('OpenAI', 'gpt-5-codex');
    expect(s.benched('openai', 'gpt-5-codex')).toBe(true);
    expect(s.benched('openrouter', 'gpt-5-codex')).toBe(false); // other provider unaffected
  });
});
