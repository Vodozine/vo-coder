import { app, safeStorage } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * API keys encrypted with the OS keychain (DPAPI / Keychain / kwallet+libsecret)
 * via Electron safeStorage. The renderer never sees raw values — only masked
 * status strings. If OS encryption is unavailable (some Linux setups), values
 * fall back to base64 with a logged warning; a consent path lands in a later
 * phase.
 */
export class SecretStore {
  private path = join(app.getPath('userData'), 'secrets.json');
  private cache: Record<string, string> | null = null;

  private load(): Record<string, string> {
    if (!this.cache) {
      try {
        this.cache = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, string>;
      } catch {
        this.cache = {};
      }
    }
    return this.cache;
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.load(), null, 2), 'utf8');
  }

  set(provider: string, value: string): void {
    const data = this.load();
    if (!value) {
      delete data[provider];
    } else if (safeStorage.isEncryptionAvailable()) {
      data[provider] = safeStorage.encryptString(value).toString('base64');
    } else {
      console.warn('[secrets] OS encryption unavailable — storing obfuscated only');
      data[provider] = `plain:${Buffer.from(value, 'utf8').toString('base64')}`;
    }
    this.persist();
  }

  get(provider: string): string | null {
    const stored = this.load()[provider];
    if (!stored) return null;
    try {
      if (stored.startsWith('plain:')) {
        return Buffer.from(stored.slice(6), 'base64').toString('utf8');
      }
      return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    } catch (err) {
      console.error(`[secrets] failed to decrypt key for ${provider}:`, err);
      return null;
    }
  }

  status(): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const provider of ['anthropic', 'openai', 'openrouter', 'xai']) {
      const value = this.get(provider);
      out[provider] = value ? `…${value.slice(-4)}` : null;
    }
    return out;
  }
}
