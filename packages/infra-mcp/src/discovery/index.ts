import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import type { DiscoveryCache, SettingsStore } from '../settings.js';
import type { DriverContext, InfraDriver } from '../drivers/types.js';

export type Exec = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

const pExec = promisify(exec);
/**
 * Runs through a shell so Windows .cmd shims (npm, docker wrappers) resolve.
 * Only ever invoked with the static candidate list above — never user input.
 */
export const defaultExec: Exec = async (cmd, args) => {
  const r = await pExec([cmd, ...args].join(' '), { timeout: 8000, windowsHide: true });
  return { stdout: String(r.stdout) };
};

const RUNTIME_CANDIDATES: Array<{ name: string; cmd: string; args: string[] }> = [
  { name: 'node', cmd: 'node', args: ['--version'] },
  { name: 'npm', cmd: 'npm', args: ['--version'] },
  { name: 'git', cmd: 'git', args: ['--version'] },
  { name: 'python', cmd: 'python', args: ['--version'] },
  { name: 'pip', cmd: 'pip', args: ['--version'] },
  { name: 'docker', cmd: 'docker', args: ['--version'] },
  { name: 'podman', cmd: 'podman', args: ['--version'] },
  { name: 'cargo', cmd: 'cargo', args: ['--version'] },
  { name: 'go', cmd: 'go', args: ['version'] },
  { name: 'java', cmd: 'java', args: ['--version'] },
  { name: 'terraform', cmd: 'terraform', args: ['--version'] },
  { name: 'kubectl', cmd: 'kubectl', args: ['version', '--client'] },
];

async function locate(exec: Exec, cmd: string): Promise<string | null> {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const { stdout } = await exec(finder, [cmd]);
    const first = stdout.split(/\r?\n/).find((l) => l.trim());
    return first?.trim() ?? null;
  } catch {
    return null;
  }
}

export async function detectRuntimes(exec: Exec): Promise<DiscoveryCache['runtimes']> {
  const out: DiscoveryCache['runtimes'] = [];
  await Promise.all(
    RUNTIME_CANDIDATES.map(async ({ name, cmd, args }) => {
      const path = await locate(exec, cmd);
      if (!path) return;
      try {
        const { stdout } = await exec(cmd, args);
        const version = stdout.split(/\r?\n/).find((l) => l.trim())?.trim() ?? 'unknown';
        out.push({ name, version, path });
      } catch {
        out.push({ name, version: 'found but version check failed', path });
      }
    }),
  );
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function detectContainers(exec: Exec): Promise<DiscoveryCache['containers']> {
  const containers: DiscoveryCache['containers'] = {};
  try {
    const { stdout } = await exec('docker', ['info', '--format', '{{.ServerVersion}}']);
    const v = stdout.trim();
    if (v) containers.docker = `daemon running, server ${v}`;
  } catch {
    // docker CLI missing or daemon down — runtimes list still shows the CLI if present.
  }
  try {
    const { stdout } = await exec('podman', ['version', '--format', '{{.Server.Version}}']);
    const v = stdout.trim();
    if (v) containers.podman = `running, server ${v}`;
  } catch {
    /* same */
  }
  return containers;
}

export async function detectHypervisors(
  settings: SettingsStore,
  drivers: InfraDriver[],
): Promise<DiscoveryCache['hypervisors']> {
  const ctx: DriverContext = { settings };
  const out: DiscoveryCache['hypervisors'] = [];
  for (const [name, conn] of Object.entries(settings.get().connections)) {
    const driver = drivers.find((d) => d.id === conn.driver);
    if (!driver) {
      out.push({ connection: name, driver: conn.driver, reachable: false });
      continue;
    }
    const probe = await driver.probe(conn, ctx);
    out.push({
      connection: name,
      driver: conn.driver,
      reachable: probe.reachable,
      ...(probe.version ? { version: probe.version } : {}),
    });
  }
  if (process.platform === 'win32' && existsSync('C:\\Windows\\System32\\vmms.exe')) {
    out.push({ connection: '(local)', driver: 'hyper-v', reachable: true });
  }
  return out;
}

export function detectHardware(): DiscoveryCache['hardware'] {
  const cpus = os.cpus();
  return {
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: cpus[0]?.model.trim() ?? 'unknown',
    cpuCount: cpus.length,
    totalMemGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
  };
}

export async function runDiscovery(
  settings: SettingsStore,
  drivers: InfraDriver[],
  exec: Exec = defaultExec,
  now: () => string = () => new Date().toISOString(),
): Promise<DiscoveryCache> {
  const [runtimes, containers, hypervisors] = await Promise.all([
    detectRuntimes(exec),
    detectContainers(exec),
    detectHypervisors(settings, drivers),
  ]);
  return { at: now(), runtimes, containers, hypervisors, hardware: detectHardware() };
}
