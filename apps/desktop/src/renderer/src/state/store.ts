import { create } from 'zustand';
import type { AgentSpec, HarnessMessage, ModelInfo, UserPart } from '@vo-coder/providers';
import type { McpServerStatus, McpSuggestion } from '@vo-coder/core';
import type { ChatSessionMeta, ProjectInfo, UsageData } from '../../../shared/ipc-contract';
import type { RankedModel } from '@vo-coder/capability-registry';
import type {
  AppConfig,
  CatalogInfo,
  ChatEventPayload,
  CheckinPayload,
  Mission,
  PermissionPrompt,
  UpdateEvent,
  WatchEvent,
} from '../../../shared/ipc-contract';

export type FileChangeState = 'baseline' | 'added' | 'modified' | 'deleted';

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'tool';
      callId: string;
      name: string;
      status: 'pending' | 'running' | 'done' | 'error';
      result?: string;
    };

export interface UiMessage {
  id: number;
  role: 'user' | 'assistant';
  /** user messages */
  text?: string;
  attachments?: Array<{ name: string; kind: 'image' | 'file' }>;
  /** injected while the agent was busy; delivered on the next turn */
  queuedNote?: boolean;
  /** Vodo's routing decision for this reply. */
  routedNote?: string;
  /** assistant messages */
  segments?: Segment[];
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
  streaming: boolean;
  aborted?: boolean;
}

export interface StagedAttachment {
  name: string;
  mediaType: string;
  data: string; // base64
  kind: 'image' | 'file';
}

interface SessionUi {
  messages: UiMessage[];
  streaming: boolean;
}

export type View = 'chat' | 'settings' | 'agents' | 'scaffold' | 'preview' | 'console' | 'missions';

const emptySession = (): SessionUi => ({ messages: [], streaming: false });

interface AppState {
  view: View;
  config: AppConfig | null;
  secretStatus: Record<string, string | null>;
  /** Keyed by chat session id. */
  sessions: Record<string, SessionUi>;
  projects: ProjectInfo[];
  sessionMetas: ChatSessionMeta[];
  activeProjectId: string | null;
  activeSessionId: string | null;
  models: ModelInfo[];
  modelsError: string | null;
  mcpStatus: McpServerStatus[];
  permissions: PermissionPrompt[];
  attachments: StagedAttachment[];
  catalog: CatalogInfo | null;
  suggestions: RankedModel[] | null;
  checkin: CheckinPayload | null;
  mcpSuggestion: McpSuggestion | null;
  /** Prefills the Settings MCP search (set by the advisor banner). */
  mcpSearchQuery: string | null;
  watchRoot: string | null;
  watchReady: boolean;
  watchFiles: Record<string, FileChangeState>;
  watchLastChange: { path: string; state: FileChangeState; at: number } | null;
  /** null until the watcher reports; then whether the root is a git repo. */
  watchGit: boolean | null;
  /** Uncommitted changes vs HEAD when watchGit is true. */
  gitStates: Record<string, 'added' | 'modified' | 'deleted'>;
  updateInfo: UpdateEvent | null;
  usage: UsageData | null;
  missions: Mission[];

  startWatch(dir: string): Promise<string | null>;
  stopWatch(): Promise<void>;
  dismissMcpSuggestion(searchInstead: boolean): void;
  consumeMcpSearchQuery(): string | null;
  dismissCheckin(): void;
  init(): Promise<void>;
  loadCatalog(): Promise<void>;
  suggestFor(text: string): Promise<void>;
  clearSuggestions(): void;
  applySuggestion(ranked: RankedModel): Promise<void>;
  setView(view: View): void;
  openSession(sessionId: string): Promise<void>;
  newSession(projectId?: string, agentId?: string): Promise<void>;
  newProject(name: string): Promise<void>;
  /** Create the folder on disk, the project, a first chat — then open the scaffold wizard. */
  newProjectIn(name: string, parentDir: string): Promise<string | null>;
  /** One-shot handoff to the Scaffold view: the folder to set up. */
  scaffoldTarget: string | null;
  consumeScaffoldTarget(): string | null;
  removeSession(sessionId: string): Promise<void>;
  removeProject(projectId: string): Promise<void>;
  setSessionAgent(agentId: string): Promise<void>;
  send(text: string): Promise<void>;
  stop(): Promise<void>;
  saveConfig(patch: Partial<AppConfig>): Promise<void>;
  saveAgents(agents: AgentSpec[]): Promise<void>;
  saveSecret(provider: string, value: string): Promise<void>;
  loadModels(provider: string): Promise<void>;
  addAttachment(file: File): Promise<void>;
  removeAttachment(index: number): void;
  respondPermission(requestId: string, decision: 'allow' | 'deny'): Promise<void>;
  refreshMcp(): Promise<void>;
  mcpConnect(name: string): Promise<void>;
  mcpDisconnect(name: string): Promise<void>;
}

let nextId = 1;
let subscribed = false;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export const useStore = create<AppState>((set, get) => ({
  view: 'chat',
  config: null,
  secretStatus: {},
  sessions: {},
  projects: [],
  sessionMetas: [],
  activeProjectId: null,
  activeSessionId: null,
  models: [],
  modelsError: null,
  mcpStatus: [],
  permissions: [],
  attachments: [],
  catalog: null,
  suggestions: null,
  checkin: null,
  mcpSuggestion: null,
  mcpSearchQuery: null,
  watchRoot: null,
  watchReady: false,
  watchFiles: {},
  watchLastChange: null,
  watchGit: null,
  gitStates: {},
  updateInfo: null,
  usage: null,
  missions: [],

  async startWatch(dir) {
    const result = await window.vo.watchStart(dir);
    if (!result.ok) return result.error ?? 'Could not watch that folder.';
    set({
      watchRoot: dir,
      watchReady: false,
      watchFiles: {},
      watchLastChange: null,
      watchGit: null,
      gitStates: {},
    });
    return null;
  },

  async stopWatch() {
    await window.vo.watchStop();
    set({
      watchRoot: null,
      watchReady: false,
      watchFiles: {},
      watchLastChange: null,
      watchGit: null,
      gitStates: {},
    });
  },

  dismissMcpSuggestion(searchInstead) {
    const suggestion = get().mcpSuggestion;
    if (!suggestion) return;
    if (searchInstead) {
      set({ mcpSuggestion: null, mcpSearchQuery: suggestion.query, view: 'settings' });
    } else {
      void window.vo.advisorDismiss(suggestion.topic);
      set({ mcpSuggestion: null });
    }
  },

  consumeMcpSearchQuery() {
    const query = get().mcpSearchQuery;
    if (query) set({ mcpSearchQuery: null });
    return query;
  },

  dismissCheckin() {
    set({ checkin: null });
  },

  async loadCatalog() {
    try {
      set({ catalog: await window.vo.registryCatalog() });
    } catch {
      /* advisory only — never blocks chat */
    }
  },

  async suggestFor(text) {
    const { attachments, sessions, activeSessionId } = get();
    const history = activeSessionId ? (sessions[activeSessionId]?.messages ?? []) : [];
    const suggestions = await window.vo.registrySuggest(text, {
      // Images anywhere in the conversation demand vision on every turn.
      needsVision:
        attachments.some((a) => a.kind === 'image') ||
        history.some((m) => m.attachments?.some((a) => a.kind === 'image')),
      needsTools: get().mcpStatus.some((s) => s.connected),
    });
    set({ suggestions });
  },

  clearSuggestions() {
    set({ suggestions: null });
  },

  async applySuggestion(ranked) {
    const provider = ranked.model.provider;
    if (!provider || provider === 'any') return;
    await get().saveConfig({ defaultProvider: provider, defaultModel: ranked.model.id });
    await get().loadModels(provider);
    set({ suggestions: null });
  },

  async init() {
    if (!subscribed) {
      subscribed = true;
      window.vo.onChatEvent((payload) => handleEvent(payload, set));
      window.vo.onPermissionRequest((prompt) =>
        set((s) => ({ permissions: [...s.permissions, prompt] })),
      );
      window.vo.onCheckin((payload) => set({ checkin: payload }));
      window.vo.onAdvisorSuggest((suggestion) => set({ mcpSuggestion: suggestion }));
      window.vo.onWatchEvent((event) => handleWatchEvent(event, set));
      window.vo.onWatchGit((status) => set({ watchGit: status.git, gitStates: status.states }));
      window.vo.onUpdateEvent((event) => set({ updateInfo: event }));
      window.vo.onUsageChanged((data) => set({ usage: data }));
      window.vo.onMissionsChanged((missions) => set({ missions }));
    }
    const [config, secretStatus, mcpStatus] = await Promise.all([
      window.vo.getConfig(),
      window.vo.secretStatus(),
      window.vo.mcpList(),
    ]);
    set({ config, secretStatus, mcpStatus });
    void get().loadModels(config.defaultProvider);
    void get().loadCatalog();
    void window.vo.usageGet().then((usage) => set({ usage }));
    void window.vo.missionsList().then((missions) => set({ missions }));

    window.vo.onProjectsChanged((data) =>
      set({ projects: data.projects, sessionMetas: data.sessions }),
    );
    const data = await window.vo.projectsList();
    set({ projects: data.projects, sessionMetas: data.sessions });
    // Resume the most recent thread, or start the first one.
    if (!get().activeSessionId) {
      const latest = data.sessions[0];
      if (latest) await get().openSession(latest.id);
      else if (data.projects[0]) await get().newSession(data.projects[0].id);
    }
  },

  setView(view) {
    set({ view });
  },

  async openSession(sessionId) {
    const meta = get().sessionMetas.find((m) => m.id === sessionId);
    if (!get().sessions[sessionId]) {
      try {
        const { history } = await window.vo.sessionOpen(sessionId);
        set((s) => ({
          sessions: {
            ...s.sessions,
            [sessionId]: { messages: uiFromHistory(history), streaming: false },
          },
        }));
      } catch {
        set((s) => ({ sessions: { ...s.sessions, [sessionId]: emptySession() } }));
      }
    }
    set({
      activeSessionId: sessionId,
      activeProjectId: meta?.projectId ?? get().activeProjectId,
      view: 'chat',
    });
  },

  async newSession(projectId, agentId) {
    const targetProject =
      projectId ?? get().activeProjectId ?? get().projects[0]?.id ?? 'general';
    const meta = await window.vo.sessionCreate(targetProject, agentId);
    set((s) => ({
      sessionMetas: [meta, ...s.sessionMetas],
      sessions: { ...s.sessions, [meta.id]: emptySession() },
      activeSessionId: meta.id,
      activeProjectId: targetProject,
      view: 'chat',
    }));
  },

  async newProject(name) {
    const project = await window.vo.projectCreate(name);
    set((s) => ({ projects: [...s.projects, project], activeProjectId: project.id }));
    await get().newSession(project.id);
  },

  scaffoldTarget: null,

  consumeScaffoldTarget() {
    const target = get().scaffoldTarget;
    if (target) set({ scaffoldTarget: null });
    return target;
  },

  async newProjectIn(name, parentDir) {
    const result = await window.vo.projectCreateIn(parentDir, name);
    if (!result.ok || !result.project) return result.error ?? 'Could not create the project.';
    const project = result.project;
    set((s) => ({
      projects: s.projects.some((p) => p.id === project.id) ? s.projects : [...s.projects, project],
      activeProjectId: project.id,
    }));
    await get().newSession(project.id);
    // Straight into the 7-question setup for the new folder.
    set({ scaffoldTarget: project.dir ?? null, view: 'scaffold' });
    return null;
  },

  async removeSession(sessionId) {
    await window.vo.sessionDelete(sessionId);
    set((s) => {
      const sessions = { ...s.sessions };
      delete sessions[sessionId];
      return {
        sessions,
        sessionMetas: s.sessionMetas.filter((m) => m.id !== sessionId),
        activeSessionId: s.activeSessionId === sessionId ? null : s.activeSessionId,
      };
    });
    if (!get().activeSessionId) {
      const next = get().sessionMetas[0];
      if (next) await get().openSession(next.id);
      else await get().newSession();
    }
  },

  async removeProject(projectId) {
    await window.vo.projectDelete(projectId);
    const data = await window.vo.projectsList();
    set((s) => ({
      projects: data.projects,
      sessionMetas: data.sessions,
      activeProjectId: s.activeProjectId === projectId ? null : s.activeProjectId,
      activeSessionId: s.sessionMetas.find((m) => m.id === s.activeSessionId)?.projectId === projectId
        ? null
        : s.activeSessionId,
    }));
    if (!get().activeSessionId) {
      const next = get().sessionMetas[0];
      if (next) await get().openSession(next.id);
      else await get().newSession();
    }
  },

  async setSessionAgent(agentId) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    await window.vo.sessionSetAgent(sessionId, agentId);
    set((s) => ({
      sessionMetas: s.sessionMetas.map((m) => (m.id === sessionId ? { ...m, agentId } : m)),
    }));
  },

  async send(text) {
    const { activeSessionId, attachments, config, models, sessions, sessionMetas } = get();
    if (!activeSessionId) return;
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;

    // Mid-stream: graceful injection instead of a blocked send.
    if (sessions[activeSessionId]?.streaming) {
      const injectParts: UserPart[] = [];
      for (const att of attachments) {
        injectParts.push(
          att.kind === 'image'
            ? { type: 'image', mediaType: att.mediaType, data: att.data }
            : { type: 'file', mediaType: att.mediaType, name: att.name, data: att.data },
        );
      }
      if (trimmed) injectParts.push({ type: 'text', text: trimmed });
      const userMsg: UiMessage = {
        id: nextId++,
        role: 'user',
        text: trimmed,
        attachments: attachments.map((a) => ({ name: a.name, kind: a.kind })),
        streaming: false,
      };
      set((s) => ({
        attachments: [],
        sessions: {
          ...s.sessions,
          [activeSessionId]: {
            ...s.sessions[activeSessionId]!,
            messages: [...s.sessions[activeSessionId]!.messages, userMsg],
          },
        },
      }));
      const result = await window.vo.chatInject(activeSessionId, injectParts);
      if (result.queued) {
        set((s) => ({
          sessions: {
            ...s.sessions,
            [activeSessionId]: {
              ...s.sessions[activeSessionId]!,
              messages: s.sessions[activeSessionId]!.messages.map((m) =>
                m.id === userMsg.id ? { ...m, queuedNote: true } : m,
              ),
            },
          },
        }));
      }
      return;
    }

    const parts: UserPart[] = [];
    for (const att of attachments) {
      parts.push(
        att.kind === 'image'
          ? { type: 'image', mediaType: att.mediaType, data: att.data }
          : { type: 'file', mediaType: att.mediaType, name: att.name, data: att.data },
      );
    }
    if (trimmed) parts.push({ type: 'text', text: trimmed });

    // Vision-pointer reroute: only when we positively know the model lacks vision.
    let override: { provider?: string; model?: string } | undefined;
    if (config && attachments.some((a) => a.kind === 'image')) {
      const meta = sessionMetas.find((m) => m.id === activeSessionId);
      const agent = config.agents.find((a) => a.id === meta?.agentId);
      const modelId = agent?.model ?? config.defaultModel;
      const info = models.find((m) => m.id === modelId);
      if (info?.supportsVision === false) {
        if (config.visionModel) {
          const useVision = window.confirm(
            `${modelId} can't see images. Send this to your vision model (${config.visionModel.model}) instead?`,
          );
          if (useVision) override = config.visionModel;
        } else {
          window.alert(
            `${modelId} can't see images and no vision model is set in Settings. Sending anyway — the image may be ignored.`,
          );
        }
      }
    }

    const userMsg: UiMessage = {
      id: nextId++,
      role: 'user',
      text: trimmed,
      attachments: attachments.map((a) => ({ name: a.name, kind: a.kind })),
      streaming: false,
    };
    const draft: UiMessage = {
      id: nextId++,
      role: 'assistant',
      segments: [],
      streaming: true,
    };
    set((s) => ({
      attachments: [],
      sessions: {
        ...s.sessions,
        [activeSessionId]: {
          messages: [...(s.sessions[activeSessionId]?.messages ?? []), userMsg, draft],
          streaming: true,
        },
      },
    }));

    const result = await window.vo.chatSend(activeSessionId, parts, override);
    if (result.ok && result.routed) {
      const note = result.routed.rationale;
      set((s) => {
        const session = s.sessions[activeSessionId];
        if (!session) return s;
        return {
          sessions: {
            ...s.sessions,
            [activeSessionId]: {
              ...session,
              messages: session.messages.map((m) =>
                m.id === draft.id ? { ...m, routedNote: note } : m,
              ),
            },
          },
        };
      });
    }
    if (!result.ok) {
      set((s) => {
        const session = s.sessions[activeSessionId];
        if (!session) return s;
        return {
          sessions: {
            ...s.sessions,
            [activeSessionId]: {
              streaming: false,
              messages: session.messages.map((m) =>
                m.id === draft.id ? { ...m, streaming: false, error: result.error } : m,
              ),
            },
          },
        };
      });
    }
  },

  async stop() {
    const sessionId = get().activeSessionId;
    if (sessionId) await window.vo.chatStop(sessionId);
  },

  async saveConfig(patch) {
    const config = await window.vo.setConfig(patch);
    set({ config });
  },

  async saveAgents(agents) {
    await get().saveConfig({ agents });
  },

  async saveSecret(provider, value) {
    const secretStatus = await window.vo.setSecret(provider, value);
    set({ secretStatus });
  },

  async loadModels(provider) {
    set({ models: [], modelsError: null });
    try {
      const models = await window.vo.listModels(provider);
      set({ models });
    } catch (err) {
      set({ modelsError: err instanceof Error ? err.message : String(err) });
    }
  },

  async addAttachment(file) {
    const data = await fileToBase64(file);
    const kind = file.type.startsWith('image/') ? 'image' : 'file';
    set((s) => ({
      attachments: [
        ...s.attachments,
        { name: file.name, mediaType: file.type || 'text/plain', data, kind },
      ],
    }));
  },

  removeAttachment(index) {
    set((s) => ({ attachments: s.attachments.filter((_, i) => i !== index) }));
  },

  async respondPermission(requestId, decision) {
    await window.vo.permissionRespond(requestId, decision);
    set((s) => ({ permissions: s.permissions.filter((p) => p.requestId !== requestId) }));
  },

  async refreshMcp() {
    set({ mcpStatus: await window.vo.mcpList() });
  },

  async mcpConnect(name) {
    await window.vo.mcpConnect(name);
    await get().refreshMcp();
  },

  async mcpDisconnect(name) {
    await window.vo.mcpDisconnect(name);
    await get().refreshMcp();
  },
}));

/** Rebuild display messages from a persisted harness transcript. */
function uiFromHistory(history: HarnessMessage[]): UiMessage[] {
  const toolResults = new Map<string, { content: string; isError?: boolean }>();
  for (const msg of history) {
    if (msg.role === 'tool') {
      toolResults.set(msg.toolCallId, { content: msg.content, isError: msg.isError });
    }
  }
  const out: UiMessage[] = [];
  for (const msg of history) {
    if (msg.role === 'user') {
      const text = msg.content
        .filter((p): p is Extract<UserPart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      const attachments = msg.content
        .filter((p) => p.type !== 'text')
        .map((p) => ({
          name: p.type === 'file' ? p.name : 'image',
          kind: (p.type === 'image' ? 'image' : 'file') as 'image' | 'file',
        }));
      out.push({
        id: nextId++,
        role: 'user',
        text,
        ...(attachments.length ? { attachments } : {}),
        streaming: false,
      });
    } else if (msg.role === 'assistant') {
      const segments: Segment[] = [];
      for (const part of msg.content) {
        if (part.type === 'text') segments.push({ kind: 'text', text: part.text });
        else if (part.type === 'thinking') segments.push({ kind: 'thinking', text: part.text });
        else {
          const result = toolResults.get(part.id);
          segments.push({
            kind: 'tool',
            callId: part.id,
            name: part.name,
            status: result?.isError ? 'error' : 'done',
            ...(result
              ? {
                  result:
                    result.content.length > 600
                      ? `${result.content.slice(0, 600)}…`
                      : result.content,
                }
              : {}),
          });
        }
      }
      out.push({ id: nextId++, role: 'assistant', segments, streaming: false });
    }
  }
  return out;
}

type SetFn = (fn: (s: AppState) => Partial<AppState>) => void;

function handleWatchEvent(event: WatchEvent, set: SetFn): void {
  if (event.kind === 'ready') {
    set(() => ({ watchReady: true }));
    return;
  }
  set((s) => {
    const files = { ...s.watchFiles };
    let last = s.watchLastChange;
    const mark = (path: string, state: FileChangeState) => {
      files[path] = state;
      if (!event.initial) last = { path, state, at: Date.now() };
    };
    if (event.kind === 'add') {
      mark(event.path, event.initial ? 'baseline' : 'added');
    } else if (event.kind === 'change') {
      if (!event.initial) {
        mark(event.path, files[event.path] === 'added' ? 'added' : 'modified');
      }
    } else if (event.kind === 'unlink') {
      mark(event.path, 'deleted');
    } else if (event.kind === 'unlinkDir') {
      for (const path of Object.keys(files)) {
        if (path.startsWith(`${event.path}/`)) files[path] = 'deleted';
      }
      if (!event.initial) last = { path: event.path, state: 'deleted', at: Date.now() };
    }
    return { watchFiles: files, watchLastChange: last };
  });
}

function handleEvent(payload: ChatEventPayload, set: SetFn): void {
  const { sessionId, event } = payload;
  const patchSession = (
    fn: (session: SessionUi) => SessionUi,
  ): void => {
    set((s) => {
      const session = s.sessions[sessionId] ?? emptySession();
      return { sessions: { ...s.sessions, [sessionId]: fn(session) } };
    });
  };
  const patchDraft = (fn: (m: UiMessage) => UiMessage): void => {
    patchSession((session) => {
      const messages = [...session.messages];
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        if (m.role === 'assistant' && m.streaming) {
          messages[i] = fn(m);
          return { ...session, messages };
        }
      }
      return session;
    });
  };
  const appendText = (kind: 'text' | 'thinking', text: string): void => {
    patchDraft((m) => {
      const segments = [...(m.segments ?? [])];
      const last = segments[segments.length - 1];
      if (last && last.kind === kind) {
        segments[segments.length - 1] = { ...last, text: last.text + text };
      } else {
        segments.push({ kind, text });
      }
      return { ...m, segments };
    });
  };
  const patchTool = (
    callId: string,
    fn: (t: Extract<Segment, { kind: 'tool' }>) => Segment,
  ): void => {
    patchDraft((m) => ({
      ...m,
      segments: (m.segments ?? []).map((seg) =>
        seg.kind === 'tool' && seg.callId === callId ? fn(seg) : seg,
      ),
    }));
  };

  switch (event.type) {
    case 'text_delta':
      appendText('text', event.text);
      break;
    case 'thinking_delta':
      appendText('thinking', event.text);
      break;
    case 'tool_call':
      patchDraft((m) => ({
        ...m,
        segments: [
          ...(m.segments ?? []),
          { kind: 'tool', callId: event.id, name: event.name, status: 'pending' },
        ],
      }));
      break;
    case 'tool_started':
      patchTool(event.callId, (t) => ({ ...t, status: 'running' }));
      break;
    case 'tool_result':
      patchTool(event.callId, (t) => ({
        ...t,
        status: event.isError ? 'error' : 'done',
        result: event.result.length > 600 ? `${event.result.slice(0, 600)}…` : event.result,
      }));
      break;
    case 'usage':
      patchDraft((m) => ({
        ...m,
        usage: {
          inputTokens: (m.usage?.inputTokens ?? 0) + event.inputTokens,
          outputTokens: (m.usage?.outputTokens ?? 0) + event.outputTokens,
        },
      }));
      break;
    case 'done':
      if (event.stopReason === 'aborted') {
        patchDraft((m) => ({ ...m, aborted: true }));
      }
      break;
    case 'error':
      patchDraft((m) => ({ ...m, error: event.error.message }));
      break;
    case 'status':
      if (event.status === 'streaming') {
        // Lazy draft: injection re-runs and queued turns start streams that
        // send() never created a bubble for.
        patchSession((session) => {
          const last = session.messages[session.messages.length - 1];
          if (last && last.role === 'assistant' && last.streaming) {
            return { ...session, streaming: true };
          }
          return {
            ...session,
            streaming: true,
            messages: [
              ...session.messages,
              { id: nextId++, role: 'assistant', segments: [], streaming: true },
            ],
          };
        });
      } else if (event.status === 'idle') {
        patchDraft((m) => ({ ...m, streaming: false }));
        patchSession((session) => ({ ...session, streaming: false }));
      }
      break;
  }
}
