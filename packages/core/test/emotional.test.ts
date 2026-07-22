import { describe, expect, it } from 'vitest';
import { detectTone, EmotionalMiddleware, similarity } from '../src/middleware/emotional.ts';

describe('similarity', () => {
  it('scores near-duplicates high and different asks low', () => {
    expect(similarity('add a dark mode toggle', 'add a dark mode toggle please')).toBeGreaterThan(
      0.72,
    );
    expect(similarity('add dark mode', 'fix the login crash')).toBeLessThan(0.4);
    expect(similarity('same', 'same')).toBe(1);
  });
});

describe('detectTone', () => {
  it('flags shouting and punctuation bursts, not normal text', () => {
    expect(detectTone('WHY IS THIS STILL BROKEN')).toBe(true);
    expect(detectTone('fix it!!!')).toBe(true);
    expect(detectTone('please fix the login page')).toBe(false);
    expect(detectTone('Use the API')).toBe(false); // short acronyms are fine
  });
});

describe('EmotionalMiddleware', () => {
  const T = 1_000_000;

  it('triggers a reset check-in on the third near-identical ask, across sessions', () => {
    const mw = new EmotionalMiddleware();
    expect(mw.observe('s1', 'make the sidebar collapsible', T).triggered).toBe(false);
    expect(mw.observe('s1', 'make the sidebar collapsible please', T + 60_000).triggered).toBe(
      false,
    );
    const third = mw.observe('s2', 'make the sidebar collapsible!!', T + 120_000);
    expect(third.triggered).toBe(true);
    expect(third.reasons[0]).toMatch(/3 times/);
    expect(third.prompt).toMatch(/walk me through exactly what you need/);
  });

  it('rapid-fire + aggressive tone triggers the wrong-path question', () => {
    const mw = new EmotionalMiddleware();
    mw.observe('s1', 'run the build again', T);
    mw.observe('s1', 'now check the output logs', T + 1000);
    mw.observe('s1', 'try the other config file', T + 2000);
    const burst = mw.observe('s1', 'JUST MAKE IT WORK ALREADY!!!', T + 3000);
    expect(burst.triggered).toBe(true);
    expect(burst.prompt).toMatch(/wrong path/);
  });

  it('short acknowledgements never count as repeats (false-positive guard)', () => {
    const mw = new EmotionalMiddleware();
    expect(mw.observe('s1', 'ok', T).triggered).toBe(false);
    expect(mw.observe('s1', 'ok', T + 60_000).triggered).toBe(false);
    expect(mw.observe('s1', 'ok', T + 120_000).triggered).toBe(false);
    expect(mw.observe('s1', 'yes', T + 180_000).triggered).toBe(false);
  });

  it('calm, distinct requests never trigger', () => {
    const mw = new EmotionalMiddleware();
    const asks = [
      'add a settings page',
      'now wire up the theme switcher',
      'write tests for the config store',
      'update the readme with install steps',
    ];
    for (const [i, ask] of asks.entries()) {
      expect(mw.observe('s1', ask, T + i * 30_000).triggered).toBe(false);
    }
  });

  it('cross-session memory survives via export/seed round-trip', () => {
    const first = new EmotionalMiddleware();
    first.observe('s1', 'export my notes to markdown files', T);
    first.observe('s1', 'export my notes to markdown files', T + 60_000);
    // "App restart": new instance seeded with the persisted log.
    const second = new EmotionalMiddleware({}, first.exportLog());
    const result = second.observe('s2', 'please export my notes to markdown files', T + 999_000);
    expect(result.triggered).toBe(true);
  });
});
