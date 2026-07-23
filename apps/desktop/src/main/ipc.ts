import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  EmotionalMiddleware,
  matchAgentForMessage,
  McpAdvisor,
  McpClientManager,
  searchMcpRegistry,
  type McpServerConfig,
  type RequestLogEntry,
} from '@vo-coder/core';
import type { AgentSpec, UserPart } from '@vo-coder/providers';
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
import { ProjectStore } from './projects';
import { TerminalManager } from './terminal';
import { UsageTracker } from './usage';
import { XaiOAuth } from './xai-oauth';
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
  // Safe against shutdown races: PTYs, watchers, and streams keep emitting
  // after the window is gone — sending to a destroyed webContents throws.
  const sendToWindow = (channel: string, payload: unknown): void => {
    const win = getWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(channel, payload);
  };
  const xaiOauth = new XaiOAuth(config, secrets, sendToWindow);
  setInterval(() => void xaiOauth.refreshIfNeeded(), 10 * 60_000);
  void xaiOauth.refreshIfNeeded();
  const hub = new ProviderHub(config, secrets, () => xaiOauth.token());
  const mcp = new McpClientManager();
  const projects = new ProjectStore();
  projects.ensureDefault();
  const usage = new UsageTracker(join(app.getPath('userData'), 'usage.json'), sendToWindow);
  const sessions = new SessionManager({
    config,
    hub,
    mcp,
    projects,
    send: sendToWindow,
    onUsage: (sessionId, bound, ev) => {
      const meta = projects.meta(sessionId);
      if (!meta || !bound) return;
      void (async () => {
        let inPerM = 0;
        let outPerM = 0;
        try {
          const { records } = await getCatalog();
          const rec = records.find((r) => r.id === bound.model);
          inPerM = Math.max(0, rec?.pricing?.inputPerMTok ?? 0);
          outPerM = Math.max(0, rec?.pricing?.outputPerMTok ?? 0);
        } catch {
          /* unpriced — tokens still count */
        }
        usage.record(
          meta.projectId,
          ev.inputTokens,
          ev.outputTokens,
          (ev.inputTokens * inPerM + ev.outputTokens * outPerM) / 1e6,
        );
      })();
    },
  });

  ipcMain.handle(IPC.usageGet, () => usage.get());
  ipcMain.handle(IPC.xaiOauthStatus, () => xaiOauth.status());
  ipcMain.handle(IPC.xaiOauthBegin, () => xaiOauth.begin());
  ipcMain.handle(IPC.xaiOauthSignOut, () => xaiOauth.signOut());

  // ---- projects & chat sessions ----
  const broadcastProjects = () => sendToWindow(IPC.projectsChanged, projects.list());
  ipcMain.handle(IPC.projectsList, () => projects.list());
  ipcMain.handle(IPC.projectCreate, (_e, name: string, dir?: string) => {
    const project = projects.createProject(name, dir);
    broadcastProjects();
    return project;
  });
  ipcMain.handle(IPC.projectCreateIn, (_e, parentDir: string, name: string) => {
    try {
      const safe = name.trim().replace(/[<>:"/\\|?*]+/g, '-').replace(/\s+/g, ' ').trim();
      if (!safe) return { ok: false, error: 'Give the project a name.' };
      const dir = join(parentDir, safe);
      mkdirSync(dir, { recursive: true });
      const project = projects.createProject(name.trim(), dir);
      broadcastProjects();
      return { ok: true, project };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle(IPC.projectDelete, (_e, id: string) => {
    for (const sessionId of projects.deleteProject(id)) sessions.dropLive(sessionId);
    broadcastProjects();
  });
  ipcMain.handle(IPC.sessionCreate, (_e, projectId: string, agentId?: string) => {
    const meta = projects.createSession(projectId, agentId);
    broadcastProjects();
    return meta;
  });
  ipcMain.handle(IPC.sessionOpen, (_e, sessionId: string) => {
    const meta = projects.meta(sessionId);
    if (!meta) throw new Error(`Unknown chat session "${sessionId}".`);
    return { meta, history: sessions.historyOf(sessionId) };
  });
  ipcMain.handle(IPC.sessionDelete, (_e, sessionId: string) => {
    sessions.dropLive(sessionId);
    projects.deleteSession(sessionId);
    broadcastProjects();
  });
  ipcMain.handle(IPC.sessionSetAgent, (_e, sessionId: string, agentId: string) => {
    sessions.setAgent(sessionId, agentId);
    broadcastProjects();
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
      sendToWindow(IPC.checkin, {
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
    if (suggestion) sendToWindow(IPC.advisorSuggest, suggestion);
  };

  ipcMain.handle(
    IPC.chatSend,
    async (
      _e,
      sessionId: string,
      parts: UserPart[],
      override?: { provider?: string; model?: string },
    ) => {
      const invalid = validateParts(parts);
      if (invalid) return { ok: false, error: invalid };
      observeMessage(sessionId, parts);
      let routed: { provider: string; model: string; rationale: string } | undefined;
      let specOverride: AgentSpec | undefined;
      const mode = config.get().routeMode;
      const historyHasImages = sessions
        .historyOf(sessionId)
        .some((m) => m.role === 'user' && m.content.some((p) => p.type === 'image'));
      // Builder mode: the session's project has a folder, so the agent gets
      // workspace tools (ws_write/ws_run) and is expected to actually build —
      // route to a capable executor, not a cheap narrate-only model.
      const projectDir = (() => {
        const meta = projects.meta(sessionId);
        if (!meta) return undefined;
        return projects.list().projects.find((p) => p.id === meta.projectId)?.dir;
      })();
      const builderMode = !!projectDir;
      if (!override && mode !== 'off' && projects.meta(sessionId)?.agentId === 'default') {
        // "My agents first": hand the whole job (prompt, tools, model) to the
        // user's best-matching specialist; unset agent models still get
        // cheapest-adequate model routing underneath.
        if (mode === 'agents') {
          const text = parts
            .filter((p): p is Extract<UserPart, { type: 'text' }> => p.type === 'text')
            .map((p) => p.text)
            .join(' ');
          const match = matchAgentForMessage(text, config.get().agents);
          if (match) {
            specOverride = match.agent;
            const handoff = `handed to ${match.agent.name} (matched: ${match.matched.join(', ')})`;
            if (!match.agent.model) {
              const pick = await routeForVodo(parts, historyHasImages, builderMode).catch(
                () => undefined,
              );
              if (pick) override = { provider: pick.provider, model: pick.model };
              routed = {
                provider: override?.provider ?? '',
                model: override?.model ?? '',
                rationale: pick ? `${handoff} — ${pick.rationale}` : handoff,
              };
            } else {
              routed = {
                provider: match.agent.provider ?? '',
                model: match.agent.model,
                rationale: `${handoff} — ${match.agent.model}`,
              };
            }
          }
        }
        if (!specOverride) {
          const pick = await routeForVodo(parts, historyHasImages, builderMode).catch(
            () => undefined,
          );
          if (pick) {
            override = { provider: pick.provider, model: pick.model };
            routed = pick;
          }
        }
      }
      const result = sessions.send(sessionId, parts, override, specOverride);
      return routed && result.ok ? { ...result, routed } : result;
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
  const terminals = new TerminalManager(sendToWindow);
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
  const projectWatcher = new ProjectWatcher(sendToWindow);
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

  // ---- capability registry + Vodo routing ----
  interface CatalogCache {
    records: ModelRecord[];
    /** Models actually present on local servers (ollama/lmstudio). */
    installed: Record<string, string[]>;
  }
  let catalogPromise: Promise<CatalogCache> | null = null;
  const getCatalog = (): Promise<CatalogCache> =>
    (catalogPromise ??= (async () => {
      // Locally installed models join the catalog; seed entries with matching
      // ids keep their curated quality/footprint data on merge.
      const extra: ModelRecord[] = [];
      const installed: Record<string, string[]> = {};
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
          installed[providerId] = models.map((m) => m.id);
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
      return { records: await buildCatalog({ cacheDir: app.getPath('userData'), extra }), installed };
    })());

  /**
   * The economic core: the user talks to Vodo, Vodo picks the right man for
   * the job. Candidates are filtered to providers that are actually usable
   * right now (configured keys; local models actually installed), then ranked
   * cheapest-adequate by the capability router.
   */
  const routeForVodo = async (
    parts: UserPart[],
    historyHasImages = false,
    builderMode = false,
  ): Promise<{ provider: string; model: string; rationale: string } | undefined> => {
    const text = parts
      .filter((p): p is Extract<UserPart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join(' ');
    const signal = signalFromPrompt(text, {
      // The whole conversation replays on every turn — an image anywhere in
      // history forces a vision-capable model, not just images sent right now.
      needsVision: historyHasImages || parts.some((p) => p.type === 'image'),
      // A folder-backed project always ships ws_ tools in the request, so the
      // model MUST be able to call them — and the turn is a real build, so
      // demand a capable executor, not the cheapest model that merely narrates.
      needsTools: builderMode || mcp.list().some((s) => s.connected),
      agentic: builderMode,
      wantsThinking: config.get().thinkingDefault,
    });
    const { records, installed } = await getCatalog();
    const registered = new Set(hub.registry().ids());
    const liveOpenRouter = new Set(
      records.filter((r) => r.provider === 'openrouter').map((r) => r.id),
    );
    const eligible: ModelRecord[] = [];
    for (const m of records) {
      if (m.provider && registered.has(m.provider)) {
        if (m.provider === 'ollama' || m.provider === 'lmstudio') {
          if (installed[m.provider]?.includes(m.id)) eligible.push(m);
        } else if (m.provider === 'openrouter') {
          // Only route to ids that exist on OpenRouter right now.
          if (liveOpenRouter.size === 0 || liveOpenRouter.has(m.id)) eligible.push(m);
        } else {
          eligible.push(m);
        }
      } else if (
        // Native provider not configured, but the same model is reachable
        // through the user's OpenRouter key (verified against the live list).
        m.openrouterId &&
        registered.has('openrouter') &&
        liveOpenRouter.has(m.openrouterId)
      ) {
        eligible.push({ ...m, provider: 'openrouter', id: m.openrouterId });
      }
    }
    const top = suggest(signal, eligible, profileHardware(), 1)[0];
    if (!top?.model.provider) return undefined;
    return { provider: top.model.provider, model: top.model.id, rationale: top.rationale };
  };

  ipcMain.handle(IPC.registryCatalog, async () => {
    const hardware = profileHardware();
    const records = (await getCatalog()).records.map((m) => ({ ...m, fit: checkFit(m, hardware) }));
    return { hardware, records };
  });
  ipcMain.handle(
    IPC.registrySuggest,
    async (
      _e,
      text: string,
      opts?: { needsTools?: boolean; needsVision?: boolean; wantsThinking?: boolean },
    ) => suggest(signalFromPrompt(text, opts), (await getCatalog()).records, profileHardware()),
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
  ipcMain.handle(IPC.previewOpenFile, (_e, path: string) => preview.openFile(path));
  ipcMain.handle(IPC.previewDetect, async (_e, dir: string) => {
    // 1) A dev server already running on a well-known port? (Skip our own.)
    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    const ownPort = devUrl ? Number(new URL(devUrl).port) : -1;
    const ports = [5173, 3000, 3001, 4200, 4321, 8080, 8000, 5000].filter((p) => p !== ownPort);
    const hits = await Promise.all(
      ports.map(async (port) => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 400);
          const res = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal });
          clearTimeout(timer);
          return res.status < 500 ? port : null;
        } catch {
          return null;
        }
      }),
    );
    const port = hits.find((p) => p !== null);
    if (port) return { kind: 'url', url: `http://127.0.0.1:${port}/` };
    // 2) A static entry page in the project.
    for (const rel of ['index.html', 'dist/index.html', 'build/index.html', 'public/index.html', 'src/index.html']) {
      const candidate = join(dir, rel);
      if (existsSync(candidate)) return { kind: 'file', path: candidate };
    }
    return { kind: 'none' };
  });
  ipcMain.handle(IPC.previewClose, () => preview.close());
  ipcMain.handle(IPC.previewHide, () => preview.hide());
  ipcMain.handle(IPC.previewReload, () => preview.reload());
  ipcMain.handle(IPC.previewBounds, (_e, bounds: PreviewBounds) => preview.setBounds(bounds));
  ipcMain.handle(IPC.previewState, () => preview.state());
}
