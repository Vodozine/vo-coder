import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectAnswers } from '@vo-coder/project-config';
import { detectProject } from '../src/detect.ts';
import { injectScaffold } from '../src/inject.ts';

const answers: ProjectAnswers = {
  description: 'Temp project',
  skillLevel: 'beginner',
  projectType: 'cli',
  language: 'go',
  virtualization: 'none',
  devOs: 'linux',
  philosophy: '',
};

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vo-scaffold-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('detectProject', () => {
  it('empty dir → new', () => {
    expect(detectProject(tempDir()).state).toBe('new');
  });

  it('dotfiles-only dir → new', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.env'), 'X=1');
    expect(detectProject(dir).state).toBe('new');
  });

  it('structure markers → existing, with markers reported', () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, 'package.json'), '{}');
    const d = detectProject(dir);
    expect(d.state).toBe('existing');
    expect(d.markers).toEqual(expect.arrayContaining(['.git', 'package.json']));
  });

  it('non-empty without markers → existing (read-don\'t-overwrite is the safe default)', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'photo.png'), 'not really a png');
    expect(detectProject(dir).state).toBe('existing');
  });

  it('PROJECT_CONFIG.md → managed, config parsed', () => {
    const dir = tempDir();
    injectScaffold(dir, answers);
    const d = detectProject(dir);
    expect(d.state).toBe('managed');
    expect(d.config?.answers.language).toBe('go');
  });
});

describe('injectScaffold', () => {
  it('new dir: writes both files', () => {
    const dir = tempDir();
    const r = injectScaffold(dir, answers);
    expect(r.written.sort()).toEqual(['PROJECT_CONFIG.md', 'PROJECT_SETUP.md']);
    expect(readFileSync(join(dir, 'PROJECT_CONFIG.md'), 'utf8')).toContain('Temp project');
  });

  it('managed dir: refuses without force, regenerates with force', () => {
    const dir = tempDir();
    injectScaffold(dir, answers);
    const refused = injectScaffold(dir, { ...answers, description: 'Changed!' });
    expect(refused.refused).toMatch(/force/i);
    expect(refused.written).toEqual([]);
    expect(readFileSync(join(dir, 'PROJECT_CONFIG.md'), 'utf8')).toContain('Temp project');

    const forced = injectScaffold(dir, { ...answers, description: 'Changed!' }, { force: true });
    expect(forced.written).toContain('PROJECT_CONFIG.md');
    expect(readFileSync(join(dir, 'PROJECT_CONFIG.md'), 'utf8')).toContain('Changed!');
  });

  it('existing dir: writes only missing files and reports skips', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, 'PROJECT_SETUP.md'), 'my own setup notes');
    const r = injectScaffold(dir, answers);
    expect(r.detection.state).toBe('existing');
    expect(r.written).toEqual(['PROJECT_CONFIG.md']);
    expect(r.skipped).toEqual(['PROJECT_SETUP.md']);
    expect(readFileSync(join(dir, 'PROJECT_SETUP.md'), 'utf8')).toBe('my own setup notes');
  });
});
