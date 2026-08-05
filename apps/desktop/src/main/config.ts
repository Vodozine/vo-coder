import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_CONFIG, type AppConfig } from '../shared/ipc-contract';

/** Non-secret app config, plain JSON under userData. Secrets live in SecretStore. */
export class ConfigStore {
  private path = join(app.getPath('userData'), 'config.json');
  private cache: AppConfig | null = null;
  /** The generic folder is created once per process, not on every get(). */
  private genericEnsured = '';

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
        // Older configs lack disabledProviders — treat as all enabled.
        if (!Array.isArray(this.cache.disabledProviders)) {
          this.cache.disabledProviders = [];
        }
        // Older configs predate multi-endpoint local servers.
        if (!Array.isArray(this.cache.ollamaExtraEndpoints)) {
          this.cache.ollamaExtraEndpoints = [];
        }
        if (!Array.isArray(this.cache.llamacppEndpoints)) {
          this.cache.llamacppEndpoints = [];
        }
      } catch {
        this.cache = { ...DEFAULT_CONFIG };
      }
    }
    // First install (or a cleared setting): the generic scratch folder lives
    // in Documents so the user can find what their chats wrote. Ensured on
    // disk so a folder-less chat's very first ws_write cannot dead-end.
    if (!this.cache.genericDir) {
      this.cache.genericDir = join(app.getPath('documents'), 'Vo-Coder');
    }
    if (this.genericEnsured !== this.cache.genericDir) {
      try {
        mkdirSync(this.cache.genericDir, { recursive: true });
        this.genericEnsured = this.cache.genericDir;
      } catch {
        /* unwritable location — the picker in Settings is the fix */
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
