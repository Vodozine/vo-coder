/**
 * Single source of truth for the main ↔ renderer boundary. The renderer is a
 * pure view: it only ever talks to main through `window.vo` (VoApi), and main
 * pushes `SessionEvent`s back verbatim — one event vocabulary end to end.
 */
import type { AgentSpec, HarnessMessage, ModelInfo, ProviderId, UserPart } from '@vo-coder/providers';
import type {
  McpRegistryEntry,
  McpServerConfig,
  McpServerStatus,
  McpSuggestion,
  SessionEvent,
} from '@vo-coder/core';
import type { ProjectAnswers } from '@vo-coder/project-config';
import type { Detection, InjectResult } from '@vo-coder/scaffold';
import type {
  FitVerdict,
  HardwareProfile,
  ModelRecord,
  RankedModel,
} from '@vo-coder/capability-registry';

export interface VisionPointer {
  provider: ProviderId;
  model: string;
}

export interface AppConfig {
  defaultProvider: ProviderId;
  defaultModel: string;
  ollamaBaseUrl: string;
  lmstudioBaseUrl: string;
  systemPrompt: string;
  agents: AgentSpec[];
  mcpServers: McpServerConfig[];
  visionModel: VisionPointer | null;
  /** Model used by the image_generate tool (an image-OUTPUT model). */
  imageModel: VisionPointer | null;
  /** Extended thinking for the Default agent (per-agent specs set their own). */
  thinkingDefault: boolean;
  voice: VoiceSettings;
  /** Remembered environment answers (virtualization/hypervisorKind/devOs) that
   *  pre-seed the scaffold questionnaire in new projects. */
  scaffoldDefaults: Record<string, string>;
  /**
   * How Vodo assigns work:
   * 'auto'        — cheapest adequate model per message (default)
   * 'agents'      — hand the job to the user's best-matching agent, Auto as fallback
   * 'agents-only' — ALWAYS one of the user's agents (hints first, best fit otherwise)
   * 'off'         — always use the selected model
   */
  routeMode: 'auto' | 'agents' | 'agents-only' | 'off';
  /**
   * Cost/intelligence tier for model routing:
   * 'cheap'    — cheapest capable model (default)
   * 'balanced' — most capable among mid-priced options
   * 'best'     — best-ranked model for the job, price ignored
   */
  routeTier: 'cheap' | 'balanced' | 'best';
  /** Case-insensitive substrings — matching models never get auto-routed
   *  (manual selection still works). e.g. ["glm", "kimi", "fable"]. */
  excludedModels: string[];
  /** OAuth client id for xAI subscription sign-in (public desktop client). */
  xaiOauthClientId: string;
  /** Check for and download updates automatically (manual check always works). */
  autoUpdate: boolean;
  /**
   * Vodo's operating mode:
   * 'auto'   — autonomous: agents act, no permission prompts
   * 'plan'   — read-only exploration; mutating tools are blocked and the
   *            agent presents a plan for approval instead
   * 'manual' — approve every write/run/MCP call
   * Read-only tools never prompt in any mode; destructive infra tools keep
   * their own confirm tier in all modes.
   */
  approvalMode: 'auto' | 'plan' | 'manual';
  /** Telegram remote control: talk to Vodo, start missions, approve tool calls. */
  telegramEnabled: boolean;
  /** Chats allowed to talk to this Vo-Coder instance (paired via one-time code). */
  telegramPaired: Array<{ id: number; name?: string }>;
}

export interface VoiceSettings {
  stt: 'openai' | 'whisper-local';
  /** Model for the OpenAI-compatible transcription endpoint. */
  sttModel: string;
  whisperPath: string;
  whisperModel: string;
  /**
   * TTS engine:
   * 'system'     — offline OS voice (SAPI / say / espeak)
   * 'openai'     — OpenAI /audio/speech with the openai key
   * 'compat'     — ANY OpenAI-compatible /audio/speech endpoint (Groq PlayAI,
   *                local Kokoro, LiteLLM proxies, …) with its own URL/key
   * 'elevenlabs' — ElevenLabs voices with the elevenlabs key
   */
  tts: 'openai' | 'system' | 'compat' | 'elevenlabs' | 'none';
  openaiVoice: string;
  /** System voice: installed voice name + rate (-10 slow … 10 fast). */
  systemVoice: string;
  systemRate: number;
  /** OpenAI-compatible custom endpoint (key: secret "tts-custom", optional). */
  compatBaseUrl: string;
  compatModel: string;
  compatVoice: string;
  /** ElevenLabs voice + model ids. */
  elevenVoiceId: string;
  elevenModel: string;
}

export const DEFAULT_CONFIG: AppConfig = {
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet-5',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  lmstudioBaseUrl: 'http://127.0.0.1:1234/v1',
  systemPrompt:
    "You are Vodo, Vo-Coder's coordinator agent. Be direct, concrete, and honest about uncertainty. It's fine to say you don't understand and ask — that's faster than confident-but-wrong.",
  agents: [],
  mcpServers: [],
  visionModel: null,
  imageModel: null,
  thinkingDefault: false,
  voice: {
    stt: 'openai',
    sttModel: 'whisper-1',
    whisperPath: '',
    whisperModel: '',
    tts: 'system',
    openaiVoice: 'alloy',
    systemVoice: '',
    systemRate: 0,
    compatBaseUrl: '',
    compatModel: '',
    compatVoice: '',
    elevenVoiceId: '',
    elevenModel: 'eleven_multilingual_v2',
  },
  scaffoldDefaults: {},
  routeMode: 'auto',
  routeTier: 'cheap',
  excludedModels: [],
  // Public client id of xAI's own CLI device flow (verified from shipping
  // open-source integrations; editable in Settings if xAI rotates it).
  xaiOauthClientId: 'b1a00492-073a-47ea-816f-4c329264a828',
  autoUpdate: true,
  approvalMode: 'manual',
  telegramEnabled: false,
  telegramPaired: [],
};

/** Attachment limits enforced at the boundary. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const ALLOWED_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/json',
] as const;
export const isAllowedMediaType = (t: string): boolean =>
  t.startsWith('text/') || (ALLOWED_MEDIA_TYPES as readonly string[]).includes(t);

export interface ChatEventPayload {
  sessionId: string;
  event: SessionEvent;
}

export interface SendResult {
  ok: boolean;
  error?: string;
  queued?: boolean;
  /** Present when Vodo auto-routed this message to a model. */
  routed?: { provider: string; model: string; rationale: string };
}

export interface PreviewBoundsDto {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PermissionPrompt {
  requestId: string;
  sessionId: string;
  agentName: string;
  name: string;
  args: unknown;
}

export interface CheckinPayload {
  sessionId: string;
  prompt: string;
  reasons: string[];
}

export interface TermData {
  id: number;
  data: string;
}

export interface TermExit {
  id: number;
  exitCode: number;
}

export interface WatchEvent {
  kind: 'add' | 'change' | 'unlink' | 'unlinkDir' | 'ready';
  /** Relative to the watched root, forward slashes. Empty for 'ready'. */
  path: string;
  /** True while the initial scan is populating the baseline tree. */
  initial: boolean;
}

export interface WatchGitStatus {
  git: boolean;
  /** Uncommitted changes vs HEAD (git status --porcelain), path → state. */
  states: Record<string, 'added' | 'modified' | 'deleted'>;
}

export interface UpdateEvent {
  state: 'none' | 'available' | 'downloaded' | 'error' | 'dev';
  version?: string;
  message?: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  /** Optional project folder (ties into scaffold/preview). */
  dir?: string;
  createdAt: number;
  /**
   * Smart context (window-as-buffer): requests carry a map digest + recent
   * turns instead of replaying the whole conversation. Opt-in per project.
   */
  assemble?: boolean;
}

/** A memory-map node as shown in the Memory view. */
export interface MapNodeDto {
  id: number;
  type: string;
  title: string;
  body: string;
  status: string;
  tags: string;
  updatedAt: number;
  srcSession?: string;
  srcTurn?: number;
  links: Array<{ rel: string; type: string; title: string }>;
}

export interface ChatSessionMeta {
  id: string;
  projectId: string;
  agentId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Folder attached to THIS chat (overrides the project folder): workspace
   *  tools + look_at_image work here — photo cataloging, code review, etc. */
  dir?: string;
}

export interface ProjectsData {
  projects: ProjectInfo[];
  sessions: ChatSessionMeta[];
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface UsageData {
  allTime: UsageTotals;
  perProject: Record<string, UsageTotals>;
}

export interface XaiOauthEvent {
  state: 'connected' | 'signed_out' | 'error';
  message?: string;
}

/**
 * A mission: a background objective Vodo pursues in its own isolated agent
 * session — concurrent with every chat, so interactive coding is never blocked.
 * One-shot ("run once") or looping (every N minutes, context carried between
 * runs while the app is open).
 */
export interface Mission {
  id: string;
  title: string;
  objective: string;
  /** Optional project whose folder the mission gets workspace tools for. */
  projectId?: string;
  /** Repeat every N minutes; absent = run once. */
  intervalMinutes?: number;
  /** Headless runs: approve this mission's tool calls without prompting. */
  autoApprove: boolean;
  status: 'idle' | 'running' | 'paused' | 'done' | 'failed';
  createdAt: number;
  lastRunAt?: number;
  /** Final assistant text of the most recent run (trimmed). */
  lastResult?: string;
  lastError?: string;
  runCount: number;
}

export interface MissionCreateInput {
  title: string;
  objective: string;
  projectId?: string;
  intervalMinutes?: number;
  autoApprove?: boolean;
  runNow?: boolean;
}

export type MissionAction = 'run' | 'pause' | 'resume' | 'delete';

export interface TelegramInfo {
  /** Bot token saved in the secret store. */
  configured: boolean;
  enabled: boolean;
  botUsername?: string;
  polling: boolean;
  paired: Array<{ id: number; name?: string }>;
  lastError?: string;
}

export interface VoApi {
  getConfig(): Promise<AppConfig>;
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>;
  setSecret(provider: string, value: string): Promise<Record<string, string | null>>;
  secretStatus(): Promise<Record<string, string | null>>;
  listModels(provider: string): Promise<ModelInfo[]>;
  chatSend(
    sessionId: string,
    parts: UserPart[],
    override?: { provider?: string; model?: string },
  ): Promise<SendResult>;
  chatInject(sessionId: string, parts: UserPart[]): Promise<SendResult>;
  chatStop(sessionId: string): Promise<void>;
  chatReset(sessionId: string): Promise<void>;
  chatCompact(sessionId: string): Promise<{ ok: boolean; summary?: string; error?: string }>;
  onChatEvent(cb: (payload: ChatEventPayload) => void): () => void;
  mcpList(): Promise<McpServerStatus[]>;
  mcpConnect(name: string): Promise<McpServerStatus>;
  mcpDisconnect(name: string): Promise<void>;
  onPermissionRequest(cb: (prompt: PermissionPrompt) => void): () => void;
  permissionRespond(requestId: string, decision: 'allow' | 'deny'): Promise<void>;
  scaffoldPickDir(): Promise<string | null>;
  scaffoldDetect(dir: string): Promise<Detection>;
  scaffoldGenerate(dir: string, answers: ProjectAnswers, force?: boolean): Promise<InjectResult>;
  registryCatalog(): Promise<CatalogInfo>;
  registrySuggest(
    text: string,
    opts?: { needsTools?: boolean; needsVision?: boolean; wantsThinking?: boolean },
  ): Promise<RankedModel[]>;
  previewOpen(url: string): Promise<{ ok: boolean; error?: string }>;
  previewOpenFile(path: string): Promise<{ ok: boolean; error?: string }>;
  previewDetect(dir: string): Promise<
    | { kind: 'url'; url: string }
    | { kind: 'dev'; command: string; port: number }
    | { kind: 'file'; path: string }
    | { kind: 'none' }
  >;
  /** Start the project's dev server and wait until it responds. */
  previewStartDev(dir: string): Promise<{ ok: boolean; url?: string; error?: string; log?: string }>;
  previewClose(): Promise<void>;
  previewHide(): Promise<void>;
  previewReload(): Promise<void>;
  previewBounds(bounds: PreviewBoundsDto): Promise<void>;
  previewState(): Promise<{ url: string | null }>;
  onCheckin(cb: (payload: CheckinPayload) => void): () => void;
  mcpSearch(query: string): Promise<McpRegistryEntry[]>;
  mcpAdd(config: McpServerConfig): Promise<McpServerStatus>;
  onAdvisorSuggest(cb: (suggestion: McpSuggestion) => void): () => void;
  advisorDismiss(topic: string): Promise<void>;
  termCreate(opts: { cwd?: string; cols?: number; rows?: number }): Promise<{
    id: number;
    shell: string;
  }>;
  termInput(id: number, data: string): Promise<void>;
  termResize(id: number, cols: number, rows: number): Promise<void>;
  termKill(id: number): Promise<void>;
  onTermData(cb: (payload: TermData) => void): () => void;
  onTermExit(cb: (payload: TermExit) => void): () => void;
  watchStart(dir: string): Promise<{ ok: boolean; error?: string }>;
  watchStop(): Promise<void>;
  onWatchEvent(cb: (event: WatchEvent) => void): () => void;
  onWatchGit(cb: (status: WatchGitStatus) => void): () => void;
  watchReadFile(relPath: string): Promise<{
    ok: boolean;
    content?: string;
    truncated?: boolean;
    error?: string;
  }>;
  watchReadBaseline(relPath: string): Promise<{ ok: boolean; content?: string }>;
  projectsList(): Promise<ProjectsData>;
  projectCreate(name: string, dir?: string): Promise<ProjectInfo>;
  projectCreateIn(
    parentDir: string,
    name: string,
  ): Promise<{ ok: boolean; project?: ProjectInfo; error?: string }>;
  projectDelete(id: string): Promise<void>;
  /** Attach (or change) a project's folder — enables builder mode + ws tools. */
  projectSetDir(id: string, dir: string): Promise<{ ok: boolean; error?: string }>;
  sessionCreate(projectId: string, agentId?: string): Promise<ChatSessionMeta>;
  sessionOpen(sessionId: string): Promise<{ meta: ChatSessionMeta; history: HarnessMessage[] }>;
  sessionDelete(sessionId: string): Promise<void>;
  sessionSetAgent(sessionId: string, agentId: string): Promise<void>;
  sessionSetDir(sessionId: string, dir: string | null): Promise<void>;
  onProjectsChanged(cb: (data: ProjectsData) => void): () => void;
  usageGet(): Promise<UsageData>;
  onUsageChanged(cb: (data: UsageData) => void): () => void;
  xaiOauthStatus(): Promise<{ connected: boolean; expiresAt?: number }>;
  xaiOauthBegin(): Promise<{
    ok: boolean;
    userCode?: string;
    verificationUri?: string;
    error?: string;
  }>;
  xaiOauthSignOut(): Promise<void>;
  onXaiOauth(cb: (event: XaiOauthEvent) => void): () => void;
  appVersion(): Promise<string>;
  updateCheck(): Promise<UpdateEvent>;
  updateInstall(): Promise<void>;
  onUpdateEvent(cb: (event: UpdateEvent) => void): () => void;
  voiceSetupWhisper(): Promise<{
    ok: boolean;
    binaryPath?: string;
    modelPath?: string;
    error?: string;
  }>;
  openExternal(url: string): Promise<void>;
  voiceTranscribe(wav: ArrayBuffer): Promise<{ ok: boolean; text?: string; error?: string }>;
  voiceSpeak(
    text: string,
  ): Promise<
    | { ok: true; output: { kind: 'native' } | { kind: 'audio'; data: ArrayBuffer; mimeType: string } }
    | { ok: false; error: string }
  >;
  voiceStopSpeak(): Promise<void>;
  missionsList(): Promise<Mission[]>;
  missionCreate(input: MissionCreateInput): Promise<Mission>;
  missionControl(id: string, action: MissionAction): Promise<void>;
  onMissionsChanged(cb: (missions: Mission[]) => void): () => void;
  telegramInfo(): Promise<TelegramInfo>;
  telegramPairCode(): Promise<{ code: string; expiresInSec: number }>;
  telegramUnpair(chatId: number): Promise<void>;
  onTelegramChanged(cb: (info: TelegramInfo) => void): () => void;
  projectSetAssemble(projectId: string, enabled: boolean): Promise<void>;
  memStats(projectId: string): Promise<{ nodes: number; archiveTurns: number }>;
  memMapList(
    projectId: string,
    opts?: { query?: string; type?: string; includeInactive?: boolean },
  ): Promise<MapNodeDto[]>;
  memMapSetStatus(projectId: string, nodeId: number, status: string): Promise<void>;
  memMapDelete(projectId: string, nodeId: number): Promise<void>;
  /** Read a generated/project image as a data URL for inline display. */
  imageRead(path: string): Promise<{ ok: boolean; dataUrl?: string; error?: string }>;
}

export interface CatalogInfo {
  hardware: HardwareProfile;
  records: Array<ModelRecord & { fit: FitVerdict }>;
}

export const IPC = {
  getConfig: 'config:get',
  setConfig: 'config:set',
  setSecret: 'secrets:set',
  secretStatus: 'secrets:status',
  listModels: 'models:list',
  chatSend: 'chat:send',
  chatStop: 'chat:stop',
  chatReset: 'chat:reset',
  chatCompact: 'chat:compact',
  chatEvent: 'chat:event',
  mcpList: 'mcp:list',
  mcpConnect: 'mcp:connect',
  mcpDisconnect: 'mcp:disconnect',
  permissionRequest: 'permission:request',
  permissionRespond: 'permission:respond',
  scaffoldPickDir: 'scaffold:pickDir',
  scaffoldDetect: 'scaffold:detect',
  scaffoldGenerate: 'scaffold:generate',
  registryCatalog: 'registry:catalog',
  registrySuggest: 'registry:suggest',
  chatInject: 'chat:inject',
  previewOpen: 'preview:open',
  previewOpenFile: 'preview:openFile',
  previewDetect: 'preview:detect',
  previewStartDev: 'preview:startDev',
  previewClose: 'preview:close',
  previewHide: 'preview:hide',
  previewReload: 'preview:reload',
  previewBounds: 'preview:bounds',
  previewState: 'preview:state',
  voiceTranscribe: 'voice:transcribe',
  voiceSpeak: 'voice:speak',
  voiceStopSpeak: 'voice:stopSpeak',
  checkin: 'checkin:show',
  mcpSearch: 'mcp:search',
  mcpAdd: 'mcp:add',
  advisorSuggest: 'advisor:suggest',
  advisorDismiss: 'advisor:dismiss',
  termCreate: 'term:create',
  termInput: 'term:input',
  termResize: 'term:resize',
  termKill: 'term:kill',
  termData: 'term:data',
  termExit: 'term:exit',
  watchStart: 'watch:start',
  watchStop: 'watch:stop',
  watchEvent: 'watch:event',
  watchGit: 'watch:git',
  watchReadFile: 'watch:readFile',
  watchReadBaseline: 'watch:readBaseline',
  projectsList: 'projects:list',
  projectCreate: 'projects:create',
  projectCreateIn: 'projects:createIn',
  projectDelete: 'projects:delete',
  projectSetDir: 'projects:setDir',
  sessionCreate: 'sessions:create',
  sessionOpen: 'sessions:open',
  sessionDelete: 'sessions:delete',
  sessionSetAgent: 'sessions:setAgent',
  sessionSetDir: 'sessions:setDir',
  projectsChanged: 'projects:changed',
  usageGet: 'usage:get',
  usageChanged: 'usage:changed',
  xaiOauthStatus: 'xaiOauth:status',
  xaiOauthBegin: 'xaiOauth:begin',
  xaiOauthSignOut: 'xaiOauth:signOut',
  xaiOauthEvent: 'xaiOauth:event',
  appVersion: 'app:version',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  updateEvent: 'update:event',
  voiceSetupWhisper: 'voice:setupWhisper',
  openExternal: 'shell:openExternal',
  missionsList: 'missions:list',
  missionCreate: 'missions:create',
  missionControl: 'missions:control',
  missionsChanged: 'missions:changed',
  telegramInfo: 'telegram:info',
  telegramPairCode: 'telegram:pairCode',
  telegramUnpair: 'telegram:unpair',
  telegramChanged: 'telegram:changed',
  projectSetAssemble: 'projects:setAssemble',
  memStats: 'mem:stats',
  memMapList: 'mem:mapList',
  memMapSetStatus: 'mem:mapSetStatus',
  memMapDelete: 'mem:mapDelete',
  imageRead: 'image:read',
} as const;
