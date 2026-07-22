import type { z } from 'zod';
import type { Tier } from '../permissions.js';
import type { ConnectionConfig, SettingsStore } from '../settings.js';

export interface ProbeResult {
  reachable: boolean;
  version?: string;
  error?: string;
}

export interface ToolResult {
  /** Human-readable summary. */
  text: string;
  /** Machine-readable payload, returned as structuredContent. */
  data?: unknown;
  isError?: boolean;
}

export interface ToolModule {
  name: string;
  title: string;
  description: string;
  tier: Tier;
  /** Zod raw shape for the tool input (SDK renders it to JSON Schema). */
  inputSchema: Record<string, z.ZodType>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface DriverContext {
  settings: SettingsStore;
}

export interface InfraDriver {
  id: string;
  kind: 'hypervisor' | 'container' | 'local';
  probe(conn: ConnectionConfig, ctx: DriverContext): Promise<ProbeResult>;
  tools(ctx: DriverContext): ToolModule[];
}
