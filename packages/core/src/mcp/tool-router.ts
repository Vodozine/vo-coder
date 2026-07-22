import type { ToolSpec } from '@vo-coder/providers';
import type { ToolExecutor } from '../agent/session.js';
import type { McpClientManager } from './client-manager.js';

/**
 * Bridges an AgentSession to the MCP client manager, filtered to the servers
 * the agent is allowed to use (undefined → all connected servers).
 */
export class McpToolExecutor implements ToolExecutor {
  constructor(
    private manager: McpClientManager,
    private serverNames?: string[],
  ) {}

  tools(): ToolSpec[] {
    return this.manager.toolsFor(this.serverNames);
  }

  execute(name: string, args: unknown): Promise<{ content: string; isError?: boolean }> {
    return this.manager.call(name, args);
  }
}
