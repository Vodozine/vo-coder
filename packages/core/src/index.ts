export { AgentSession } from './agent/session.js';
export type {
  AgentSessionOptions,
  PermissionCallback,
  PermissionDecision,
  PermissionRequest,
  SendResult,
  SessionEvent,
  SessionStatus,
  ToolExecutor,
} from './agent/session.js';
export { McpClientManager } from './mcp/client-manager.js';
export type { McpServerConfig, McpServerStatus } from './mcp/client-manager.js';
export { McpToolExecutor } from './mcp/tool-router.js';
export { matchAgentForMessage } from './agent/agent-router.js';
export { searchMcpRegistry, suggestServerName } from './mcp/registry.js';
export type {
  McpRegistryEntry,
  RegistryEnvVar,
  RegistryInstallCandidate,
} from './mcp/registry.js';
export { McpAdvisor, DEFAULT_TOPIC_RULES } from './mcp/advisor.js';
export type { AdvisorOptions, McpSuggestion, McpTopicRule } from './mcp/advisor.js';
export { EmotionalMiddleware, detectTone, similarity } from './middleware/emotional.js';
export type {
  CheckinSuggestion,
  EmotionalOptions,
  EmotionalSignals,
  RequestLogEntry,
} from './middleware/emotional.js';
