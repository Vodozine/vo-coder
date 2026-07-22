/**
 * Renderer-safe subset (no node:fs) — imported by the Electron renderer wizard.
 * `@vo-coder/scaffold` (the main entry) adds the node-side generate/detect/inject.
 */
export { QUESTIONS } from './questions.js';
export type { QuestionDef, QuestionOption } from './questions.js';
export {
  answer,
  back,
  current,
  isComplete,
  progress,
  start,
  toAnswers,
  visibleQuestions,
} from './questionnaire.js';
export type { QuestionnaireState } from './questionnaire.js';
export { render } from './render.js';
export type { RenderResult } from './render.js';
