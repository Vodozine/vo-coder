import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsStore } from '../src/settings.ts';

const dirs: string[] = [];
function store(): SettingsStore {
  const dir = mkdtempSync(join(tmpdir(), 'vo-infra-'));
  dirs.push(dir);
  return new SettingsStore(join(dir, 'MCP_SETTINGS.json'));
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  delete process.env.TEST_PVE_TOKEN;
});

describe('SettingsStore', () => {
  it('starts from defaults and persists saves', () => {
    const s = store();
    expect(s.get().permissions.maxTier).toBe('read');
    s.save({ permissions: { maxTier: 'write' } });
    const reread = new SettingsStore(s.location());
    expect(reread.get().permissions.maxTier).toBe('write');
  });

  it('resolves env-referenced secrets', () => {
    const s = store();
    process.env.TEST_PVE_TOKEN = 'sekrit';
    expect(
      s.resolveSecret({ driver: 'proxmox', host: 'h', tokenSecret: 'env:TEST_PVE_TOKEN' }),
    ).toBe('sekrit');
    expect(s.resolveSecret({ driver: 'proxmox', host: 'h', tokenSecret: 'literal-value' })).toBe(
      'literal-value',
    );
  });

  it('export replaces literal secrets with env-references (never writes credentials)', () => {
    const s = store();
    s.save({
      connections: {
        homelab: { driver: 'proxmox', host: '10.0.0.1', tokenSecret: 'super-secret-uuid' },
        other: { driver: 'proxmox', host: '10.0.0.2', tokenSecret: 'env:ALREADY_REF' },
      },
    });
    const exported = s.exportable();
    expect(exported.connections.homelab!.tokenSecret).toBe('env:HOMELAB_TOKEN');
    expect(exported.connections.other!.tokenSecret).toBe('env:ALREADY_REF');
    expect(JSON.stringify(exported)).not.toContain('super-secret-uuid');
    // ...and the on-disk original still has the literal.
    expect(readFileSync(s.location(), 'utf8')).toContain('super-secret-uuid');
  });
});
