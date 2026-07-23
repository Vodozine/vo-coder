import { shell } from 'electron';
import { IPC, type XaiOauthEvent } from '../shared/ipc-contract';
import type { ConfigStore } from './config';
import type { SecretStore } from './secrets';

/**
 * xAI subscription sign-in (SuperGrok / X Premium): OAuth 2.0 device-code
 * grant against auth.x.ai — endpoints straight from the published OIDC
 * discovery document. The resulting bearer token drives api.x.ai/v1 exactly
 * like an API key, refreshed in the background. Tokens live in the encrypted
 * secret store under 'xai-oauth'.
 */

const DEVICE_CODE_URL = 'https://auth.x.ai/oauth2/device/code';
const TOKEN_URL = 'https://auth.x.ai/oauth2/token';
const SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const STORE_KEY = 'xai-oauth';
/** Refresh when less than this remains. */
const REFRESH_MARGIN_MS = 20 * 60_000;

interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export class XaiOAuth {
  private polling = false;

  constructor(
    private config: ConfigStore,
    private secrets: SecretStore,
    private send: (channel: string, payload: unknown) => void,
  ) {}

  private clientId(): string {
    return this.config.get().xaiOauthClientId.trim();
  }

  private stored(): StoredTokens | null {
    const raw = this.secrets.get(STORE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredTokens;
    } catch {
      return null;
    }
  }

  private store(tokens: StoredTokens | null): void {
    this.secrets.set(STORE_KEY, tokens ? JSON.stringify(tokens) : '');
  }

  private notify(event: XaiOauthEvent): void {
    this.send(IPC.xaiOauthEvent, event);
  }

  status(): { connected: boolean; expiresAt?: number } {
    const tokens = this.stored();
    return tokens ? { connected: true, expiresAt: tokens.expiresAt } : { connected: false };
  }

  /** Current bearer for api.x.ai, or null when not signed in. */
  token(): string | null {
    return this.stored()?.accessToken ?? null;
  }

  async begin(): Promise<{ ok: boolean; userCode?: string; verificationUri?: string; error?: string }> {
    const clientId = this.clientId();
    if (!clientId) return { ok: false, error: 'Set the OAuth client id first (Settings → xai).' };
    let res: Response;
    try {
      res = await fetch(DEVICE_CODE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, scope: SCOPE }),
      });
    } catch (err) {
      return { ok: false, error: `Could not reach auth.x.ai: ${err instanceof Error ? err.message : err}` };
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return {
        ok: false,
        error: `auth.x.ai rejected the request (${res.status}): ${detail.slice(0, 200)} — the client id may be wrong.`,
      };
    }
    const dev = (await res.json()) as {
      device_code: string;
      user_code: string;
      verification_uri?: string;
      verification_uri_complete?: string;
      interval?: number;
      expires_in?: number;
    };
    const verificationUri = dev.verification_uri_complete ?? dev.verification_uri ?? 'https://auth.x.ai';
    void shell.openExternal(verificationUri);
    void this.poll(clientId, dev.device_code, (dev.interval ?? 5) * 1000, (dev.expires_in ?? 900) * 1000);
    return { ok: true, userCode: dev.user_code, verificationUri };
  }

  private async poll(
    clientId: string,
    deviceCode: string,
    intervalMs: number,
    expiresInMs: number,
  ): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const deadline = Date.now() + expiresInMs;
    try {
      while (Date.now() < deadline && this.polling) {
        await new Promise((r) => setTimeout(r, intervalMs));
        const res = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: deviceCode,
            client_id: clientId,
          }),
        }).catch(() => null);
        if (!res) continue;
        const json = (await res.json().catch(() => ({}))) as {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
          error?: string;
        };
        if (json.access_token) {
          this.store({
            accessToken: json.access_token,
            refreshToken: json.refresh_token,
            expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
          });
          this.notify({ state: 'connected' });
          return;
        }
        if (json.error === 'authorization_pending') continue;
        if (json.error === 'slow_down') {
          intervalMs += 5000;
          continue;
        }
        this.notify({ state: 'error', message: json.error ?? `HTTP ${res.status}` });
        return;
      }
      if (this.polling) this.notify({ state: 'error', message: 'Sign-in timed out — try again.' });
    } finally {
      this.polling = false;
    }
  }

  cancel(): void {
    this.polling = false;
  }

  signOut(): void {
    this.cancel();
    this.store(null);
    this.notify({ state: 'signed_out' });
  }

  async refreshIfNeeded(): Promise<void> {
    const tokens = this.stored();
    if (!tokens?.refreshToken) return;
    if (tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS) return;
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokens.refreshToken,
          client_id: this.clientId(),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: string;
      };
      if (json.access_token) {
        this.store({
          accessToken: json.access_token,
          refreshToken: json.refresh_token ?? tokens.refreshToken,
          expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
        });
      } else if (json.error === 'invalid_grant') {
        this.store(null);
        this.notify({ state: 'signed_out', message: 'xAI session expired — sign in again.' });
      }
    } catch {
      /* transient network — retry on the next tick */
    }
  }
}
