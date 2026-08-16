import { shell } from 'electron';
import type { McpClientManager, McpServerConfig } from '@vo-coder/core';
import { IPC, type McpOauthEvent } from '../shared/ipc-contract';
import type { ConfigStore } from './config';
import type { SecretStore } from './secrets';

/**
 * In-app OAuth sign-in for remote (Streamable HTTP) MCP servers, so a user
 * connects with "Sign in with GitHub" instead of pasting a token. Uses the
 * OAuth 2.0 device-code grant — the same flow as xai-oauth.ts, but keyed per
 * MCP server and with the provider chosen from the server's URL host.
 *
 * The resulting access token is written into the server's `headers.Authorization`
 * (exactly where a hand-pasted PAT would go, so the boot-time reconnect at
 * ipc.ts picks it up with no extra wiring) and the full bundle (access +
 * refresh) is kept in the encrypted secret store under `mcp-oauth:<name>` so it
 * can be refreshed in the background. Signing out clears both.
 */

interface OAuthProvider {
  label: string;
  /** Host (no port) → does this provider own it? */
  match: (host: string) => boolean;
  deviceCodeUrl: string;
  tokenUrl: string;
  clientId: string;
  scope: string;
}

// The Vo-Coder OAuth app on GitHub (device flow enabled). The client id is
// public by design — device flow uses no client secret, so it is safe to ship
// in both editions.
const GITHUB: OAuthProvider = {
  label: 'GitHub',
  match: (h) => h === 'api.githubcopilot.com' || h.endsWith('.githubcopilot.com'),
  deviceCodeUrl: 'https://github.com/login/device/code',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  clientId: 'Ov23lifLcpgHSkIBxCg2',
  scope: 'repo read:org gist workflow notifications read:user',
};

const PROVIDERS: OAuthProvider[] = [GITHUB];

function providerForUrl(url?: string): OAuthProvider | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).host.toLowerCase().split(':')[0];
  } catch {
    return null;
  }
  return PROVIDERS.find((p) => p.match(host)) ?? null;
}

/** Refresh when less than this remains before expiry. */
const REFRESH_MARGIN_MS = 20 * 60_000;

interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

/** GitHub device-flow error codes → something a person can act on. */
function humanizeError(code?: string): string | undefined {
  switch (code) {
    case 'authorization_pending':
      return undefined; // keep waiting — handled by the poll loop
    case 'expired_token':
      return 'The code expired before you approved — click Sign in again.';
    case 'access_denied':
      return 'The GitHub authorization was cancelled.';
    case 'device_flow_disabled':
      return 'Device Flow is not enabled on the OAuth app — enable it in the app settings on GitHub.';
    case 'incorrect_client_credentials':
      return 'The OAuth client id is wrong for this server.';
    default:
      return code;
  }
}

export class McpOAuthManager {
  private polling = new Set<string>();

  constructor(
    private config: ConfigStore,
    private secrets: SecretStore,
    private mcp: McpClientManager,
    private send: (channel: string, payload: unknown) => void,
  ) {}

  private key(serverName: string): string {
    return `mcp-oauth:${serverName}`;
  }

  private stored(serverName: string): StoredTokens | null {
    const raw = this.secrets.get(this.key(serverName));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredTokens;
    } catch {
      return null;
    }
  }

  private store(serverName: string, tokens: StoredTokens | null): void {
    this.secrets.set(this.key(serverName), tokens ? JSON.stringify(tokens) : '');
  }

  private notify(event: McpOauthEvent): void {
    this.send(IPC.mcpOauthEvent, event);
  }

  /** Does this server's URL have an OAuth provider (so we should offer sign-in)? */
  supports(url?: string): boolean {
    return providerForUrl(url) !== null;
  }

  async begin(
    serverName: string,
  ): Promise<{ ok: boolean; userCode?: string; verificationUri?: string; error?: string }> {
    const server = this.config.get().mcpServers.find((s) => s.name === serverName);
    if (!server?.url) return { ok: false, error: 'This is not a remote (URL) server.' };
    const provider = providerForUrl(server.url);
    if (!provider) return { ok: false, error: 'This server does not support sign-in.' };

    let res: Response;
    try {
      res = await fetch(provider.deviceCodeUrl, {
        method: 'POST',
        // GitHub returns form-encoded unless you ASK for JSON — without this the
        // JSON parse below silently fails and no code ever appears.
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ client_id: provider.clientId, scope: provider.scope }),
      });
    } catch (err) {
      return {
        ok: false,
        error: `Could not reach ${provider.label}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return {
        ok: false,
        error: `${provider.label} rejected the request (${res.status}): ${detail.slice(0, 200)}`,
      };
    }
    const dev = (await res.json().catch(() => ({}))) as {
      device_code?: string;
      user_code?: string;
      verification_uri?: string;
      verification_uri_complete?: string;
      interval?: number;
      expires_in?: number;
    };
    if (!dev.device_code || !dev.user_code) {
      return { ok: false, error: `${provider.label} did not return a device code — try again.` };
    }
    const verificationUri =
      dev.verification_uri_complete ?? dev.verification_uri ?? 'https://github.com/login/device';
    void shell.openExternal(verificationUri);
    void this.poll(
      serverName,
      provider,
      dev.device_code,
      (dev.interval ?? 5) * 1000,
      (dev.expires_in ?? 900) * 1000,
    );
    return { ok: true, userCode: dev.user_code, verificationUri };
  }

  private async poll(
    serverName: string,
    provider: OAuthProvider,
    deviceCode: string,
    intervalMs: number,
    expiresInMs: number,
  ): Promise<void> {
    if (this.polling.has(serverName)) return;
    this.polling.add(serverName);
    const deadline = Date.now() + expiresInMs;
    try {
      while (Date.now() < deadline && this.polling.has(serverName)) {
        await new Promise((r) => setTimeout(r, intervalMs));
        const res = await fetch(provider.tokenUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: deviceCode,
            client_id: provider.clientId,
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
          this.store(serverName, {
            accessToken: json.access_token,
            refreshToken: json.refresh_token,
            // Non-expiring OAuth-app tokens omit expires_in; treat as far future.
            expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : Number.MAX_SAFE_INTEGER,
          });
          const status = await this.applyAndConnect(serverName, json.access_token);
          this.notify({
            serverName,
            state: status.connected ? 'connected' : 'error',
            toolCount: status.toolCount,
            message: status.connected
              ? undefined
              : (status.error ??
                `Signed in, but ${provider.label} refused the token. You can paste a PAT via Headers instead.`),
          });
          return;
        }
        if (json.error === 'authorization_pending') continue;
        if (json.error === 'slow_down') {
          intervalMs += 5000;
          continue;
        }
        this.notify({
          serverName,
          state: 'error',
          message: humanizeError(json.error) ?? `HTTP ${res.status}`,
        });
        return;
      }
      if (this.polling.has(serverName)) {
        this.notify({ serverName, state: 'error', message: 'Sign-in timed out — try again.' });
      }
    } finally {
      this.polling.delete(serverName);
    }
  }

  /** Write the bearer into the server's headers, persist config, reconnect. */
  private async applyAndConnect(
    serverName: string,
    accessToken: string,
  ): Promise<{ connected: boolean; toolCount: number; error?: string }> {
    const servers = this.config.get().mcpServers;
    const idx = servers.findIndex((s) => s.name === serverName);
    if (idx < 0) return { connected: false, toolCount: 0, error: 'server no longer exists' };
    const cfg: McpServerConfig = {
      ...servers[idx],
      headers: { ...(servers[idx].headers ?? {}), Authorization: `Bearer ${accessToken}` },
    };
    const next = servers.slice();
    next[idx] = cfg;
    this.config.set({ mcpServers: next });
    return this.mcp.connect(cfg);
  }

  cancel(serverName: string): void {
    this.polling.delete(serverName);
  }

  async signOut(serverName: string): Promise<void> {
    this.cancel(serverName);
    this.store(serverName, null);
    const servers = this.config.get().mcpServers;
    const idx = servers.findIndex((s) => s.name === serverName);
    if (idx >= 0 && servers[idx].headers?.Authorization) {
      const rest = { ...(servers[idx].headers as Record<string, string>) };
      delete rest.Authorization;
      const cfg: McpServerConfig = {
        ...servers[idx],
        headers: Object.keys(rest).length ? rest : undefined,
      };
      const next = servers.slice();
      next[idx] = cfg;
      this.config.set({ mcpServers: next });
      await this.mcp.disconnect(serverName).catch(() => {});
    }
    this.notify({ serverName, state: 'signed_out' });
  }

  /**
   * Background upkeep: for every signed-in OAuth server whose token is near
   * expiry, refresh it and re-apply. Called at startup and on an interval.
   */
  async refreshIfNeeded(): Promise<void> {
    for (const server of this.config.get().mcpServers) {
      const provider = providerForUrl(server.url);
      if (!provider) continue;
      const tokens = this.stored(server.name);
      if (!tokens?.refreshToken) continue;
      if (tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS) continue;
      try {
        const res = await fetch(provider.tokenUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: tokens.refreshToken,
            client_id: provider.clientId,
          }),
        });
        const json = (await res.json().catch(() => ({}))) as {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
          error?: string;
        };
        if (json.access_token) {
          this.store(server.name, {
            accessToken: json.access_token,
            refreshToken: json.refresh_token ?? tokens.refreshToken,
            expiresAt: json.expires_in
              ? Date.now() + json.expires_in * 1000
              : Number.MAX_SAFE_INTEGER,
          });
          await this.applyAndConnect(server.name, json.access_token);
        } else if (json.error === 'invalid_grant') {
          this.store(server.name, null);
          this.notify({
            serverName: server.name,
            state: 'signed_out',
            message: `${provider.label} session expired — sign in again.`,
          });
        }
      } catch {
        /* transient network — retry on the next tick */
      }
    }
  }
}
