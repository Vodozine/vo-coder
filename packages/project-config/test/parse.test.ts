import { describe, expect, it } from 'vitest';
import {
  configMarker,
  languageLabel,
  parseProjectConfig,
  type ProjectConfig,
} from '../src/index.ts';

const config: ProjectConfig = {
  version: 1,
  generatedAt: '2026-07-22T00:00:00.000Z',
  answers: {
    description: 'A test project',
    skillLevel: 'advanced',
    projectType: 'backend-service',
    language: 'other',
    languageOther: 'zig',
    virtualization: 'hypervisor',
    hypervisorKind: 'proxmox',
    devOs: 'windows',
    philosophy: 'minimal dependencies',
  },
};

describe('project-config round trip', () => {
  it('parses its own marker back losslessly from surrounding markdown', () => {
    const md = `# Project Configuration\n\n${configMarker(config)}\n\n## Your Answers\nwhatever prose…`;
    expect(parseProjectConfig(md)).toEqual(config);
  });

  it('returns null for markdown without a marker or with a broken one', () => {
    expect(parseProjectConfig('# No marker here')).toBeNull();
    expect(parseProjectConfig('<!-- vo-config: {not json} -->')).toBeNull();
  });

  it('languageLabel prefers the free-text name for "other"', () => {
    expect(languageLabel(config.answers)).toBe('zig');
    expect(languageLabel({ ...config.answers, language: 'go', languageOther: undefined })).toBe(
      'go',
    );
  });
});
