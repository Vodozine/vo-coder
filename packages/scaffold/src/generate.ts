import { readFileSync } from 'node:fs';
import {
  configMarker,
  languageLabel,
  type ProjectAnswers,
  type ProjectConfig,
} from '@vo-coder/project-config';
import { render } from './render.js';

const SECTION_ORDER = [
  'scaffolding',
  'dependencies',
  'dev-environment',
  'testing',
  'staging',
  'deployment',
  'monitoring',
  'rollback',
  'learning-loop',
] as const;

function template(rel: string): string {
  // Fallback chain covers bundled/packaged hosts where import.meta.url no
  // longer points into this package (env override → Electron resources dir).
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  const candidates: Array<URL | string> = [
    ...(process.env.VO_SCAFFOLD_TEMPLATES
      ? [`${process.env.VO_SCAFFOLD_TEMPLATES}/${rel}`]
      : []),
    new URL(`../templates/${rel}`, import.meta.url),
    ...(resourcesPath ? [`${resourcesPath}/scaffold-templates/${rel}`] : []),
  ];
  let lastErr: unknown;
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Template not found: ${rel}`);
}

export function readSetupTemplate(): string {
  return template('PROJECT_SETUP.md');
}

export interface GenerateOptions {
  /** ISO timestamp recorded in the config; injected for deterministic tests. */
  generatedAt?: string;
}

export interface GenerateResult {
  markdown: string;
  warnings: string[];
}

export function generateConfig(
  answers: ProjectAnswers,
  opts: GenerateOptions = {},
): GenerateResult {
  const config: ProjectConfig = {
    version: 1,
    ...(opts.generatedAt ? { generatedAt: opts.generatedAt } : {}),
    answers,
  };
  const ctx: Record<string, unknown> = {
    answers,
    languageLabel: languageLabel(answers),
    marker: configMarker(config),
  };

  const warnings: string[] = [];
  const parts: string[] = [];
  const base = render(template('config/base.md'), ctx);
  warnings.push(...base.warnings);
  parts.push(base.output.trimEnd());

  for (const section of SECTION_ORDER) {
    const result = render(template(`config/sections/${section}.md`), ctx);
    warnings.push(...result.warnings.map((w) => `${section}: ${w}`));
    const body = result.output.trim();
    if (body) parts.push(body);
  }

  return { markdown: parts.join('\n\n') + '\n', warnings };
}
