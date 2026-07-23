import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_CONFIG, type AppConfig } from '../shared/ipc-contract';

/** Non-secret app config, plain JSON under userData. Secrets live in SecretStore. */
export class ConfigStore {
  private path = join(app.getPath('userData'), 'config.json');
  private cache: AppConfig | null = null;

  get(): AppConfig {
    if (!this.cache) {
      try {
        const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<AppConfig> & {
          autoRoute?: boolean;
        };
        this.cache = { ...DEFAULT_CONFIG, ...raw };
        // Nested objects need their own defaults merged — a config written by
        // an older version would otherwise drop newly added fields.
        this.cache.voice = { ...DEFAULT_CONFIG.voice, ...(raw.voice ?? {}) };
        // Migration: the pre-routeMode boolean.
        if (!raw.routeMode && raw.autoRoute === false) this.cache.routeMode = 'off';
        // Migration: 'grok-cli' was a placeholder guess before the real
        // public client id was verified — auth.x.ai 400s on it.
        if (raw.xaiOauthClientId === 'grok-cli') {
          this.cache.xaiOauthClientId = DEFAULT_CONFIG.xaiOauthClientId;
        }
        // Migration: the short-lived 'guided' label became 'manual'.
        if ((raw as { approvalMode?: string }).approvalMode === 'guided') {
          this.cache.approvalMode = 'manual';
        }
      } catch {
        this.cache = { ...DEFAULT_CONFIG };
      }
    }
    return this.cache;
  }

  set(patch: Partial<AppConfig>): AppConfig {
    const next = { ...this.get(), ...patch };
    this.cache = next;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }
}
