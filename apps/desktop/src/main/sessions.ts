import { AgentSession, type McpClientManager, type PermissionDecision } from '@vo-coder/core';
import type { AgentSpec, BoundModel, HarnessMessage, ToolSpec, UserPart } from '@vo-coder/providers';
import { IPC, type PermissionPrompt, type SendResult } from '../shared/ipc-contract';
import type { ConfigStore } from './config';
import type { ProjectStore } from './projects';
import type { ProviderHub } from './providers';
import { fmtStamp } from './journal';
import { AUTO_ALLOWED_TOOLS } from './tool-policy';
import { executeWorkspaceTool, workspaceToolSpecs } from './workspace-tools';

interface SessionManagerDeps {
  config: ConfigStore;
  hub: ProviderHub;
  mcp: McpClientManager;
  projects: ProjectStore;
  send: (channel: string, payload: unknown) => void;
  /** Always-on tools every session gets (web search/fetch, mission control). */
  builtins?: {
    specs(): ToolSpec[];
    execute(name: string, args: unknown): Promise<{ content: string; isError?: boolean }>;
  };
  /** Fired for every provider usage report, with the model that produced it. */
  onUsage?: (
    sessionId: string,
    bound: BoundModel | undefined,
    usage: { inputTokens: number; outputTokens: number },
  ) => void;
  /** Observer for session events (activity journaling). */
  onEvent?: (sessionId: string, event: import('@vo-coder/core').SessionEvent) => void;
}

const PERMISSION_TIMEOUT_MS = 5 * 60_000;

/**
 * One live AgentSession per chat session id, created lazily with its history
 * restored from disk. Every session belongs to a project and points at an
 * agent spec; transcripts persist on every send and on run completion.
 */
export class SessionManager {
  private sessions = new Map<string, AgentSession>();
  private pendingPermissions = new Map<string, (d: PermissionDecision) => void>();
  private permSeq = 0;
  /** Last resolved provider/model per session — attributes usage to a model. */
  private lastBound = new Map<string, BoundModel>();

  constructor(private deps: SessionManagerDeps) {}

  private specFor(agentId: string): AgentSpec {
    if (agentId === 'default') {
      const cfg = this.deps.config.get();
      return {
        id: 'default',
        name: 'Vodo',
        systemPrompt: cfg.systemPrompt,
        ...(cfg.thinkingDefault ? { thinking: { enabled: true } } : {}),
      };
    }
    const spec = this.deps.config.get().agents.find((a) => a.id === agentId);
    if (!spec) throw new Error(`Unknown agent "${agentId}".`);
    return spec;
  }

  private agentSpecSafe(sessionId: string): AgentSpec | undefined {
    const meta = this.deps.projects.meta(sessionId);
    if (!meta) return undefined;
    try {
      return this.specFor(meta.agentId);
    } catch {
      return undefined;
    }
  }

  private projectDirFor(sessionId: string): string | undefined {
    const meta = this.deps.projects.meta(sessionId);
    if (!meta) return undefined;
    return this.deps.projects.list().projects.find((p) => p.id === meta.projectId)?.dir;
  }

  /** Folder-backed projects: tell the agent it has hands and where they work. */
  private projectized(spec: AgentSpec, sessionId: string): AgentSpec {
    const dir = this.projectDirFor(sessionId);
    const builtinNote = this.deps.builtins
      ? `\n\nCurrent local date-time: ${fmtStamp(Date.now())}.\n` +
        'You can always search the web (web_search, then web_fetch to read a result) and run ' +
        'background missions (mission_create / mission_list / mission_control) — use a mission for ' +
        'long or repeating work instead of doing it inline. You also have cross-everything memory: ' +
        'memory_recall searches the timestamped journal of ALL activity (every chat in every ' +
        'project, missions, Telegram, file writes, commands) — use it for questions about what the ' +
        'user was doing at some time or in some project. memory_note pins a durable fact there.'
      : '';
    if (!dir) {
      return builtinNote ? { ...spec, systemPrompt: `${spec.systemPrompt ?? ''}${builtinNote}` } : spec;
    }
    return {
      ...spec,
      systemPrompt:
        `${spec.systemPrompt ?? ''}\n\n` +
        `You are working in the project folder "${dir}". You have direct workspace tools: ` +
        `ws_list (see files), ws_read (read a file), ws_write (create/overwrite a file), and ` +
        `ws_run (run shell commands like npm install, npm run build, tests). ` +
        `DO THE WORK YOURSELF with these tools — write the files and run the commands instead of ` +
        `giving the user manual instructions. Verify your work by running builds/tests. ` +
        `Ask before anything destructive.${builtinNote}`,
    };
  }

  private sessionFor(sessionId: string): AgentSession {
    const meta = this.deps.projects.meta(sessionId);
    if (!meta) throw new Error(`Unknown chat session "${sessionId}".`);
    let session = this.sessions.get(sessionId);
    if (session) {
      // Pick up agent edits (or a switched agent) since the last send.
      session.spec = this.projectized(this.specFor(meta.agentId), sessionId);
      return session;
    }
    session = new AgentSession({
      id: sessionId,
      spec: this.projectized(this.specFor(meta.agentId), sessionId),
      resolve: (spec) => {
        const { defaultProvider, defaultModel } = this.deps.config.get();
        const bound = this.deps.hub
          .registry()
          .resolve(spec, { provider: defaultProvider, model: defaultModel });
        this.lastBound.set(sessionId, bound);
        return bound;
      },
      emit: (sid, event) => {
        this.deps.send(IPC.chatEvent, { sessionId: sid, event });
        this.deps.onEvent?.(sid, event);
        if (event.type === 'usage') {
          this.deps.onUsage?.(sid, this.lastBound.get(sid), event);
        }
        if (event.type === 'status' && event.status === 'idle') this.persist(sid);
      },
      toolExecutor: {
        tools: () => {
          const dir = this.projectDirFor(sessionId);
          return [
            ...(dir ? workspaceToolSpecs(dir) : []),
            ...(this.deps.builtins?.specs() ?? []),
            ...this.deps.mcp.toolsFor(this.agentSpecSafe(sessionId)?.mcpServers),
          ];
        },
        execute: (name, args) => {
          if (name.startsWith('ws_')) {
            const dir = this.projectDirFor(sessionId);
            if (!dir) {
              return Promise.resolve({
                content: 'This chat belongs to a project without a folder.',
                isError: true,
              });
            }
            return executeWorkspaceTool(dir, name, args);
          }
          if (this.deps.builtins && (name.startsWith('web_') || name.startsWith('mission_'))) {
            return this.deps.builtins.execute(name, args);
          }
          return this.deps.mcp.call(name, args);
        },
      },
      permission: (req) => this.requestPermission(sessionId, req.name, req.args),
    });
    session.history.push(...this.deps.projects.loadTranscript(sessionId));
    this.sessions.set(sessionId, session);
    return session;
  }

  historyOf(sessionId: string): HarnessMessage[] {
    return this.sessions.get(sessionId)?.history ?? this.deps.projects.loadTranscript(sessionId);
  }

  send(
    sessionId: string,
    parts: UserPart[],
    override?: { provider?: string; model?: string },
    specOverride?: AgentSpec,
  ): SendResult {
    try {
      const session = this.sessionFor(sessionId);
      // Vodo delegation: this turn runs with the specialist's full spec
      // (prompt, tools, model); the next send re-resolves from the meta.
      if (specOverride) session.spec = this.projectized(specOverride, sessionId);
      const result = session.send(parts, override);
      if (result.ok) this.persist(sessionId);
      return result;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  inject(sessionId: string, parts: UserPart[]): SendResult {
    try {
      const result = this.sessionFor(sessionId).inject(parts);
      if (result.ok) this.persist(sessionId);
      return result;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  stop(sessionId: string): void {
    this.sessions.get(sessionId)?.stop();
  }

  reset(sessionId: string): void {
    this.sessions.get(sessionId)?.reset();
    this.deps.projects.saveTranscript(sessionId, []);
    this.deps.projects.touch(sessionId);
    this.deps.send(IPC.projectsChanged, this.deps.projects.list());
  }

  setAgent(sessionId: string, agentId: string): void {
    this.deps.projects.setAgent(sessionId, agentId);
    const live = this.sessions.get(sessionId);
    if (live) {
      try {
        live.spec = this.specFor(agentId);
      } catch {
        /* unknown agent — next send reports it */
      }
    }
  }

  dropLive(sessionId: string): void {
    const live = this.sessions.get(sessionId);
    if (live) {
      live.stop();
      this.sessions.delete(sessionId);
    }
  }

  private persist(sessionId: string): void {
    const live = this.sessions.get(sessionId);
    if (!live) return;
    this.deps.projects.saveTranscript(sessionId, live.history);
    const firstUser = live.history.find((m) => m.role === 'user');
    const firstText =
      firstUser && firstUser.role === 'user'
        ? firstUser.content
            .filter((p): p is Extract<UserPart, { type: 'text' }> => p.type === 'text')
            .map((p) => p.text)
            .join(' ')
            .trim()
        : '';
    this.deps.projects.touch(sessionId, firstText || undefined);
    this.deps.send(IPC.projectsChanged, this.deps.projects.list());
  }

  private requestPermission(
    sessionId: string,
    name: string,
    args: unknown,
  ): Promise<PermissionDecision> {
    if (AUTO_ALLOWED_TOOLS.has(name)) return Promise.resolve('allow');
    return new Promise((resolve) => {
      const requestId = `perm_${++this.permSeq}`;
      this.pendingPermissions.set(requestId, resolve);
      const prompt: PermissionPrompt = {
        requestId,
        sessionId,
        agentName: this.agentSpecSafe(sessionId)?.name ?? 'Agent',
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
