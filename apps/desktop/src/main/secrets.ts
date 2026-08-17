import { app, safeStorage } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * API keys encrypted with the OS keychain (DPAPI / Keychain / kwallet+libsecret)
 * via Electron safeStorage. The renderer never sees raw values — only masked
 * status strings. If OS encryption is unavailable (some Linux setups), values
 * fall back to base64 with a logged warning; that fallback now re-encrypts
 * itself on the first read once encryption is available again.
 *
 * Worth being precise about the guarantee, since "OS keychain" can suggest more
 * than it delivers: safeStorage binds to the USER ACCOUNT, not to this app. Any
 * process running as the same user can decrypt this file. It protects the keys
 * at rest from other accounts and from someone copying the file off the disk;
 * it is not a defence against something already running as you.
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
        const value = Buffer.from(stored.slice(6), 'base64').toString('utf8');
        // A value written while OS encryption was unavailable would otherwise
        // stay readable forever, long after encryption came back. Heal it on
        // first read instead of leaving a permanent downgrade behind.
        if (value && safeStorage.isEncryptionAvailable()) {
          console.warn(`[secrets] re-encrypting previously obfuscated key for ${provider}`);
          this.set(provider, value);
        }
        return value;
      }
      return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    } catch (err) {
      console.error(`[secrets] failed to decrypt key for ${provider}:`, err);
      return null;
    }
  }

  status(): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const provider of [
      'anthropic',
      'openai',
      'openrouter',
      'xai',
      // zai and gemini were missing — their Settings key rows never showed the
      // saved/Replace state because status() didn't report them.
      'zai',
      'gemini',
      'nvidia',
      'telegram',
      'elevenlabs',
      'tts-custom',
      // Bring-your-own Google desktop client secret (Gmail sign-in).
      'google-oauth-secret',
      // Custom image endpoint (any OpenAI-images-compatible provider).
      'image-custom',
      // Model aggregators (image + video): fal.ai and Replicate.
      'fal',
      'replicate',
    ]) {
      const value = this.get(provider);
      out[provider] = value ? `…${value.slice(-4)}` : null;
    }
    return out;
  }
}
