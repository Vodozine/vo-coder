import { AgentSession, type McpClientManager, type PermissionDecision } from '@vo-coder/core';
import type { AgentSpec, UserPart } from '@vo-coder/providers';
import { IPC, type PermissionPrompt, type SendResult } from '../shared/ipc-contract';
import type { ConfigStore } from './config';
import type { ProviderHub } from './providers';

interface SessionManagerDeps {
  config: ConfigStore;
  hub: ProviderHub;
  mcp: McpClientManager;
  send: (channel: string, payload: unknown) => void;
}

const PERMISSION_TIMEOUT_MS = 5 * 60_000;

/**
 * One AgentSession per agent id, created lazily. The implicit "default" agent
 * uses the app-level system prompt and defaults; user-defined agents come from
 * config and may override provider/model/servers.
 */
export class SessionManager {
  private sessions = new Map<string, AgentSession>();
  private pendingPermissions = new Map<string, (d: PermissionDecision) => void>();
  private permSeq = 0;

  constructor(private deps: SessionManagerDeps) {}

  private specFor(agentId: string): AgentSpec {
    if (agentId === 'default') {
      const cfg = this.deps.config.get();
      return {
        id: 'default',
        name: 'Default',
        systemPrompt: cfg.systemPrompt,
        ...(cfg.thinkingDefault ? { thinking: { enabled: true } } : {}),
      };
    }
    const spec = this.deps.config.get().agents.find((a) => a.id === agentId);
    if (!spec) throw new Error(`Unknown agent "${agentId}".`);
    return spec;
  }

  private sessionFor(agentId: string): AgentSession {
    let session = this.sessions.get(agentId);
    if (session) {
      // Pick up any edits made in the Agents view since the last send.
      session.spec = this.specFor(agentId);
      return session;
    }
    session = new AgentSession({
      id: agentId,
      spec: this.specFor(agentId),
      resolve: (spec) => {
        const { defaultProvider, defaultModel } = this.deps.config.get();
        return this.deps.hub
          .registry()
          .resolve(spec, { provider: defaultProvider, model: defaultModel });
      },
      emit: (sessionId, event) => this.deps.send(IPC.chatEvent, { sessionId, event }),
      toolExecutor: {
        tools: () => this.deps.mcp.toolsFor(this.trySpec(agentId)?.mcpServers),
        execute: (name, args) => this.deps.mcp.call(name, args),
      },
      permission: (req) => this.requestPermission(agentId, req.name, req.args),
    });
    this.sessions.set(agentId, session);
    return session;
  }

  private trySpec(agentId: string): AgentSpec | undefined {
    try {
      return this.specFor(agentId);
    } catch {
      return undefined;
    }
  }

  send(
    agentId: string,
    parts: UserPart[],
    override?: { provider?: string; model?: string },
  ): SendResult {
    try {
      return this.sessionFor(agentId).send(parts, override);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  inject(agentId: string, parts: UserPart[]): SendResult {
    try {
      return this.sessionFor(agentId).inject(parts);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  stop(agentId: string): void {
    this.sessions.get(agentId)?.stop();
  }

  reset(agentId: string): void {
    this.sessions.get(agentId)?.reset();
  }

  private requestPermission(
    agentId: string,
    name: string,
    args: unknown,
  ): Promise<PermissionDecision> {
    return new Promise((resolve) => {
      const requestId = `perm_${++this.permSeq}`;
      this.pendingPermissions.set(requestId, resolve);
      const prompt: PermissionPrompt = {
        requestId,
        sessionId: agentId,
        agentName: this.trySpec(agentId)?.name ?? agentId,
        name,
        args,
      };
      this.deps.send(IPC.permissionRequest, prompt);
      setTimeout(() => {
        if (this.pendingPermissions.delete(requestId)) resolve('deny');
      }, PERMISSION_TIMEOUT_MS);
    });
  }

  respondPermission(requestId: string, decision: PermissionDecision): void {
    const resolve = this.pendingPermissions.get(requestId);
    if (resolve) {
      this.pendingPermissions.delete(requestId);
      resolve(decision);
    }
  }
}
