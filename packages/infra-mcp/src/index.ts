#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.js';

export { buildServer, DRIVERS } from './server.js';
export { SettingsStore, settingsPath } from './settings.js';
export type { ConnectionConfig, DiscoveryCache, InfraSettings } from './settings.js';
export { gate, allows, DEFAULT_PERMISSIONS } from './permissions.js';
export type { PermissionSettings, Tier } from './permissions.js';
export type { InfraDriver, ToolModule, ToolResult } from './drivers/types.js';

const isDirectRun = process.argv[1] && import.meta.url.endsWith(
  process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '',
);

if (isDirectRun) {
  const { server, settings } = buildServer();
  // stderr only — stdout belongs to the MCP protocol.
  console.error(
    `vo-infra-mcp starting (settings: ${settings.location()}${settings.exists() ? '' : ' — will be created on first write'})`,
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('vo-infra-mcp connected over stdio');
}
