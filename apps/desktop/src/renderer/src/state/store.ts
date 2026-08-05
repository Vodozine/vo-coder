import { create } from 'zustand';
import type { AgentSpec, HarnessMessage, ModelInfo, UserPart } from '@vo-coder/providers';
import type { McpServerStatus, McpSuggestion } from '@vo-coder/core';
import type {
  ChatSessionMeta,
  GroupRun,
  ProjectInfo,
  UsageData,
} from '../../../shared/ipc-contract';
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
      /** Untruncated length of the result — `result` is a display copy. */
      resultChars?: number;
      /** Generated image on disk — rendered inline via imageRead. */
      imagePath?: string;
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
  usage?: {
    inputTokens: number;
    outputTokens: number;
    /**
     * The size of the LAST request, not the turn's sum. A tool-heavy run makes
     * many requests, so the sum answers "what did this turn cost" while this
     * answers "how big is the window we actually send" — the only one of the
     * two that says anything about fitting.
     */
    lastInputTokens?: number;
  };
  /**
   * Milliseconds spent actually producing tokens, summed across the turn's
   * streams. Measured from the first delta of each stream to its last, so
   * model loading, prompt processing and tool execution — none of which
   * produce tokens — stay out of the rate.
   */
  genMs?: number;
  /** Open stream's first/last delta; folded into genMs when it ends. */
  genStart?: number;
  genLast?: number;
  /** A tool call's arguments are streaming in — the "silence" is a file being written. */
  writing?: { name?: string; chars: number };
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

export type View =
  | 'chat'
  | 'settings'
  | 'agents'
  | 'scaffold'
  | 'preview'
  | 'console'
  | 'missions'
  | 'memory';

const emptySession = (): SessionUi => ({ messages: [], streaming: false });

interface AppState {
  view: View;
  config: AppConfig | null;
  secretStatus: Record<string, string | null>;
  /** SuperGrok / X Premium device-login — counts as xAI auth without an API key. */
  xaiOauthConnected: boolean;
  /** Keyed by chat session id. */
  sessions: Record<string, SessionUi>;
  projects: ProjectInfo[];
  sessionMetas: ChatSessionMeta[];
  /** Group runs — several agents on one goal, shown side by side. */
  groups: GroupRun[];
  activeProjectId: string | null;
  activeSessionId: string | null;
  models: ModelInfo[];
  modelsError: string | null;
  mcpStatus: McpServerStatus[];
  permissions: PermissionPrompt[];
  attachments: StagedAttachment[];
  /** Unsent composer text keyed by chat session id — survives tab switches. */
  composerDrafts: Record<string, string>;
  catalog: CatalogInfo | null;
  suggestions: RankedModel[] | null;
  checkin: CheckinPayload | null;
  mcpSuggestion: McpSuggestion | null;
  /** Code-review flow per session: running → verdict (pill shown). */
  review: Record<string, 'running' | 'verdict'>;
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
  /** Summarize-and-swap the active conversation; returns an error or null. */
  compactSession(): Promise<string | null>;
  newSession(projectId?: string, agentId?: string): Promise<void>;
  /** Load a transcript into the store without opening it (group panes). */
  primeSession(sessionId: string): Promise<void>;
  loadGroups(): Promise<void>;
  /** Split a goal across agents; returns an error message or null. */
  startGroup(goal: string): Promise<string | null>;
  endGroup(groupId: string): Promise<void>;
  newProject(name: string): Promise<void>;
  /** Create the folder on disk, the project, a first chat — then open the scaffold wizard. */
  newProjectIn(name: string, parentDir: string): Promise<string | null>;
  /** Attach any existing folder as a project, open a chat, and auto-run intake (no questionnaire). */
  openExistingProject(): Promise<string | null>;
  /** One-shot handoff to the Scaffold view: the folder to set up. */
  scaffoldTarget: string | null;
  consumeScaffoldTarget(): string | null;
  removeSession(sessionId: string): Promise<void>;
  removeProject(projectId: string): Promise<void>;
  setSessionAgent(agentId: string): Promise<void>;
  /** Point the active chat at a folder (picker), or detach with null. */
  attachFolder(): Promise<void>;
  detachFolder(): Promise<void>;
  /** Kick off a real read-only code review of the chat's folder. */
  startReview(): Promise<void>;
  /** Verdict pill: approve applies the fixes, reject declines, clear dismisses. */
  resolveReview(verdict: 'approve' | 'reject' | 'clear'): Promise<void>;
  send(text: string): Promise<void>;
  /** Text-only send/inject into one group member's session. */
  sendToMember(sessionId: string, text: string): Promise<void>;
  stop(): Promise<void>;
  saveConfig(patch: Partial<AppConfig>): Promise<void>;
  saveAgents(agents: AgentSpec[]): Promise<void>;
  saveSecret(provider: string, value: string): Promise<void>;
  loadModels(provider: string): Promise<void>;
  addAttachment(file: File): Promise<void>;
  removeAttachment(index: number): void;
  setComposerDraft(sessionId: string, text: string): void;
  respondPermission(requestId: string, decision: 'allow' | 'deny'): Promise<void>;
  refreshMcp(): Promise<void>;
  mcpConnect(name: string): Promise<void>;
  mcpDisconnect(name: string): Promise<void>;
}

let nextId = 1;
let subscribed = false;
/** Shared boot so React StrictMode double-mount cannot create two starter chats. */
let bootPromise: Promise<void> | null = null;

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
  xaiOauthConnected: false,
  sessions: {},
  projects: [],
  sessionMetas: [],
  groups: [],
  activeProjectId: null,
  activeSessionId: null,
  models: [],
  modelsError: null,
  mcpStatus: [],
  permissions: [],
  attachments: [],
  composerDrafts: {},
  catalog: null,
  suggestions: null,
  checkin: null,
  mcpSuggestion: null,
  review: {},
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
      // Vision only while an image is recent — older ones get stubbed for
      // blind models by the session layer.
      needsVision:
        attachments.some((a) => a.kind === 'image') ||
        history.slice(-6).some((m) => m.attachments?.some((a) => a.kind === 'image')),
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
      // Grok login (OAuth) is first-class xAI auth — refresh status + model lists.
      window.vo.onXaiOauth((event) => {
        if (event.state === 'connected') {
          set({ xaiOauthConnected: true });
          // Always refresh the xAI list so Chat/Agents/Settings pickers
          // populate as soon as Grok login lands. Also re-pull the catalog
          // so seed API rates flip to $0 (subscription) in the header.
          void get().loadModels('xai');
          void get().loadCatalog();
        } else if (event.state === 'signed_out') {
          set({ xaiOauthConnected: false });
          const provider = get().config?.defaultProvider;
          if (provider === 'xai') void get().loadModels('xai');
          // Restore paid API rates in the UI once OAuth is gone.
          void get().loadCatalog();
        }
      });
      // Once-only: sessionCreate broadcasts the full list; stacking this listener
      // plus a local prepend would paint the same chat twice.
      // An agent opened a result in the preview (e.g. the group's finished
      // site) — bring the pane forward so the user actually sees it.
      window.vo.onPreviewShowRequested(() => get().setView('preview'));
      window.vo.onProjectsChanged((data) => {
        set({ projects: data.projects, sessionMetas: data.sessions });
        // A group Vodo just started arrives as new sessions on this broadcast;
        // the run itself lives beside them, so pull it too or the panes never
        // appear until the next restart.
        void get().loadGroups();
      });
    }
    // StrictMode remounts effects in dev — share one boot so we never create
    // two starter chats when the project is empty.
    if (bootPromise) return bootPromise;
    bootPromise = (async () => {
    const [config, secretStatus, mcpStatus, xaiOauth] = await Promise.all([
      window.vo.getConfig(),
      window.vo.secretStatus(),
      window.vo.mcpList(),
      window.vo.xaiOauthStatus(),
    ]);
    set({ config, secretStatus, mcpStatus, xaiOauthConnected: xaiOauth.connected });
    void get().loadModels(config.defaultProvider);
    void get().loadCatalog();
    void window.vo.usageGet().then((usage) => set({ usage }));
    void window.vo.missionsList().then((missions) => set({ missions }));
    // A group survives a restart: its members are ordinary sessions on disk,
    // so the panes come back with the work still in them.
    void get().loadGroups();

    const data = await window.vo.projectsList();
    set({ projects: data.projects, sessionMetas: data.sessions });
    // Resume the most recent thread, or start the first one.
    if (!get().activeSessionId) {
      const latest = data.sessions[0];
      if (latest) await get().openSession(latest.id);
      else if (data.projects[0]) await get().newSession(data.projects[0].id);
    }
    })();
    return bootPromise;
  },

  setView(view) {
    set({ view });
  },

  async compactSession() {
    const sessionId = get().activeSessionId;
    if (!sessionId) return 'No active chat.';
    const result = await window.vo.chatCompact(sessionId);
    if (!result.ok) return result.error ?? 'Compaction failed.';
    // Re-pull the rewritten history from main.
    const { history } = await window.vo.sessionOpen(sessionId);
    set((s) => ({
      sessions: {
        ...s.sessions,
        [sessionId]: { messages: uiFromHistory(history), streaming: false },
      },
    }));
    return null;
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

  /** Load a session's transcript into the store WITHOUT making it active —
   *  group panes watch members that the user has not opened. */
  async primeSession(sessionId) {
    if (get().sessions[sessionId]) return;
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
  },

  async loadGroups() {
    try {
      set({ groups: await window.vo.groupList() });
    } catch {
      /* groups are an overlay on ordinary sessions — never block the app */
    }
  },

  /**
   * Hand the goal to Vodo to PLAN, rather than splitting it here.
   *
   * Dividing a job across a team is the most consequential reasoning in the
   * feature, and it belongs to the model that has the project's folder, the
   * memory map and tools — in the thread, where the plan is visible and the
   * user can argue with it. The UI only asks the question.
   */
  async startGroup(goal) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return 'Open a chat in a project first.';
    const meta = get().sessionMetas.find((m) => m.id === sessionId);
    if (meta && meta.agentId !== 'default') {
      return (
        'This chat talks straight to one agent, so Vodo is not in it and cannot plan a group. ' +
        'Switch the agent dropdown to Vodo (or open a new chat) and try again.'
      );
    }
    const text =
      `GROUP PROJECT — plan this before anyone starts:\n\n${goal.trim()}\n\n` +
      'Work out which parts can genuinely run at the same time, say what each part is and ' +
      'which agent should take it and why — then CALL group_start with those parts in the same ' +
      'turn. Stating the plan does nothing by itself; the work only starts when the tool is ' +
      'called. If it truly cannot be divided, say so and just do it yourself.';
    // noRoute: this request must reach Vodo ITSELF. Under "agents only" a
    // plain send hands even the coordination request to a specialist, who has
    // no coordination prompt — the plan appeared and then nothing happened.
    const userMsg: UiMessage = { id: nextId++, role: 'user', text, streaming: false };
    set((s) => ({
      sessions: {
        ...s.sessions,
        [sessionId]: {
          ...(s.sessions[sessionId] ?? emptySession()),
          messages: [...(s.sessions[sessionId]?.messages ?? []), userMsg],
        },
      },
    }));
    const result = await window.vo.chatSend(
      sessionId,
      [{ type: 'text', text }],
      undefined,
      { noRoute: true },
    );
    return result.ok ? null : (result.error ?? 'Could not start the group.');
  },

  async endGroup(groupId) {
    set({ groups: await window.vo.groupEnd(groupId) });
  },

  async newSession(projectId, agentId) {
    const targetProject =
      projectId ?? get().activeProjectId ?? get().projects[0]?.id ?? 'general';
    const meta = await window.vo.sessionCreate(targetProject, agentId);
    set((s) => ({
      // sessionCreate already broadcasts this meta via projectsChanged; only
      // prepend if the event has not landed yet (otherwise the sidebar shows two).
      sessionMetas: s.sessionMetas.some((m) => m.id === meta.id)
        ? s.sessionMetas
        : [meta, ...s.sessionMetas],
      sessions: { ...s.sessions, [meta.id]: s.sessions[meta.id] ?? emptySession() },
      activeSessionId: meta.id,
      activeProjectId: targetProject,
      view: 'chat',
    }));
  },

  async newProject(name) {
    const project = await window.vo.projectCreate(name);
    set((s) => ({
      projects: s.projects.some((p) => p.id === project.id) ? s.projects : [...s.projects, project],
      activeProjectId: project.id,
    }));
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
    // Straight into the 8-question setup for the new folder.
    set({ scaffoldTarget: project.dir ?? null, view: 'scaffold' });
    return null;
  },

  async openExistingProject() {
    const picked = await window.vo.scaffoldPickDir();
    if (!picked) return null;
    const result = await window.vo.projectOpenExisting(picked);
    if (!result.ok || !result.project) return result.error ?? 'Could not open that folder.';
    const project = result.project;
    set((s) => ({
      projects: s.projects.some((p) => p.id === project.id)
        ? s.projects.map((p) => (p.id === project.id ? project : p))
        : [...s.projects, project],
      activeProjectId: project.id,
    }));
    // Prefer an existing chat in this project; otherwise start a fresh one.
    const existingChat = get().sessionMetas.find((m) => m.projectId === project.id);
    const isFresh = !existingChat;
    if (existingChat) await get().openSession(existingChat.id);
    else await get().newSession(project.id);

    // Automatic intake only on first attach (or a brand-new chat) — reopening
    // the same folder must not spam another scan. Never force the questionnaire.
    if (project.dir && (result.created || isFresh)) {
      const intake =
        'A project folder was just attached. Run an automatic project intake now so you are ready ' +
        'to continue work immediately.\n\n' +
        '1) ws_list the root (and one level of important subfolders if needed) to map the tree.\n' +
        "2) Read the project's Markdown documentation that matters for context: README*, " +
        'PROJECT_CONFIG.md, CONTRIBUTING*, AGENTS.md, docs/**/*.md (skip node_modules, dist, ' +
        'build, .git, lockfiles, and huge generated files). Use ws_read on each useful file.\n' +
        '3) Summarize for me in plain language: what this project is, the stack/tools, how to ' +
        'build/run/test, current state of the work, and the most useful next steps.\n' +
        '4) Call map_update to pin durable facts (components, decisions, tasks you can see from ' +
        'the docs). Keep the reply concise — a briefing, not a dump.\n\n' +
        'Do the intake yourself with tools. Do not ask me to fill a questionnaire.';
      // Fire-and-forget: UI is already on the chat; the stream fills in.
      void get().send(intake);
    }
    set({ view: 'chat' });
    return null;
  },

  async removeSession(sessionId) {
    await window.vo.sessionDelete(sessionId);
    set((s) => {
      const sessions = { ...s.sessions };
      delete sessions[sessionId];
      const composerDrafts = { ...s.composerDrafts };
      delete composerDrafts[sessionId];
      return {
        sessions,
        composerDrafts,
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
    set((s) => {
      const keep = new Set(data.sessions.map((m) => m.id));
      const composerDrafts = Object.fromEntries(
        Object.entries(s.composerDrafts).filter(([id]) => keep.has(id)),
      );
      return {
        projects: data.projects,
        sessionMetas: data.sessions,
        composerDrafts,
        activeProjectId: s.activeProjectId === projectId ? null : s.activeProjectId,
        activeSessionId: s.sessionMetas.find((m) => m.id === s.activeSessionId)?.projectId === projectId
          ? null
          : s.activeSessionId,
      };
    });
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

  async attachFolder() {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    const dir = await window.vo.scaffoldPickDir();
    if (!dir) return;
    await window.vo.sessionSetDir(sessionId, dir);
    set((s) => ({
      sessionMetas: s.sessionMetas.map((m) => (m.id === sessionId ? { ...m, dir } : m)),
    }));
  },

  async detachFolder() {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    await window.vo.sessionSetDir(sessionId, null);
    set((s) => ({
      sessionMetas: s.sessionMetas.map((m) =>
        m.id === sessionId ? { ...m, dir: undefined } : m,
      ),
    }));
  },

  async startReview() {
    const sessionId = get().activeSessionId;
    if (!sessionId || get().review[sessionId]) return;
    set((s) => ({ review: { ...s.review, [sessionId]: 'running' } }));
    await get().send(
      'Run a real code review of the working folder now.\n' +
        '1) ws_list to map the tree, then ws_read the files that matter (core source and configs; ' +
        'skip lockfiles, build output, and media).\n' +
        '2) Report findings ordered by severity — each with the file path (line where possible), ' +
        'what is wrong, and why it matters: bugs, security issues, race conditions, error-handling ' +
        'gaps, dead code, quick wins.\n' +
        '3) End with a section titled "PROPOSED CHANGES": a numbered list of the exact edits you ' +
        'would make (file → change). Do NOT modify any files in this run — propose only, then ' +
        'stop and wait for my verdict.',
    );
  },

  async resolveReview(verdict) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    set((s) => {
      const review = { ...s.review };
      delete review[sessionId];
      return { review };
    });
    if (verdict === 'approve') {
      await get().send(
        'APPROVED — apply the proposed changes now: make the edits with ws_write exactly as ' +
          'proposed (adjust only where a file has changed underneath you), verify with ws_run ' +
          '(build/tests), and report what changed plus what the verification said.',
      );
    } else if (verdict === 'reject') {
      await get().send(
        'DECLINED — do not apply the proposed changes. Leave the files as they are; acknowledge ' +
          'in one line.',
      );
    }
  },

  /**
   * Text-only send into a specific session — what a group pane needs to
   * redirect one member. Deliberately self-contained rather than reusing the
   * main composer path: no attachments, no active-session coupling, and it
   * injects instead of failing when that member is mid-run.
   */
  async sendToMember(sessionId, text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const userMsg: UiMessage = { id: nextId++, role: 'user', text: trimmed, streaming: false };
    set((s) => ({
      sessions: {
        ...s.sessions,
        [sessionId]: {
          ...(s.sessions[sessionId] ?? emptySession()),
          messages: [...(s.sessions[sessionId]?.messages ?? []), userMsg],
        },
      },
    }));
    const parts: UserPart[] = [{ type: 'text', text: trimmed }];
    if (get().sessions[sessionId]?.streaming) await window.vo.chatInject(sessionId, parts);
    else await window.vo.chatSend(sessionId, parts);
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
        // A send that never started streaming will never emit 'idle' — drop
        // any pending review so the button doesn't wedge at "Reviewing…".
        const review = { ...s.review };
        delete review[activeSessionId];
        return {
          review,
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

  setComposerDraft(sessionId, text) {
    set((s) => {
      if (!text) {
        if (!(sessionId in s.composerDrafts)) return s;
        const composerDrafts = { ...s.composerDrafts };
        delete composerDrafts[sessionId];
        return { composerDrafts };
      }
      return { composerDrafts: { ...s.composerDrafts, [sessionId]: text } };
    });
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

// The preview pane and its dev server belong to one project. Switching
// projects — via any path (open session, new project, delete…) — tears both
// down so the next project never inherits a stale page or a squatting server.
useStore.subscribe((state, prev) => {
  if (state.activeProjectId !== prev.activeProjectId) void window.vo.previewClose();
});

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
  /** Fold an open stream's delta span into the turn's generation time. */
  const sealGen = (m: UiMessage): UiMessage =>
    m.genStart !== undefined && m.genLast !== undefined
      ? {
          ...m,
          genMs: (m.genMs ?? 0) + (m.genLast - m.genStart),
          genStart: undefined,
          genLast: undefined,
        }
      : m;
  const appendText = (kind: 'text' | 'thinking', text: string): void => {
    patchDraft((m) => {
      const segments = [...(m.segments ?? [])];
      const last = segments[segments.length - 1];
      if (last && last.kind === kind) {
        segments[segments.length - 1] = { ...last, text: last.text + text };
      } else {
        segments.push({ kind, text });
      }
      const now = Date.now();
      return { ...m, segments, genStart: m.genStart ?? now, genLast: now };
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
        // The args finished streaming — the live "writing…" line hands over
        // to the real tool segment.
        writing: undefined,
        segments: [
          ...(m.segments ?? []),
          { kind: 'tool', callId: event.id, name: event.name, status: 'pending' },
        ],
      }));
      break;
    case 'tool_progress':
      // Generating a big tool call (a whole file inside one ws_write) is real
      // token output with nothing else moving on screen — show it, and count
      // it in the generation span so tok/s stays honest.
      patchDraft((m) => {
        const now = Date.now();
        return {
          ...m,
          writing: { ...(event.name ? { name: event.name } : {}), chars: event.chars },
          genStart: m.genStart ?? now,
          genLast: now,
        };
      });
      break;
    case 'tool_started':
      patchTool(event.callId, (t) => ({ ...t, status: 'running' }));
      break;
    case 'tool_result':
      patchTool(event.callId, (t) => ({
        ...t,
        status: event.isError ? 'error' : 'done',
        result: event.result.length > 600 ? `${event.result.slice(0, 600)}…` : event.result,
        // The display copy is truncated; the real size is not. Without this a
        // 50k-char ws_read reads as ~150 tokens to anything counting the UI.
        resultChars: event.result.length,
        ...(event.imagePath ? { imagePath: event.imagePath } : {}),
      }));
      break;
    case 'usage':
      patchDraft((m) => ({
        ...m,
        usage: {
          inputTokens: (m.usage?.inputTokens ?? 0) + event.inputTokens,
          outputTokens: (m.usage?.outputTokens ?? 0) + event.outputTokens,
          lastInputTokens: event.inputTokens,
        },
      }));
      break;
    case 'done':
      // Each stream of the turn ends here — bank its generation time before
      // the next one (after a tool call) starts its own span.
      patchDraft((m) =>
        sealGen(
          event.stopReason === 'aborted'
            ? { ...m, aborted: true, writing: undefined }
            : { ...m, writing: undefined },
        ),
      );
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
        // Seal too: a turn cut short (abort, error) may never reach 'done'.
        patchDraft((m) => sealGen({ ...m, streaming: false, writing: undefined }));
        patchSession((session) => ({ ...session, streaming: false }));
        // A finished review run means the proposal is on screen — show the
        // Approve / Revise / Don't accept pill.
        set((s) =>
          s.review[sessionId] === 'running'
            ? { review: { ...s.review, [sessionId]: 'verdict' } }
            : s,
        );
      }
      break;
  }
}
