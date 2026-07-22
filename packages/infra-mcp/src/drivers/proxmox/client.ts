import { Agent } from 'undici';
import type { ConnectionConfig } from '../../settings.js';

export class ProxmoxApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProxmoxApiError';
  }
}

/**
 * Minimal typed REST client for the Proxmox VE API. One instance per
 * connection — multi-host support comes from the connection registry, not
 * from globals. TLS verification is configurable per connection (the old
 * server hard-disabled it).
 */
export class ProxmoxClient {
  private base: string;
  private auth: string;
  private dispatcher: Agent | null = null;

  constructor(
    private conn: ConnectionConfig,
    secret: string,
    private fetchFn: typeof fetch = fetch,
  ) {
    this.base = `https://${conn.host}:${conn.port ?? 8006}/api2/json`;
    this.auth = `PVEAPIToken=${conn.user ?? 'root@pam'}!${conn.tokenId ?? 'mcp'}=${secret}`;
  }

  private init(method: string, body?: Record<string, unknown>): RequestInit {
    const init: RequestInit = {
      method,
      headers: {
        authorization: this.auth,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    };
    if (this.conn.tls?.rejectUnauthorized === false) {
      // Homelab self-signed certs: opt-in per connection, never the default.
      // undici's Agent type clashes with @types/node's undici-types Dispatcher
      // on RequestInit, hence the record cast; runtime is identical.
      this.dispatcher ??= new Agent({ connect: { rejectUnauthorized: false } });
      (init as Record<string, unknown>).dispatcher = this.dispatcher;
    }
    return init;
  }

  async request<T = unknown>(
    endpoint: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
    body?: Record<string, unknown>,
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${endpoint}`, this.init(method, body));
    } catch (err) {
      throw new ProxmoxApiError(
        `Could not reach Proxmox at ${this.conn.host}:${this.conn.port ?? 8006} — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let hint = '';
      if (res.status === 401 || res.status === 403) {
        hint = ' Check the API token (user, tokenId, tokenSecret) and its privileges.';
      } else if (res.status === 596) {
        hint = ' HTTP 596 usually means the node name does not exist — check spelling/case.';
      }
      throw new ProxmoxApiError(
        `Proxmox ${method} ${endpoint} failed: ${res.status} ${detail || res.statusText}.${hint}`,
        res.status,
      );
    }
    const json = (await res.json()) as { data: T };
    return json.data;
  }

  version(): Promise<{ version: string; release: string }> {
    return this.request('/version');
  }
}
