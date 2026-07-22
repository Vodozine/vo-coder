import { describe, expect, it } from 'vitest';
import {
  answer,
  back,
  current,
  isComplete,
  progress,
  start,
  toAnswers,
} from '../src/questionnaire.ts';
import type { QuestionnaireState } from '../src/questionnaire.ts';

function answerThrough(state: QuestionnaireState, values: string[]): QuestionnaireState {
  return values.reduce((s, v) => answer(s, v), state);
}

describe('questionnaire state machine', () => {
  it('walks the base 7 questions in the documented order', () => {
    let s = start();
    const seen: string[] = [];
    for (const v of ['My app', 'beginner', 'standalone-app', 'javascript', 'none', 'windows', '']) {
      seen.push(current(s)!.id);
      s = answer(s, v);
    }
    expect(seen).toEqual([
      'description',
      'skillLevel',
      'projectType',
      'language',
      'virtualization',
      'devOs',
      'philosophy',
    ]);
    expect(isComplete(s)).toBe(true);
  });

  it('branches: hypervisorKind only appears when virtualization is hypervisor', () => {
    let s = answerThrough(start(), ['App', 'advanced', 'backend-service', 'python']);
    s = answer(s, 'hypervisor');
    expect(current(s)!.id).toBe('hypervisorKind');
    s = answer(s, 'proxmox');
    expect(current(s)!.id).toBe('devOs');
  });

  it('branches: languageOther only appears for language=other, and its answer is dropped when the branch closes', () => {
    let s = answerThrough(start(), ['App', 'intermediate', 'cli']);
    s = answer(s, 'other');
    expect(current(s)!.id).toBe('languageOther');
    s = answer(s, 'zig');
    // Rewind two steps and pick a mainstream language instead.
    s = back(back(s));
    s = answer(s, 'go');
    expect(s.answers.languageOther).toBeUndefined();
    expect(current(s)!.id).toBe('virtualization');
  });

  it('rejects invalid select values and empty required answers', () => {
    let s = start();
    expect(() => answer(s, '')).toThrow(/needs an answer/);
    s = answer(s, 'App');
    expect(() => answer(s, 'wizard')).toThrow(/not an option/);
  });

  it('progress counts only visible questions', () => {
    let s = answerThrough(start(), ['App', 'beginner', 'cli', 'javascript']);
    expect(progress(s)).toEqual({ done: 4, total: 7 });
    s = answer(s, 'hypervisor'); // adds the hypervisorKind follow-up
    expect(progress(s)).toEqual({ done: 5, total: 8 });
  });

  it('toAnswers produces a complete typed record', () => {
    const s = answerThrough(start(), [
      'My service',
      'advanced',
      'backend-service',
      'python',
      'hypervisor',
      'proxmox',
      'linux',
      'anti e-waste',
    ]);
    expect(toAnswers(s)).toEqual({
      description: 'My service',
      skillLevel: 'advanced',
      projectType: 'backend-service',
      language: 'python',
      virtualization: 'hypervisor',
      hypervisorKind: 'proxmox',
      devOs: 'linux',
      philosophy: 'anti e-waste',
    });
  });
});
