import { describe, expect, it } from 'vitest';
import { parseProjectConfig, type ProjectAnswers } from '@vo-coder/project-config';
import { generateConfig } from '../src/generate.ts';

const personas: Record<string, ProjectAnswers> = {
  'beginner-js-app-none-windows': {
    description: 'A todo desktop app',
    skillLevel: 'beginner',
    projectType: 'standalone-app',
    targetPlatform: 'cross-desktop',
    language: 'javascript',
    virtualization: 'none',
    devOs: 'windows',
    philosophy: '',
  },
  'advanced-python-backend-proxmox-linux': {
    description: 'An inference gateway',
    skillLevel: 'advanced',
    projectType: 'backend-service',
    targetPlatform: 'server',
    language: 'python',
    virtualization: 'hypervisor',
    hypervisorKind: 'proxmox',
    devOs: 'linux',
    philosophy: 'anti-e-waste hardware reuse',
  },
  'intermediate-rust-cli-docker-macos': {
    description: 'A log analyzer CLI',
    skillLevel: 'intermediate',
    projectType: 'cli',
    targetPlatform: 'other',
    language: 'rust',
    virtualization: 'docker',
    devOs: 'macos',
    philosophy: 'minimal dependencies',
  },
  // iOS picked on a Windows dev box — the config must carry the cross-build heads-up.
  'beginner-ios-on-windows': {
    description: 'A habit tracker phone app',
    skillLevel: 'beginner',
    projectType: 'standalone-app',
    targetPlatform: 'ios',
    language: 'other',
    languageOther: 'swift',
    virtualization: 'none',
    devOs: 'windows',
    philosophy: '',
  },
};

const GEN_AT = '2026-07-22T00:00:00.000Z';

describe('PROJECT_CONFIG.md generation matrix', () => {
  for (const [name, answers] of Object.entries(personas)) {
    it(`${name}: renders without warnings and matches snapshot`, () => {
      const { markdown, warnings } = generateConfig(answers, { generatedAt: GEN_AT });
      expect(warnings).toEqual([]);
      expect(markdown).toMatchSnapshot();
    });
  }

  it('embeds a lossless machine-readable marker', () => {
    const answers = personas['advanced-python-backend-proxmox-linux']!;
    const { markdown } = generateConfig(answers, { generatedAt: GEN_AT });
    expect(parseProjectConfig(markdown)).toEqual({
      version: 1,
      generatedAt: GEN_AT,
      answers,
    });
  });

  it('conditional sections follow the answers', () => {
    const beginner = generateConfig(personas['beginner-js-app-none-windows']!, {
      generatedAt: GEN_AT,
    }).markdown;
    expect(beginner).toContain('package-lock.json');
    expect(beginner).toContain('one test per block');
    expect(beginner).toContain('No virtualization available');
    expect(beginner).toContain('**Target Platform:** cross-desktop');
    expect(beginner).toContain('Electron, Tauri');
    expect(beginner).not.toContain('Proxmox');
    expect(beginner).not.toContain('pyproject.toml');

    const ios = generateConfig(personas['beginner-ios-on-windows']!, {
      generatedAt: GEN_AT,
    }).markdown;
    expect(ios).toContain('Mac with Xcode');
    expect(ios).toContain('your development OS is not macOS');

    const advanced = generateConfig(personas['advanced-python-backend-proxmox-linux']!, {
      generatedAt: GEN_AT,
    }).markdown;
    expect(advanced).toContain('pyproject.toml');
    expect(advanced).toContain('(proxmox)');
    expect(advanced).toContain('Stage on a dedicated VM');
    expect(advanced).toContain('Philosophy check');
    expect(advanced).not.toContain('package-lock.json');

    const cli = generateConfig(personas['intermediate-rust-cli-docker-macos']!, {
      generatedAt: GEN_AT,
    }).markdown;
    expect(cli).toContain('Cargo.lock');
    expect(cli).toContain('argument parsing in the entry layer');
    expect(cli).toContain('compose file');
  });
});
