import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  EmotionalMiddleware,
  McpAdvisor,
  McpClientManager,
  searchMcpRegistry,
  type McpServerConfig,
  type RequestLogEntry,
} from '@vo-coder/core';
import type { UserPart } from '@vo-coder/providers';
import type { ProjectAnswers } from '@vo-coder/project-config';
import { detectProject, injectScaffold } from '@vo-coder/scaffold';
import {
  buildCatalog,
  checkFit,
  profileHardware,
  signalFromPrompt,
  suggest,
  type ModelRecord,
} from '@vo-coder/capability-registry';
import {
  IPC,
  isAllowedMediaType,
  MAX_ATTACHMENT_BYTES,
  type AppConfig,
} from '../shared/ipc-contract';
import { ConfigStore } from './config';
import { TerminalManager } from './terminal';
import { PreviewManager, type PreviewBounds } from './preview';
import { ProjectWatcher } from './watcher';
import { initUpdater } from './updater';
import { ProviderHub } from './providers';
import { SecretStore } from './secrets';
import { SessionManager } from './sessions';
import { VoiceHost } from './voice';
import { setupWhisper } from './whisper-setup';

function validateParts(parts: UserPart[]): string | null {
  for (const part of parts) {
    if (part.type === 'text') continue;
    if (!isAllowedMediaType(part.mediaType)) {
      return `Attachment type "${part.mediaType}" is not allowed.`;
    }
    // base64 → bytes is len * 3/4; close enough for a cap.
    if ((part.data.length * 3) / 4 > MAX_ATTACHMENT_BYTES) {
      const name = part.type === 'file' ? part.name : 'image';
      return `Attachment "${name}" exceeds the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit.`;
    }
  }
  return null;
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const config = new ConfigStore();
  const secrets = new SecretStore();
  const hub = new ProviderHub(config, secrets);
  const mcp = new McpClientManager();
  const sessions = new SessionManager({
    config,
    hub,
    mcp,
    send: (channel, payload) => getWindow()?.webContents.send(channel, payload),
  });

  // The bundled infra MCP registers itself as a first-class default server.
  // Its settings/MCP_SETTINGS.json live under userData via cwd. The entry is
  // refreshed every launch so path/packaging changes never go stale. Packaged
  // apps run it through Electron's own binary as Node (ELECTRON_RUN_AS_NODE).
  try {
    const infraPath = app.isPackaged
      ? join(process.resourcesPath, 'infra-mcp', 'index.js')
      : createRequire(import.meta.url).resolve('@vo-coder/infra-mcp');
    const infraEntry = {
      name: 'infra',
      command: app.isPackaged ? process.execPath : 'node',
      args: [infraPath],
      cwd: app.getPath('userData'),
      ...(app.isPackaged ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {}),
    };
    config.set({
      mcpServers: [...config.get().mcpServers.filter((s) => s.name !== 'infra'), infraEntry],
    });
  } catch (err) {
    console.warn('[infra-mcp] bundled server not resolvable (build packages first):', err);
  }

  // Reconnect configured MCP servers on startup (fire and forget; status shows in UI).
  for (const cfg of config.get().mcpServers) {
    void mcp.connect(cfg);
  }

  ipcMain.handle(IPC.getConfig, () => config.get());
  ipcMain.handle(IPC.setConfig, (_e, patch: Partial<AppConfig>) => config.set(patch));
  ipcMain.handle(IPC.setSecret, (_e, provider: string, value: string) => {
    secrets.set(provider, value);
    return secrets.status();
  });
  ipcMain.handle(IPC.secretStatus, () => secrets.status());
  ipcMain.handle(IPC.listModels, async (_e, providerId: string) => {
    const provider = hub.registry().get(providerId);
    if (!provider) {
      throw new Error(`Provider "${providerId}" is not configured — add its API key in Settings.`);
    }
    return provider.listModels();
  });

  // Emotional-signal middleware: a frustrated user spinning in circles burns
  // tokens — detect repeats/rapid-fire early, ask directly, persist the
  // request log so the memory spans sessions.
  const requestLogPath = join(app.getPath('userData'), 'request-log.json');
  let seedLog: RequestLogEntry[] = [];
  try {
    seedLog = JSON.parse(readFileSync(requestLogPath, 'utf8')) as RequestLogEntry[];
  } catch {
    /* first run */
  }
  const emotional = new EmotionalMiddleware({}, seedLog);
  // MCP awareness: repeated topic mentions with no covering server → suggest one.
  const advisor = new McpAdvisor();
  const observeMessage = (sessionId: string, parts: UserPart[]): void => {
    const text = parts
      .filter((p): p is Extract<UserPart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join(' ')
      .trim();
    if (!text) return;
    const checkin = emotional.observe(sessionId, text, Date.now());
    try {
      writeFileSync(requestLogPath, JSON.stringify(emotional.exportLog()), 'utf8');
    } catch {
      /* log persistence is best-effort */
    }
    if (checkin.triggered) {
      getWindow()?.webContents.send(IPC.checkin, {
        sessionId,
        prompt: checkin.prompt,
        reasons: checkin.reasons,
      });
    }
    const connected = mcp
      .list()
      .filter((s) => s.connected)
      .map((s) => s.name);
    const suggestion = advisor.observe(text, connected);
    if (suggestion) getWindow()?.webContents.send(IPC.advisorSuggest, suggestion);
  };

  ipcMain.handle(
    IPC.chatSend,
    (
      _e,
      sessionId: string,
      parts: UserPart[],
      override?: { provider?: string; model?: string },
    ) => {
      const invalid = validateParts(parts);
      if (invalid) return { ok: false, error: invalid };
      observeMessage(sessionId, parts);
      return sessions.send(sessionId, parts, override);
    },
  );
  ipcMain.handle(IPC.chatInject, (_e, sessionId: string, parts: UserPart[]) => {
    const invalid = validateParts(parts);
    if (invalid) return { ok: false, error: invalid };
    observeMessage(sessionId, parts);
    return sessions.inject(sessionId, parts);
  });
  ipcMain.handle(IPC.chatStop, (_e, sessionId: string) => sessions.stop(sessionId));
  ipcMain.handle(IPC.chatReset, (_e, sessionId: string) => sessions.reset(sessionId));

  ipcMain.handle(IPC.mcpList, () => mcp.list());
  ipcMain.handle(IPC.mcpConnect, async (_e, name: string) => {
    const cfg = config.get().mcpServers.find((s) => s.name === name);
    if (!cfg) throw new Error(`No MCP server named "${name}" in config.`);
    return mcp.connect(cfg);
  });
  ipcMain.handle(IPC.mcpDisconnect, (_e, name: string) => mcp.disconnect(name));
  ipcMain.handle(IPC.mcpSearch, (_e, query: string) => searchMcpRegistry(query));
  ipcMain.handle(IPC.mcpAdd, async (_e, cfg: McpServerConfig) => {
    const others = config.get().mcpServers.filter((s) => s.name !== cfg.name);
    config.set({ mcpServers: [...others, cfg] });
    return mcp.connect(cfg);
  });
  ipcMain.handle(IPC.advisorDismiss, (_e, topic: string) => advisor.dismiss(topic));
  ipcMain.handle(IPC.openExternal, (_e, url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url);
    return Promise.resolve();
  });

  // ---- integrated terminal (real PTY) ----
  const terminals = new TerminalManager((channel, payload) =>
    getWindow()?.webContents.send(channel, payload),
  );
  ipcMain.handle(IPC.termCreate, (_e, opts: { cwd?: string; cols?: number; rows?: number }) =>
    terminals.create(opts ?? {}),
  );
  ipcMain.handle(IPC.termInput, (_e, id: number, data: string) => terminals.input(id, data));
  ipcMain.handle(IPC.termResize, (_e, id: number, cols: number, rows: number) =>
    terminals.resize(id, cols, rows),
  );
  ipcMain.handle(IPC.termKill, (_e, id: number) => terminals.kill(id));
  app.on('will-quit', () => terminals.killAll());

  // ---- code preview watcher ----
  const projectWatcher = new ProjectWatcher((channel, payload) =>
    getWindow()?.webContents.send(channel, payload),
  );
  ipcMain.handle(IPC.watchStart, (_e, dir: string) => projectWatcher.start(dir));
  ipcMain.handle(IPC.watchStop, () => projectWatcher.stop());
  ipcMain.handle(IPC.watchReadFile, (_e, relPath: string) => projectWatcher.read(relPath));
  ipcMain.handle(IPC.watchReadBaseline, (_e, relPath: string) =>
    projectWatcher.readBaseline(relPath),
  );

  initUpdater(getWindow);
  ipcMain.handle(IPC.permissionRespond, (_e, requestId: string, decision: 'allow' | 'deny') =>
    sessions.respondPermission(requestId, decision),
  );

  ipcMain.handle(IPC.scaffoldPickDir, async () => {
    const win = getWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a project folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(IPC.scaffoldDetect, (_e, dir: string) => detectProject(dir));
  ipcMain.handle(IPC.scaffoldGenerate, (_e, dir: string, answers: ProjectAnswers, force?: boolean) =>
    injectScaffold(dir, answers, { force, generatedAt: new Date().toISOString() }),
  );

  // ---- capability registry (advisory-only in v1) ----
  let catalogPromise: Promise<ModelRecord[]> | null = null;
  const getCatalog = (): Promise<ModelRecord[]> =>
    (catalogPromise ??= (async () => {
      // Locally installed Ollama models join the catalog; seed entries with
      // matching ids keep their curated quality/footprint data on merge.
      const extra: ModelRecord[] = [];
      for (const providerId of ['ollama', 'lmstudio'] as const) {
        try {
          const provider = hub.registry().get(providerId);
          if (!provider) continue;
          const models = await Promise.race([
            provider.listModels(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`${providerId} timeout`)), 2500),
            ),
          ]);
          extra.push(
            ...models.map((m) => ({
              id: m.id,
              provider: providerId,
              displayName: `${m.id} (installed)`,
              tags: ['local'],
            })),
          );
        } catch {
          /* local server not running — catalog still works */
        }
      }
      return buildCatalog({ cacheDir: app.getPath('userData'), extra });
    })());

  ipcMain.handle(IPC.registryCatalog, async () => {
    const hardware = profileHardware();
    const records = (await getCatalog()).map((m) => ({ ...m, fit: checkFit(m, hardware) }));
    return { hardware, records };
  });
  ipcMain.handle(
    IPC.registrySuggest,
    async (
      _e,
      text: string,
      opts?: { needsTools?: boolean; needsVision?: boolean; wantsThinking?: boolean },
    ) => suggest(signalFromPrompt(text, opts), await getCatalog(), profileHardware()),
  );

  // ---- voice (PTT + live chat) ----
  const voice = new VoiceHost(config, secrets);
  ipcMain.handle(IPC.voiceTranscribe, async (_e, wav: ArrayBuffer) => {
    try {
      const text = await voice.transcribe(new Uint8Array(wav));
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle(IPC.voiceSpeak, async (_e, text: string) => {
    try {
      const output = await voice.speak(text);
      if (output.kind === 'audio') {
        return {
          ok: true,
          output: {
            kind: 'audio',
            data: output.data.buffer.slice(
              output.data.byteOffset,
              output.data.byteOffset + output.data.byteLength,
            ),
            mimeType: output.mimeType,
          },
        };
      }
      return { ok: true, output: { kind: 'native' } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle(IPC.voiceStopSpeak, () => voice.stopSpeak());
  ipcMain.handle(IPC.voiceSetupWhisper, async () => {
    try {
      const { binaryPath, modelPath } = await setupWhisper();
      config.set({
        voice: {
          ...config.get().voice,
          stt: 'whisper-local',
          whisperPath: binaryPath,
          whisperModel: modelPath,
        },
      });
      return { ok: true, binaryPath, modelPath };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ---- live preview pane ----
  const preview = new PreviewManager(getWindow);
  ipcMain.handle(IPC.previewOpen, (_e, url: string) => preview.open(url));
  ipcMain.handle(IPC.previewClose, () => preview.close());
  ipcMain.handle(IPC.previewHide, () => preview.hide());
  ipcMain.handle(IPC.previewReload, () => preview.reload());
  ipcMain.handle(IPC.previewBounds, (_e, bounds: PreviewBounds) => preview.setBounds(bounds));
  ipcMain.handle(IPC.previewState, () => preview.state());
}
