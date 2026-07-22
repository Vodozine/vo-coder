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
        const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<AppConfig>;
        this.cache = { ...DEFAULT_CONFIG, ...raw };
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
