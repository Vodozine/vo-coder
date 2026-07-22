import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectAnswers } from '@vo-coder/project-config';
import { detectProject, type Detection } from './detect.js';
import { generateConfig, readSetupTemplate, type GenerateOptions } from './generate.js';

export interface InjectResult {
  detection: Detection;
  written: string[];
  skipped: string[];
  warnings: string[];
  /** Set when nothing was written and the caller must pass force to proceed. */
  refused?: string;
}

/**
 * Writes PROJECT_SETUP.md + PROJECT_CONFIG.md into a project folder.
 * Never clobbers: managed folders refuse without `force`; existing folders
 * only receive files that don't already exist.
 */
export function injectScaffold(
  dir: string,
  answers: ProjectAnswers,
  opts: GenerateOptions & { force?: boolean } = {},
): InjectResult {
  const detection = detectProject(dir);
  const written: string[] = [];
  const skipped: string[] = [];

  if (detection.state === 'managed' && !opts.force) {
    return {
      detection,
      written,
      skipped: ['PROJECT_CONFIG.md', 'PROJECT_SETUP.md'],
      warnings: [],
      refused:
        'This folder already has a PROJECT_CONFIG.md. Re-run with force to regenerate it.',
    };
  }

  const { markdown, warnings } = generateConfig(answers, opts);
  mkdirSync(dir, { recursive: true });

  const writeIfAllowed = (name: string, content: string, overwrite: boolean): void => {
    const path = join(dir, name);
    if (!overwrite && existsSync(path)) {
      skipped.push(name);
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
    written.push(name);
  };

  // The config is the artifact being (re)generated; the setup guide is
  // reference material and is never overwritten.
  writeIfAllowed('PROJECT_CONFIG.md', markdown, detection.state !== 'existing' || !!opts.force);
  writeIfAllowed('PROJECT_SETUP.md', readSetupTemplate(), false);

  return { detection, written, skipped, warnings };
}
