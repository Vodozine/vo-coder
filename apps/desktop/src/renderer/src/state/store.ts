import { create } from 'zustand';
import type { AgentSpec, ModelInfo, UserPart } from '@vo-coder/providers';
import type { McpServerStatus, McpSuggestion } from '@vo-coder/core';
import type { RankedModel } from '@vo-coder/capability-registry';
import type {
  AppConfig,
  CatalogInfo,
  ChatEventPayload,
  CheckinPayload,
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

export type View = 'chat' | 'settings' | 'agents' | 'scaffold' | 'preview' | 'console';

const emptySession = (): SessionUi => ({ messages: [], streaming: false });

interface AppState {
  view: View;
  config: AppConfig | null;
  secretStatus: Record<string, string | null>;
  sessions: Record<string, SessionUi>;
  activeAgentId: string;
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
  setActiveAgent(agentId: string): void;
  send(text: string): Promise<void>;
  stop(): Promise<void>;
  resetChat(): Promise<void>;
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
  sessions: { default: emptySession() },
  activeAgentId: 'default',
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
    const { attachments } = get();
    const suggestions = await window.vo.registrySuggest(text, {
      needsVision: attachments.some((a) => a.kind === 'image'),
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
    }
    const [config, secretStatus, mcpStatus] = await Promise.all([
      window.vo.getConfig(),
      window.vo.secretStatus(),
      window.vo.mcpList(),
    ]);
    set({ config, secretStatus, mcpStatus });
    void get().loadModels(config.defaultProvider);
    void get().loadCatalog();
  },

  setView(view) {
    set({ view });
  },

  setActiveAgent(agentId) {
    set((s) => ({
      activeAgentId: agentId,
      sessions: s.sessions[agentId] ? s.sessions : { ...s.sessions, [agentId]: emptySession() },
    }));
  },

  async send(text) {
    const { activeAgentId, attachments, config, models, sessions } = get();
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;

    // Mid-stream: graceful injection instead of a blocked send.
    if (sessions[activeAgentId]?.streaming) {
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
          [activeAgentId]: {
            ...s.sessions[activeAgentId]!,
            messages: [...s.sessions[activeAgentId]!.messages, userMsg],
          },
        },
      }));
      const result = await window.vo.chatInject(activeAgentId, injectParts);
      if (result.queued) {
        set((s) => ({
          sessions: {
            ...s.sessions,
            [activeAgentId]: {
              ...s.sessions[activeAgentId]!,
              messages: s.sessions[activeAgentId]!.messages.map((m) =>
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
      const agent = config.agents.find((a) => a.id === activeAgentId);
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
        [activeAgentId]: {
          messages: [...(s.sessions[activeAgentId]?.messages ?? []), userMsg, draft],
          streaming: true,
        },
      },
    }));

    const result = await window.vo.chatSend(activeAgentId, parts, override);
    if (!result.ok) {
      set((s) => {
        const session = s.sessions[activeAgentId];
        if (!session) return s;
        return {
          sessions: {
            ...s.sessions,
            [activeAgentId]: {
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
    await window.vo.chatStop(get().activeAgentId);
  },

  async resetChat() {
    const { activeAgentId } = get();
    await window.vo.chatReset(activeAgentId);
    set((s) => ({
      sessions: { ...s.sessions, [activeAgentId]: emptySession() },
    }));
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
