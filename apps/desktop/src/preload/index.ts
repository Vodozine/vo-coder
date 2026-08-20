import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { clampUiZoom, IPC } from '../shared/ipc-contract';
import type {
  AppConfig,
  ChatEventPayload,
  CheckinPayload,
  GoogleOauthEvent,
  LifeProgressDto,
  McpOauthEvent,
  PermissionPrompt,
  RemoteSettings,
  TermData,
  TermExit,
  VoApi,
} from '../shared/ipc-contract';
import {
  currentLinkState,
  localBridge,
  onLinkState,
  remoteBridge,
  setHostAsk,
  type Bridge,
} from './bridge';

/**
 * Which end of the wire this window is, asked synchronously because
 * exposeInMainWorld below cannot wait: the API object has to exist, whole,
 * before the page runs its first line.
 */
const boot = ipcRenderer.sendSync(IPC.remoteBootstrap) as {
  remote: RemoteSettings;
  edition: string;
};

/**
 * A window opened deliberately on the other side carries --vo-role, and it
 * wins over the stored config — otherwise every window in one app reads the
 * same config and lands on the same side.
 */
const forced = process.argv.find((a) => a.startsWith('--vo-role='))?.split('=')[1];
const remote =
  forced === 'local'
    ? { ...boot.remote, role: 'local' as const }
    : forced === 'client'
      ? { ...boot.remote, role: 'client' as const }
      : boot.remote;

/**
 * Accept "192.168.1.20:7420" or any of the four schemes.
 *
 * A bare address means the secure one: the host serves TLS unless it has been
 * deliberately turned off, and an address typed without a scheme must not
 * quietly downgrade the link. An explicit ws:// or http:// is honoured though,
 * because that is the only way to reach a host running plain for a phone —
 * silently upgrading it would fail the handshake with nothing on screen to say
 * that the scheme the user typed was ignored.
 */
function wsUrl(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('wss://')) return t;
  if (t.startsWith('ws://')) return t;
  if (t.startsWith('https://')) return `wss://${t.slice(8)}`;
  if (t.startsWith('http://')) return `ws://${t.slice(7)}`;
  return `wss://${t}`;
}

/**
 * How window.vo reaches the main process: Electron IPC normally, a socket to
 * another machine when this window is a front end. Written once against the
 * Bridge interface so only the thing underneath swaps — a second copy of the
 * API would drift, and the first method somebody added to one and not the
 * other would be dead in remote mode only.
 */
const bridge: Bridge =
  remote.role === 'client' && remote.connect.url
    ? remoteBridge(wsUrl(remote.connect.url), remote.connect.token, boot.edition)
    : localBridge();

function subscribe<T>(channel: string) {
  return (cb: (payload: T) => void) => bridge.on(channel, (payload) => cb(payload as T));
}

const api: VoApi = {
  remoteInfo: () => bridge.invoke(IPC.remoteInfo),
  onRemoteChanged: subscribe(IPC.remoteChanged),
  remoteSettingsGet: () => bridge.invoke(IPC.remoteSettingsGet),
  remoteSettingsSet: (patch) => bridge.invoke(IPC.remoteSettingsSet, patch),
  remoteApplyRole: (patch) => bridge.invoke(IPC.remoteApplyRole, patch),
  // Answered without a round trip: it is a fact about this window, and the
  // renderer asks it while deciding what to draw.
  isRemote: () => remote.role === 'client' && !!remote.connect.url,
  setHostPicker: (fn) => setHostAsk(fn),
  getConfig: () => bridge.invoke(IPC.getConfig),
  setConfig: (patch: Partial<AppConfig>) => bridge.invoke(IPC.setConfig, patch),
  // Zoom is per-WebContents, so setting it from the preload's isolated world
  // scales the whole page. Clamp here too: setZoomFactor(0) throws, and
  // config.json is hand-editable.
  setZoom: (factor: number) => {
    webFrame.setZoomFactor(clampUiZoom(factor));
  },
  setSecret: (provider, value) => bridge.invoke(IPC.setSecret, provider, value),
  secretStatus: () => bridge.invoke(IPC.secretStatus),
  listModels: (provider) => bridge.invoke(IPC.listModels, provider),
  modelWarm: (provider, model) => bridge.invoke(IPC.modelWarm, provider, model),
  groupList: () => bridge.invoke(IPC.groupList),
  groupEnd: (groupId) => bridge.invoke(IPC.groupEnd, groupId),
  chatSend: (sessionId, parts, override, opts) =>
    bridge.invoke(IPC.chatSend, sessionId, parts, override, opts),
  chatStop: (sessionId) => bridge.invoke(IPC.chatStop, sessionId),
  chatReset: (sessionId) => bridge.invoke(IPC.chatReset, sessionId),
  chatCompact: (sessionId) => bridge.invoke(IPC.chatCompact, sessionId),
  onChatEvent: (cb) => {
    const listener = (_event: unknown, payload: ChatEventPayload) => cb(payload);
    ipcRenderer.on(IPC.chatEvent, listener);
    return () => {
      ipcRenderer.removeListener(IPC.chatEvent, listener);
    };
  },
  mcpList: () => bridge.invoke(IPC.mcpList),
  mcpConnect: (name) => bridge.invoke(IPC.mcpConnect, name),
  mcpDisconnect: (name) => bridge.invoke(IPC.mcpDisconnect, name),
  onPermissionRequest: (cb) => {
    const listener = (_event: unknown, prompt: PermissionPrompt) => cb(prompt);
    ipcRenderer.on(IPC.permissionRequest, listener);
    return () => {
      ipcRenderer.removeListener(IPC.permissionRequest, listener);
    };
  },
  permissionRespond: (requestId, decision) =>
    bridge.invoke(IPC.permissionRespond, requestId, decision),
  hostFsList: (path) => bridge.invoke(IPC.hostFsList, path),
  hostFsMkdir: (parent, name) => bridge.invoke(IPC.hostFsMkdir, parent, name),
  openWindowAs: (role) => bridge.invoke(IPC.openWindowAs, role),
  linkState: () => currentLinkState(),
  onLinkState: (cb) => onLinkState(cb),
  hostFileUpload: (name, bytes) => bridge.invoke(IPC.hostFileUpload, name, bytes),
  oauthLoopback: (authUrlTemplate) => bridge.invoke(IPC.oauthLoopback, authUrlTemplate),
  saveToThisComputer: (url, suggestedName) =>
    bridge.invoke(IPC.saveToThisComputer, url, suggestedName),
  scaffoldPickDir: () => bridge.invoke(IPC.scaffoldPickDir),
  scaffoldDetect: (dir) => bridge.invoke(IPC.scaffoldDetect, dir),
  scaffoldGenerate: (dir, answers, force) =>
    bridge.invoke(IPC.scaffoldGenerate, dir, answers, force),
  registryCatalog: () => bridge.invoke(IPC.registryCatalog),
  registrySuggest: (text, opts) => bridge.invoke(IPC.registrySuggest, text, opts),
  chatInject: (sessionId, parts) => bridge.invoke(IPC.chatInject, sessionId, parts),
  chatCancelInject: (sessionId, injectionId) =>
    bridge.invoke(IPC.chatCancelInject, sessionId, injectionId),
  previewOpen: (url) => bridge.invoke(IPC.previewOpen, url),
  previewOpenFile: (path) => bridge.invoke(IPC.previewOpenFile, path),
  previewDetect: (dir) => bridge.invoke(IPC.previewDetect, dir),
  previewStartDev: (dir) => bridge.invoke(IPC.previewStartDev, dir),
  previewStopDev: () => bridge.invoke(IPC.previewStopDev),
  previewClose: () => bridge.invoke(IPC.previewClose),
  previewHide: () => bridge.invoke(IPC.previewHide),
  previewReload: () => bridge.invoke(IPC.previewReload),
  previewBounds: (bounds) => bridge.invoke(IPC.previewBounds, bounds),
  previewState: () => bridge.invoke(IPC.previewState),
  onCheckin: subscribe<CheckinPayload>(IPC.checkin),
  mcpSearch: (query) => bridge.invoke(IPC.mcpSearch, query),
  mcpAdd: (cfg) => bridge.invoke(IPC.mcpAdd, cfg),
  mcpOauthBegin: (serverName) => bridge.invoke(IPC.mcpOauthBegin, serverName),
  mcpOauthSignOut: (serverName) => bridge.invoke(IPC.mcpOauthSignOut, serverName),
  onMcpOauth: subscribe<McpOauthEvent>(IPC.mcpOauthEvent),
  skillsList: () => bridge.invoke(IPC.skillsList),
  skillsImport: (kind) => bridge.invoke(IPC.skillsImport, kind),
  skillsImportUrl: (url) => bridge.invoke(IPC.skillsImportUrl, url),
  skillsRemove: (slug) => bridge.invoke(IPC.skillsRemove, slug),
  onAdvisorSuggest: subscribe(IPC.advisorSuggest),
  advisorDismiss: (topic) => bridge.invoke(IPC.advisorDismiss, topic),
  termCreate: (opts) => bridge.invoke(IPC.termCreate, opts),
  termInput: (id, data) => bridge.invoke(IPC.termInput, id, data),
  termResize: (id, cols, rows) => bridge.invoke(IPC.termResize, id, cols, rows),
  termKill: (id) => bridge.invoke(IPC.termKill, id),
  onTermData: subscribe<TermData>(IPC.termData),
  onTermExit: subscribe<TermExit>(IPC.termExit),
  watchStart: (dir) => bridge.invoke(IPC.watchStart, dir),
  watchStop: () => bridge.invoke(IPC.watchStop),
  onWatchEvent: subscribe(IPC.watchEvent),
  onWatchGit: subscribe(IPC.watchGit),
  watchReadFile: (relPath) => bridge.invoke(IPC.watchReadFile, relPath),
  watchWriteFile: (relPath, content) => bridge.invoke(IPC.watchWriteFile, relPath, content),
  watchReadBaseline: (relPath) => bridge.invoke(IPC.watchReadBaseline, relPath),
  projectsList: () => bridge.invoke(IPC.projectsList),
  projectCreate: (name, dir) => bridge.invoke(IPC.projectCreate, name, dir),
  projectCreateIn: (parentDir, name) => bridge.invoke(IPC.projectCreateIn, parentDir, name),
  projectOpenExisting: (dir) => bridge.invoke(IPC.projectOpenExisting, dir),
  projectDelete: (id) => bridge.invoke(IPC.projectDelete, id),
  projectSetDir: (id, dir) => bridge.invoke(IPC.projectSetDir, id, dir),
  sessionCreate: (projectId, agentId) => bridge.invoke(IPC.sessionCreate, projectId, agentId),
  sessionOpen: (sessionId) => bridge.invoke(IPC.sessionOpen, sessionId),
  sessionDelete: (sessionId) => bridge.invoke(IPC.sessionDelete, sessionId),
  sessionRename: (sessionId, title) => bridge.invoke(IPC.sessionRename, sessionId, title),
  groupDelete: (groupId) => bridge.invoke(IPC.groupDelete, groupId),
  sessionSetAgent: (sessionId, agentId) =>
    bridge.invoke(IPC.sessionSetAgent, sessionId, agentId),
  sessionSetDir: (sessionId, dir) => bridge.invoke(IPC.sessionSetDir, sessionId, dir),
  onProjectsChanged: subscribe(IPC.projectsChanged),
  onPreviewShowRequested: subscribe(IPC.previewShowRequested),
  usageGet: () => bridge.invoke(IPC.usageGet),
  onUsageChanged: subscribe(IPC.usageChanged),
  xaiOauthStatus: () => bridge.invoke(IPC.xaiOauthStatus),
  xaiOauthBegin: () => bridge.invoke(IPC.xaiOauthBegin),
  xaiOauthSignOut: () => bridge.invoke(IPC.xaiOauthSignOut),
  onXaiOauth: subscribe(IPC.xaiOauthEvent),
  onConfigChanged: subscribe<AppConfig>(IPC.configChanged),
  googleOauthStatus: () => bridge.invoke(IPC.googleOauthStatus),
  googleOauthBegin: () => bridge.invoke(IPC.googleOauthBegin),
  googleOauthSignOut: () => bridge.invoke(IPC.googleOauthSignOut),
  onGoogleOauth: subscribe<GoogleOauthEvent>(IPC.googleOauthEvent),
  appVersion: () => bridge.invoke(IPC.appVersion),
  updateCheck: () => bridge.invoke(IPC.updateCheck),
  updateInstall: () => bridge.invoke(IPC.updateInstall),
  onUpdateEvent: subscribe(IPC.updateEvent),
  voiceSetupWhisper: () => bridge.invoke(IPC.voiceSetupWhisper),
  claudeCliCheck: () => bridge.invoke(IPC.claudeCliCheck),
  codexCliCheck: () => bridge.invoke(IPC.codexCliCheck),
  openExternal: (url) => bridge.invoke(IPC.openExternal, url),
  voiceTranscribe: (wav) => bridge.invoke(IPC.voiceTranscribe, wav),
  voiceSynthesize: (text) => bridge.invoke(IPC.voiceSynthesize, text),
  voiceSpeak: (text) => bridge.invoke(IPC.voiceSpeak, text),
  voiceStopSpeak: () => bridge.invoke(IPC.voiceStopSpeak),
  voiceCompatCatalog: (baseUrl) => bridge.invoke(IPC.voiceCompatCatalog, baseUrl),
  voiceSystemVoices: () => bridge.invoke(IPC.voiceSystemVoices),
  missionsList: () => bridge.invoke(IPC.missionsList),
  missionCreate: (input) => bridge.invoke(IPC.missionCreate, input),
  missionControl: (id, action) => bridge.invoke(IPC.missionControl, id, action),
  onMissionsChanged: subscribe(IPC.missionsChanged),
  telegramInfo: () => bridge.invoke(IPC.telegramInfo),
  telegramPairCode: () => bridge.invoke(IPC.telegramPairCode),
  telegramUnpair: (chatId) => bridge.invoke(IPC.telegramUnpair, chatId),
  onTelegramChanged: subscribe(IPC.telegramChanged),
  projectSetAssemble: (projectId, enabled) =>
    bridge.invoke(IPC.projectSetAssemble, projectId, enabled),
  memStats: (projectId) => bridge.invoke(IPC.memStats, projectId),
  memMapList: (projectId, opts) => bridge.invoke(IPC.memMapList, projectId, opts),
  memMapSetStatus: (projectId, nodeId, status) =>
    bridge.invoke(IPC.memMapSetStatus, projectId, nodeId, status),
  memMapDelete: (projectId, nodeId) => bridge.invoke(IPC.memMapDelete, projectId, nodeId),
  memMapGraph: (projectId, opts) => bridge.invoke(IPC.memMapGraph, projectId, opts),
  lifePickFile: () => bridge.invoke(IPC.lifePickFile),
  lifeScan: (path) => bridge.invoke(IPC.lifeScan, path),
  lifeStart: (path, opts) => bridge.invoke(IPC.lifeStart, path, opts),
  lifeCancel: () => bridge.invoke(IPC.lifeCancel),
  lifeState: () => bridge.invoke(IPC.lifeState),
  lifeNotes: (opts) => bridge.invoke(IPC.lifeNotes, opts),
  lifeNoteStatus: (id, status) => bridge.invoke(IPC.lifeNoteStatus, id, status),
  lifeNoteDelete: (id) => bridge.invoke(IPC.lifeNoteDelete, id),
  lifeBatchDelete: (id) => bridge.invoke(IPC.lifeBatchDelete, id),
  onLifeProgress: subscribe<LifeProgressDto>(IPC.lifeProgress),
  imageRead: (path) => bridge.invoke(IPC.imageRead, path),
  videoRead: (path) => bridge.invoke(IPC.videoRead, path),
  globalRulesRead: () => bridge.invoke(IPC.globalRulesRead),
  globalRulesWrite: (text) => bridge.invoke(IPC.globalRulesWrite, text),
};

contextBridge.exposeInMainWorld('vo', api);
