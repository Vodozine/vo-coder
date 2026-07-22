import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolSpec } from '@vo-coder/providers';

export interface McpServerConfig {
  /** Unique name; must not contain the namespace separator "__". */
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpServerStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

const SEP = '__';

interface Entry {
  cfg: McpServerConfig;
  client: Client | null;
  tools: ToolSpec[];
  error?: string;
}

/**
 * Spawns and holds stdio MCP connections. Tools are namespaced
 * `serverName__toolName` so multiple servers can coexist in one request.
 */
export class McpClientManager {
  private servers = new Map<string, Entry>();

  async connect(cfg: McpServerConfig): Promise<McpServerStatus> {
    if (cfg.name.includes(SEP)) {
      throw new Error(`MCP server name must not contain "${SEP}"`);
    }
    await this.disconnect(cfg.name);
    const entry: Entry = { cfg, client: null, tools: [] };
    this.servers.set(cfg.name, entry);
    try {
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env: { ...(process.env as Record<string, string>), ...cfg.env },
        cwd: cfg.cwd,
      });
      const client = new Client({ name: 'vo-coder', version: '0.1.0' });
      await client.connect(transport);
      const { tools } = await client.listTools();
      entry.client = client;
      entry.error = undefined;
      entry.tools = tools.map((t) => ({
        name: `${cfg.name}${SEP}${t.name}`,
        description: t.description,
        inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
      }));
      client.onclose = () => {
        // Crash/exit surfaces as a disconnected status; reconnect is manual for now.
        entry.client = null;
        entry.error = 'connection closed';
      };
    } catch (err) {
      entry.client = null;
      entry.error = err instanceof Error ? err.message : String(err);
    }
    return this.statusOf(cfg.name);
  }

  async disconnect(name: string): Promise<void> {
    const entry = this.servers.get(name);
    if (!entry) return;
    this.servers.delete(name);
    if (entry.client) {
      entry.client.onclose = undefined;
      await entry.client.close().catch(() => {});
    }
  }

  statusOf(name: string): McpServerStatus {
    const entry = this.servers.get(name);
    if (!entry) return { name, connected: false, toolCount: 0, error: 'not registered' };
    return {
      name,
      connected: entry.client !== null,
      toolCount: entry.tools.length,
      ...(entry.error ? { error: entry.error } : {}),
    };
  }

  list(): McpServerStatus[] {
    return [...this.servers.keys()].map((name) => this.statusOf(name));
  }

  /** undefined → tools from every connected server. */
  toolsFor(serverNames?: string[]): ToolSpec[] {
    const out: ToolSpec[] = [];
    for (const [name, entry] of this.servers) {
      if (!entry.client) continue;
      if (serverNames && !serverNames.includes(name)) continue;
      out.push(...entry.tools);
    }
    return out;
  }

  async call(
    namespacedName: string,
    args: unknown,
  ): Promise<{ content: string; isError?: boolean }> {
    const sepIdx = namespacedName.indexOf(SEP);
    if (sepIdx < 0) {
      return { content: `Malformed tool name "${namespacedName}".`, isError: true };
    }
    const serverName = namespacedName.slice(0, sepIdx);
    const toolName = namespacedName.slice(sepIdx + SEP.length);
    const entry = this.servers.get(serverName);
    if (!entry?.client) {
      return { content: `MCP server "${serverName}" is not connected.`, isError: true };
    }
    const result = await entry.client.callTool({
      name: toolName,
      arguments: (args ?? {}) as Record<string, unknown>,
    });
    const content = Array.isArray(result.content)
      ? (result.content as Array<{ type: string; text?: string }>)
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text)
          .join('\n')
      : '';
    const structured = result.structuredContent
      ? JSON.stringify(result.structuredContent, null, 2)
      : '';
    const combined = [content, structured].filter(Boolean).join('\n');
    return { content: combined || '(no output)', isError: !!result.isError };
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((name) => this.disconnect(name)));
  }
}
