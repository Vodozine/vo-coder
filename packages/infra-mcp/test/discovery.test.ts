import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectContainers, detectRuntimes, runDiscovery, type Exec } from '../src/discovery/index.ts';
import { renderEnvironmentMd } from '../src/environment-md.ts';
import { SettingsStore } from '../src/settings.ts';

/** Fake exec: knows about node/git, docker CLI present but daemon down. */
const fakeExec: Exec = async (cmd, args) => {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  if (cmd === finder) {
    const target = args[0];
    if (target === 'node') return { stdout: 'C:\\Program Files\\nodejs\\node.exe\n' };
    if (target === 'git') return { stdout: 'C:\\Program Files\\Git\\cmd\\git.exe\n' };
    if (target === 'docker') return { stdout: 'C:\\docker\\docker.exe\n' };
    throw new Error('not found');
  }
  if (cmd === 'node') return { stdout: 'v24.15.0\n' };
  if (cmd === 'git') return { stdout: 'git version 2.49.0.windows.1\n' };
  if (cmd === 'docker' && args[0] === '--version') return { stdout: 'Docker version 27.0.1\n' };
  if (cmd === 'docker' && args[0] === 'info') throw new Error('daemon not running');
  throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`);
};

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function store(): SettingsStore {
  const dir = mkdtempSync(join(tmpdir(), 'vo-disc-'));
  dirs.push(dir);
  return new SettingsStore(join(dir, 'MCP_SETTINGS.json'));
}

describe('discovery', () => {
  it('detects present runtimes with versions and skips missing ones', async () => {
    const runtimes = await detectRuntimes(fakeExec);
    const names = runtimes.map((r) => r.name);
    expect(names).toContain('node');
    expect(names).toContain('git');
    expect(names).not.toContain('cargo');
    expect(runtimes.find((r) => r.name === 'node')).toMatchObject({ version: 'v24.15.0' });
  });

  it('reports no container daemon when docker info fails', async () => {
    expect(await detectContainers(fakeExec)).toEqual({});
  });

  it('runDiscovery composes a cache and environment markdown renders every section', async () => {
    const d = await runDiscovery(store(), [], fakeExec, () => '2026-07-22T00:00:00.000Z');
    expect(d.at).toBe('2026-07-22T00:00:00.000Z');
    expect(d.hardware.cpuCount).toBeGreaterThan(0);
    const md = renderEnvironmentMd(d);
    expect(md).toContain('# MCP Environment');
    expect(md).toContain('## Hardware');
    expect(md).toContain('**node** — v24.15.0');
    expect(md).toContain('No running container daemon detected');
  });
});
