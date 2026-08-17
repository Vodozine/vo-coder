import { shell } from 'electron';
import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { IPC, type GoogleOauthEvent } from '../shared/ipc-contract';
import type { ConfigStore } from './config';
import { currentCaller } from './ipc-registry';
import { PORT_PLACEHOLDER } from './oauth-loopback';
import type { SecretStore } from './secrets';

/**
 * Gmail sign-in via Google OAuth 2.0 — the desktop "loopback" flow (RFC 8252):
 * open the consent screen in the browser with a `http://127.0.0.1:<port>`
 * redirect, catch the code on a one-shot local server, exchange it (with PKCE)
 * for tokens. Google has no device-code path for Gmail scopes, so this is the
 * flow that works.
 *
 * Bring-your-own client: the desktop client id lives in config
 * (`googleOauthClientId`) and its secret in the encrypted secret store
 * (`google-oauth-secret`) — Google gates Gmail behind per-app verification, so
 * each install uses the user's own OAuth client instead of one shipped app.
 * Tokens live under `google-oauth`; refreshed in the background.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'openid',
  'email',
].join(' ');
const SECRET_KEY = 'google-oauth-secret';
const STORE_KEY = 'google-oauth';
const REFRESH_MARGIN_MS = 5 * 60_000;
/** Abandon a sign-in that the user never completes, so the port is freed. */
const FLOW_TIMEOUT_MS = 5 * 60_000;

interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  email?: string;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Pull the email out of a Google id_token without verifying (it came straight
 * from the token endpoint over TLS, so it is trusted for display only). */
function emailFromIdToken(idToken?: string): string | undefined {
  if (!idToken) return undefined;
  try {
    const payload = idToken.split('.')[1];
    const json = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as { email?: string };
    return json.email;
  } catch {
    return undefined;
  }
}

export class GoogleOAuth {
  private server: Server | null = null;

  constructor(
    private config: ConfigStore,
    private secrets: SecretStore,
    private send: (channel: string, payload: unknown) => void,
  ) {}

  private clientId(): string {
    return this.config.get().googleOauthClientId.trim();
  }

  private clientSecret(): string {
    return (this.secrets.get(SECRET_KEY) ?? '').trim();
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

  private notify(event: GoogleOauthEvent): void {
    this.send(IPC.googleOauthEvent, event);
  }

  status(): { connected: boolean; email?: string } {
    const t = this.stored();
    return t ? { connected: true, email: t.email } : { connected: false };
  }

  /** A valid Gmail access token, refreshing first if it's near expiry. */
  async accessToken(): Promise<string | null> {
    const tokens = this.stored();
    if (!tokens) return null;
    if (tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS) return tokens.accessToken;
    if (!tokens.refreshToken) return tokens.accessToken; // no way to refresh; try as-is
    return (await this.refresh(tokens)) ?? tokens.accessToken;
  }

  async begin(): Promise<{ ok: boolean; error?: string }> {
    const clientId = this.clientId();
    const clientSecret = this.clientSecret();
    if (!clientId || !clientSecret) {
      return {
        ok: false,
        error: 'Paste your Google Client ID and secret first (from your Cloud Desktop client).',
      };
    }
    if (this.server) {
      return { ok: false, error: 'A sign-in is already in progress — finish it in the browser.' };
    }

    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = base64url(randomBytes(16));

    const params = (redirectUri: string): string =>
      new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
        state,
        include_granted_scopes: 'true',
      }).toString();

    /**
     * Driven from another machine: the browser is over there, so 127.0.0.1 is
     * over there too, and a listener opened here would catch nothing. The
     * front end opens the port and the browser; only the code comes back, and
     * the exchange still happens here so the refresh token never leaves.
     */
    const caller = currentCaller();
    if (caller) {
      const template = `${AUTH_URL}?${params(`http://127.0.0.1:${PORT_PLACEHOLDER}`)}`;
      void (async () => {
        const answer = (await caller.ask('oauth:loopback', { authUrlTemplate: template })) as {
          ok?: boolean;
          code?: string;
          redirectUri?: string;
          error?: string;
        } | null;
        if (!answer?.ok || !answer.code || !answer.redirectUri) {
          this.notify({
            state: 'error',
            message: answer?.error ?? 'Sign-in did not finish on the other machine.',
          });
          return;
        }
        await this.exchange(answer.code, verifier, answer.redirectUri);
      })();
      return { ok: true };
    }

    let port: number;
    try {
      port = await new Promise<number>((resolvePort, reject) => {
        const server = createServer((req, res) => {
          const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
          const code = url.searchParams.get('code');
          const err = url.searchParams.get('error');
          const gotState = url.searchParams.get('state');
          // Ignore stray hits (favicon etc.) — only the real callback carries a code/error.
          if (!code && !err) {
            res.writeHead(204).end();
            return;
          }
          res.writeHead(200, { 'content-type': 'text/html' }).end(
            `<!doctype html><html><body style="font-family:system-ui;background:#0b0b0d;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
             <div style="text-align:center"><h2>${err ? 'Sign-in failed' : 'Vo-Coder is connected to Gmail'}</h2>
             <p>You can close this tab and go back to Vo-Coder.</p></div></body></html>`,
          );
          this.closeServer();
          if (err || gotState !== state || !code) {
            this.notify({ state: 'error', message: err ?? 'Sign-in was cancelled or mismatched.' });
            return;
          }
          void this.exchange(code, verifier, `http://127.0.0.1:${port}`);
        });
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            this.server = server;
            resolvePort(addr.port);
          } else {
            reject(new Error('could not open a local port'));
          }
        });
      });
    } catch (err) {
      return { ok: false, error: `Could not start local sign-in: ${err instanceof Error ? err.message : String(err)}` };
    }

    // Free the port if the user wanders off and never approves.
    setTimeout(() => {
      if (this.server) {
        this.closeServer();
        this.notify({ state: 'error', message: 'Sign-in timed out — try again.' });
      }
    }, FLOW_TIMEOUT_MS);

    const authUrl = new URL(AUTH_URL);
    authUrl.search = params(`http://127.0.0.1:${port}`);
    void shell.openExternal(authUrl.toString());
    return { ok: true };
  }

  private closeServer(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private async exchange(code: string, verifier: string, redirectUri: string): Promise<void> {
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: this.clientId(),
          client_secret: this.clientSecret(),
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: verifier,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        id_token?: string;
        error?: string;
        error_description?: string;
      };
      if (!json.access_token) {
        this.notify({
          state: 'error',
          message: json.error_description ?? json.error ?? `Token exchange failed (${res.status}).`,
        });
        return;
      }
      const email = emailFromIdToken(json.id_token);
      this.store({
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
        email,
      });
      this.notify({ state: 'connected', email });
    } catch (err) {
      this.notify({
        state: 'error',
        message: `Token exchange failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private async refresh(tokens: StoredTokens): Promise<string | null> {
    if (!tokens.refreshToken) return null;
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.clientId(),
          client_secret: this.clientSecret(),
          refresh_token: tokens.refreshToken,
          grant_type: 'refresh_token',
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        access_token?: string;
        expires_in?: number;
        error?: string;
      };
      if (json.access_token) {
        this.store({
          ...tokens,
          accessToken: json.access_token,
          expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
        });
        return json.access_token;
      }
      // A revoked or 7-day-expired (testing mode) refresh token: drop it so the
      // UI shows disconnected and prompts a fresh sign-in.
      if (json.error === 'invalid_grant') {
        this.store(null);
        this.notify({ state: 'signed_out', message: 'Gmail session expired — connect again.' });
      }
      return null;
    } catch {
      return null;
    }
  }

  async refreshIfNeeded(): Promise<void> {
    const tokens = this.stored();
    if (!tokens?.refreshToken) return;
    if (tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS) return;
    await this.refresh(tokens);
  }

  async signOut(): Promise<void> {
    const tokens = this.stored();
    this.store(null);
    // Best-effort revoke so the grant doesn't linger on Google's side.
    if (tokens?.refreshToken || tokens?.accessToken) {
      await fetch(REVOKE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: tokens.refreshToken ?? tokens.accessToken }),
      }).catch(() => {});
    }
    this.notify({ state: 'signed_out' });
  }
}
