import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gate } from './permissions.js';
import { SettingsStore } from './settings.js';
import { generalTools } from './tools/general.js';
import { proxmoxDriver } from './drivers/proxmox/index.js';
import type { DriverContext, InfraDriver, ToolModule } from './drivers/types.js';
import type { Exec } from './discovery/index.js';

export const DRIVERS: InfraDriver[] = [proxmoxDriver];

export interface BuildOptions {
  settings?: SettingsStore;
  exec?: Exec;
}

/**
 * Every tool is registered through the permission wrapper: tier gate first
 * (per-connection caps under a global cap), then the destructive-confirm
 * check, then the handler. Results carry structuredContent alongside prose.
 */
export function buildServer(opts: BuildOptions = {}): { server: McpServer; settings: SettingsStore } {
  const settings = opts.settings ?? new SettingsStore();
  const ctx: DriverContext = { settings };
  const server = new McpServer({ name: 'vo-infra-mcp', version: '0.1.0' });

  const modules: ToolModule[] = [
    ...generalTools(ctx, DRIVERS, opts.exec),
    ...DRIVERS.flatMap((d) => d.tools(ctx)),
  ];

  // Single narrow cast that isolates the SDK's deep zod generics (TS2589);
  // runtime validation is untouched.
  const register = server.registerTool.bind(server) as (
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: Record<string, z.ZodType>;
      outputSchema?: Record<string, z.ZodType>;
    },
    cb: (args: Record<string, unknown>) => Promise<unknown>,
  ) => void;

  for (const m of modules) {
    register(
      m.name,
      {
        title: m.title,
        description: `[tier: ${m.tier}] ${m.description}`,
        inputSchema: m.inputSchema,
        outputSchema: { result: z.unknown() },
      },
      async (args: Record<string, unknown>) => {
        const decision = gate(settings.get().permissions, {
          tier: m.tier,
          connection: typeof args.connection === 'string' ? args.connection : undefined,
          confirm: args.confirm === true,
        });
        if (!decision.allowed) {
          return {
            content: [{ type: 'text' as const, text: `⛔ ${decision.reason}` }],
            isError: true,
          };
        }
        try {
          const result = await m.handler(args);
          return {
            content: [{ type: 'text' as const, text: result.text }],
            ...(result.data !== undefined ? { structuredContent: { result: result.data } } : {}),
            ...(result.isError ? { isError: true } : {}),
          };
        } catch (err) {
          return {
            content: [
              { type: 'text' as const, text: err instanceof Error ? err.message : String(err) },
            ],
            isError: true,
          };
        }
      },
    );
  }

  return { server, settings };
}
