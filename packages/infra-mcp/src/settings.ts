import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_PERMISSIONS, type PermissionSettings } from './permissions.js';

export interface TlsConfig {
  rejectUnauthorized: boolean;
}

export interface ConnectionConfig {
  driver: 'proxmox';
  host: string;
  port?: number;
  user?: string;
  tokenId?: string;
  /** Literal secret, or "env:VAR_NAME" to read from the environment. */
  tokenSecret?: string;
  tls?: TlsConfig;
}

export interface DiscoveryCache {
  at: string;
  runtimes: Array<{ name: string; version: string; path: string }>;
  containers: { docker?: string; podman?: string };
  hypervisors: Array<{ connection: string; driver: string; reachable: boolean; version?: string }>;
  hardware: { platform: string; arch: string; cpuModel: string; cpuCount: number; totalMemGb: number };
}

export interface InfraSettings {
  version: 1;
  permissions: PermissionSettings;
  connections: Record<string, ConnectionConfig>;
  discovery?: DiscoveryCache;
}

export const DEFAULT_SETTINGS: InfraSettings = {
  version: 1,
  permissions: DEFAULT_PERMISSIONS,
  connections: {},
};

/** Resolution: VO_INFRA_SETTINGS env var → ./MCP_SETTINGS.json in cwd. */
export function settingsPath(): string {
  return resolve(process.env.VO_INFRA_SETTINGS ?? 'MCP_SETTINGS.json');
}

export class SettingsStore {
  private cache: InfraSettings | null = null;

  constructor(private path: string = settingsPath()) {}

  get(): InfraSettings {
    if (!this.cache) {
      try {
        const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<InfraSettings>;
        this.cache = {
          ...DEFAULT_SETTINGS,
          ...raw,
          permissions: { ...DEFAULT_PERMISSIONS, ...raw.permissions },
          connections: raw.connections ?? {},
        };
      } catch {
        this.cache = structuredClone(DEFAULT_SETTINGS);
      }
    }
    return this.cache;
  }

  save(patch: Partial<InfraSettings>): InfraSettings {
    const next = { ...this.get(), ...patch };
    this.cache = next;
    writeFileSync(this.path, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  location(): string {
    return this.path;
  }

  resolveSecret(conn: ConnectionConfig): string | undefined {
    const raw = conn.tokenSecret;
    if (!raw) return undefined;
    if (raw.startsWith('env:')) return process.env[raw.slice(4)];
    return raw;
  }

  /**
   * Export for sharing/reuse on another machine: literal secrets are replaced
   * with env-references so credentials never travel in the file.
   */
  exportable(): InfraSettings {
    const s = structuredClone(this.get());
    for (const [name, conn] of Object.entries(s.connections)) {
      if (conn.tokenSecret && !conn.tokenSecret.startsWith('env:')) {
        conn.tokenSecret = `env:${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_TOKEN`;
      }
    }
    return s;
  }
}
