#!/usr/bin/env node
import { resolve } from 'node:path';
import * as p from '@clack/prompts';
import { detectProject } from './detect.js';
import { injectScaffold } from './inject.js';
import { answer, current, isComplete, progress, start, toAnswers } from './questionnaire.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const dirArg = args.find((a) => !a.startsWith('-')) ?? '.';
  const dir = resolve(process.cwd(), dirArg);

  p.intro('vo-scaffold — markdown-driven project setup');

  const detection = detectProject(dir);
  p.log.info(
    `Target: ${dir}\nDetected: ${detection.state}` +
      (detection.markers.length ? ` (markers: ${detection.markers.join(', ')})` : ''),
  );
  if (detection.state === 'managed' && !force) {
    p.log.warn('This folder already has a PROJECT_CONFIG.md. Re-run with --force to regenerate.');
    p.outro('Nothing written.');
    return;
  }
  if (detection.state === 'existing') {
    p.log.info('Existing project — only missing files will be written, nothing overwritten.');
  }

  let state = start();
  while (!isComplete(state)) {
    const q = current(state)!;
    const { done, total } = progress(state);
    const label = `[${done + 1}/${total}] ${q.prompt}`;
    let value: unknown;
    if (q.kind === 'select') {
      // Beginners get each option explained (skill level always is — it's
      // answered before we know who we're talking to).
      const explain = q.id === 'skillLevel' || state.answers.skillLevel === 'beginner';
      if (explain && q.beginnerHint) p.log.info(q.beginnerHint);
      value = await p.select({
        message: label,
        options: q.options!.map((o) => ({
          value: o.value,
          label: o.label,
          ...(explain && o.description ? { hint: o.description } : {}),
        })),
      });
    } else {
      value = await p.text({
        message: label,
        placeholder: q.hint,
        defaultValue: q.optional ? '' : undefined,
      });
    }
    if (p.isCancel(value)) {
      p.cancel('Cancelled — nothing written.');
      return;
    }
    try {
      state = answer(state, String(value ?? ''));
    } catch (err) {
      p.log.error(err instanceof Error ? err.message : String(err));
    }
  }

  const result = injectScaffold(dir, toAnswers(state), {
    force,
    generatedAt: new Date().toISOString(),
  });
  if (result.refused) {
    p.log.warn(result.refused);
  }
  if (result.written.length) p.log.success(`Written: ${result.written.join(', ')}`);
  if (result.skipped.length) p.log.info(`Skipped (already present): ${result.skipped.join(', ')}`);
  for (const w of result.warnings) p.log.warn(w);
  p.outro('Your PROJECT_CONFIG.md is the north star — the harness and infra MCP read it.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
