import type { ProjectAnswers } from '@vo-coder/project-config';
import { QUESTIONS, type QuestionDef } from './questions.js';

/**
 * Pure questionnaire state machine — no I/O. The CLI drives it with terminal
 * prompts; the Electron wizard drives the identical machine as a React flow.
 */

export interface QuestionnaireState {
  answers: Record<string, string>;
  /** ids already answered, in order (enables back-navigation). */
  answered: string[];
}

export function start(): QuestionnaireState {
  return { answers: {}, answered: [] };
}

/**
 * Pre-apply remembered answers (e.g. environment questions from an earlier
 * project) so those questions are skipped. Walks in question order so
 * dependsOn chains resolve; invalid or non-applicable seeds are ignored.
 * Seeded ids land in `answered`, so back() can still unwind into them.
 */
export function seedAnswers(
  state: QuestionnaireState,
  seeds: Record<string, string>,
  onlyIds?: readonly string[],
): QuestionnaireState {
  let next = state;
  for (const q of QUESTIONS) {
    if (onlyIds && !onlyIds.includes(q.id)) continue;
    const value = seeds[q.id];
    if (value === undefined || q.id in next.answers) continue;
    if (q.dependsOn && next.answers[q.dependsOn.key] !== q.dependsOn.equals) continue;
    if (q.kind === 'select' && !q.options!.some((o) => o.value === value)) continue;
    next = {
      answers: { ...next.answers, [q.id]: value },
      answered: [...next.answered, q.id],
    };
  }
  return next;
}

function isVisible(q: QuestionDef, answers: Record<string, string>): boolean {
  return !q.dependsOn || answers[q.dependsOn.key] === q.dependsOn.equals;
}

/** All questions that apply given current answers, in order. */
export function visibleQuestions(state: QuestionnaireState): QuestionDef[] {
  return QUESTIONS.filter((q) => isVisible(q, state.answers));
}

/** The next unanswered visible question, or null when complete. */
export function current(state: QuestionnaireState): QuestionDef | null {
  return visibleQuestions(state).find((q) => !(q.id in state.answers)) ?? null;
}

export function isComplete(state: QuestionnaireState): boolean {
  return current(state) === null;
}

export function answer(state: QuestionnaireState, value: string): QuestionnaireState {
  const q = current(state);
  if (!q) throw new Error('Questionnaire is already complete.');
  const trimmed = value.trim();
  if (!trimmed && !q.optional) {
    throw new Error(`"${q.prompt}" needs an answer.`);
  }
  if (q.kind === 'select' && !q.options!.some((o) => o.value === trimmed)) {
    throw new Error(
      `"${trimmed}" is not an option for "${q.prompt}". Options: ${q.options!.map((o) => o.value).join(', ')}`,
    );
  }
  const answers = { ...state.answers, [q.id]: trimmed };
  // Drop answers to questions that are no longer visible (e.g. switched away
  // from 'other' language) so stale branches never leak into the config.
  for (const prev of QUESTIONS) {
    if (prev.id in answers && !isVisible(prev, answers)) delete answers[prev.id];
  }
  return { answers, answered: [...state.answered, q.id] };
}

/** Undo the most recent answer. */
export function back(state: QuestionnaireState): QuestionnaireState {
  const last = state.answered[state.answered.length - 1];
  if (!last) return state;
  const answers = { ...state.answers };
  delete answers[last];
  return { answers, answered: state.answered.slice(0, -1) };
}

export function progress(state: QuestionnaireState): { done: number; total: number } {
  const visible = visibleQuestions(state);
  return { done: visible.filter((q) => q.id in state.answers).length, total: visible.length };
}

export function toAnswers(state: QuestionnaireState): ProjectAnswers {
  if (!isComplete(state)) throw new Error('Questionnaire is not complete yet.');
  const a = state.answers;
  return {
    description: a.description!,
    skillLevel: a.skillLevel as ProjectAnswers['skillLevel'],
    projectType: a.projectType as ProjectAnswers['projectType'],
    language: a.language as ProjectAnswers['language'],
    ...(a.languageOther ? { languageOther: a.languageOther } : {}),
    virtualization: a.virtualization as ProjectAnswers['virtualization'],
    ...(a.hypervisorKind ? { hypervisorKind: a.hypervisorKind } : {}),
    devOs: a.devOs as ProjectAnswers['devOs'],
    philosophy: a.philosophy ?? '',
  };
}
