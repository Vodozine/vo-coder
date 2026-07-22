/**
 * Single source of truth for the main ↔ renderer boundary. The renderer is a
 * pure view: it only ever talks to main through `window.vo` (VoApi), and main
 * pushes `SessionEvent`s back verbatim — one event vocabulary end to end.
 */
import type { AgentSpec, ModelInfo, ProviderId, UserPart } from '@vo-coder/providers';
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
  /** Extended thinking for the Default agent (per-agent specs set their own). */
  thinkingDefault: boolean;
  voice: VoiceSettings;
}

export interface VoiceSettings {
  stt: 'openai' | 'whisper-local';
  /** Model for the OpenAI-compatible transcription endpoint. */
  sttModel: string;
  whisperPath: string;
  whisperModel: string;
  tts: 'openai' | 'system' | 'none';
  openaiVoice: string;
}

export const DEFAULT_CONFIG: AppConfig = {
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet-5',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  lmstudioBaseUrl: 'http://127.0.0.1:1234/v1',
  systemPrompt:
    'You are Vo-Coder, a capable engineering assistant. Be direct, concrete, and honest about uncertainty.',
  agents: [],
  mcpServers: [],
  visionModel: null,
  thinkingDefault: false,
  voice: {
    stt: 'openai',
    sttModel: 'whisper-1',
    whisperPath: '',
    whisperModel: '',
    tts: 'system',
    openaiVoice: 'alloy',
  },
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
  appVersion: 'app:version',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  updateEvent: 'update:event',
  voiceSetupWhisper: 'voice:setupWhisper',
  openExternal: 'shell:openExternal',
} as const;
