import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-contract';
import type {
  AppConfig,
  ChatEventPayload,
  CheckinPayload,
  PermissionPrompt,
  TermData,
  TermExit,
  VoApi,
} from '../shared/ipc-contract';

function subscribe<T>(channel: string) {
  return (cb: (payload: T) => void) => {
    const listener = (_event: unknown, payload: T) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  };
}

const api: VoApi = {
  getConfig: () => ipcRenderer.invoke(IPC.getConfig),
  setConfig: (patch: Partial<AppConfig>) => ipcRenderer.invoke(IPC.setConfig, patch),
  setSecret: (provider, value) => ipcRenderer.invoke(IPC.setSecret, provider, value),
  secretStatus: () => ipcRenderer.invoke(IPC.secretStatus),
  listModels: (provider) => ipcRenderer.invoke(IPC.listModels, provider),
  chatSend: (sessionId, parts, override) =>
    ipcRenderer.invoke(IPC.chatSend, sessionId, parts, override),
  chatStop: (sessionId) => ipcRenderer.invoke(IPC.chatStop, sessionId),
  chatReset: (sessionId) => ipcRenderer.invoke(IPC.chatReset, sessionId),
  onChatEvent: (cb) => {
    const listener = (_event: unknown, payload: ChatEventPayload) => cb(payload);
    ipcRenderer.on(IPC.chatEvent, listener);
    return () => {
      ipcRenderer.removeListener(IPC.chatEvent, listener);
    };
  },
  mcpList: () => ipcRenderer.invoke(IPC.mcpList),
  mcpConnect: (name) => ipcRenderer.invoke(IPC.mcpConnect, name),
  mcpDisconnect: (name) => ipcRenderer.invoke(IPC.mcpDisconnect, name),
  onPermissionRequest: (cb) => {
    const listener = (_event: unknown, prompt: PermissionPrompt) => cb(prompt);
    ipcRenderer.on(IPC.permissionRequest, listener);
    return () => {
      ipcRenderer.removeListener(IPC.permissionRequest, listener);
    };
  },
  permissionRespond: (requestId, decision) =>
    ipcRenderer.invoke(IPC.permissionRespond, requestId, decision),
  scaffoldPickDir: () => ipcRenderer.invoke(IPC.scaffoldPickDir),
  scaffoldDetect: (dir) => ipcRenderer.invoke(IPC.scaffoldDetect, dir),
  scaffoldGenerate: (dir, answers, force) =>
    ipcRenderer.invoke(IPC.scaffoldGenerate, dir, answers, force),
  registryCatalog: () => ipcRenderer.invoke(IPC.registryCatalog),
  registrySuggest: (text, opts) => ipcRenderer.invoke(IPC.registrySuggest, text, opts),
  chatInject: (sessionId, parts) => ipcRenderer.invoke(IPC.chatInject, sessionId, parts),
  previewOpen: (url) => ipcRenderer.invoke(IPC.previewOpen, url),
  previewOpenFile: (path) => ipcRenderer.invoke(IPC.previewOpenFile, path),
  previewDetect: (dir) => ipcRenderer.invoke(IPC.previewDetect, dir),
  previewClose: () => ipcRenderer.invoke(IPC.previewClose),
  previewHide: () => ipcRenderer.invoke(IPC.previewHide),
  previewReload: () => ipcRenderer.invoke(IPC.previewReload),
  previewBounds: (bounds) => ipcRenderer.invoke(IPC.previewBounds, bounds),
  previewState: () => ipcRenderer.invoke(IPC.previewState),
  onCheckin: subscribe<CheckinPayload>(IPC.checkin),
  mcpSearch: (query) => ipcRenderer.invoke(IPC.mcpSearch, query),
  mcpAdd: (cfg) => ipcRenderer.invoke(IPC.mcpAdd, cfg),
  onAdvisorSuggest: subscribe(IPC.advisorSuggest),
  advisorDismiss: (topic) => ipcRenderer.invoke(IPC.advisorDismiss, topic),
  termCreate: (opts) => ipcRenderer.invoke(IPC.termCreate, opts),
  termInput: (id, data) => ipcRenderer.invoke(IPC.termInput, id, data),
  termResize: (id, cols, rows) => ipcRenderer.invoke(IPC.termResize, id, cols, rows),
  termKill: (id) => ipcRenderer.invoke(IPC.termKill, id),
  onTermData: subscribe<TermData>(IPC.termData),
  onTermExit: subscribe<TermExit>(IPC.termExit),
  watchStart: (dir) => ipcRenderer.invoke(IPC.watchStart, dir),
  watchStop: () => ipcRenderer.invoke(IPC.watchStop),
  onWatchEvent: subscribe(IPC.watchEvent),
  onWatchGit: subscribe(IPC.watchGit),
  watchReadFile: (relPath) => ipcRenderer.invoke(IPC.watchReadFile, relPath),
  watchReadBaseline: (relPath) => ipcRenderer.invoke(IPC.watchReadBaseline, relPath),
  projectsList: () => ipcRenderer.invoke(IPC.projectsList),
  projectCreate: (name, dir) => ipcRenderer.invoke(IPC.projectCreate, name, dir),
  projectCreateIn: (parentDir, name) => ipcRenderer.invoke(IPC.projectCreateIn, parentDir, name),
  projectDelete: (id) => ipcRenderer.invoke(IPC.projectDelete, id),
  sessionCreate: (projectId, agentId) => ipcRenderer.invoke(IPC.sessionCreate, projectId, agentId),
  sessionOpen: (sessionId) => ipcRenderer.invoke(IPC.sessionOpen, sessionId),
  sessionDelete: (sessionId) => ipcRenderer.invoke(IPC.sessionDelete, sessionId),
  sessionSetAgent: (sessionId, agentId) =>
    ipcRenderer.invoke(IPC.sessionSetAgent, sessionId, agentId),
  onProjectsChanged: subscribe(IPC.projectsChanged),
  usageGet: () => ipcRenderer.invoke(IPC.usageGet),
  onUsageChanged: subscribe(IPC.usageChanged),
  xaiOauthStatus: () => ipcRenderer.invoke(IPC.xaiOauthStatus),
  xaiOauthBegin: () => ipcRenderer.invoke(IPC.xaiOauthBegin),
  xaiOauthSignOut: () => ipcRenderer.invoke(IPC.xaiOauthSignOut),
  onXaiOauth: subscribe(IPC.xaiOauthEvent),
  appVersion: () => ipcRenderer.invoke(IPC.appVersion),
  updateCheck: () => ipcRenderer.invoke(IPC.updateCheck),
  updateInstall: () => ipcRenderer.invoke(IPC.updateInstall),
  onUpdateEvent: subscribe(IPC.updateEvent),
  voiceSetupWhisper: () => ipcRenderer.invoke(IPC.voiceSetupWhisper),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  voiceTranscribe: (wav) => ipcRenderer.invoke(IPC.voiceTranscribe, wav),
  voiceSpeak: (text) => ipcRenderer.invoke(IPC.voiceSpeak, text),
  voiceStopSpeak: () => ipcRenderer.invoke(IPC.voiceStopSpeak),
  missionsList: () => ipcRenderer.invoke(IPC.missionsList),
  missionCreate: (input) => ipcRenderer.invoke(IPC.missionCreate, input),
  missionControl: (id, action) => ipcRenderer.invoke(IPC.missionControl, id, action),
  onMissionsChanged: subscribe(IPC.missionsChanged),
  telegramInfo: () => ipcRenderer.invoke(IPC.telegramInfo),
  telegramPairCode: () => ipcRenderer.invoke(IPC.telegramPairCode),
  telegramUnpair: (chatId) => ipcRenderer.invoke(IPC.telegramUnpair, chatId),
  onTelegramChanged: subscribe(IPC.telegramChanged),
};

contextBridge.exposeInMainWorld('vo', api);
