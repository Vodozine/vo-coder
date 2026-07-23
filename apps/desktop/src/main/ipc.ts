import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  EmotionalMiddleware,
  matchAgentForMessage,
  McpAdvisor,
  McpClientManager,
  rankAgents,
  searchMcpRegistry,
  type McpServerConfig,
  type RequestLogEntry,
} from '@vo-coder/core';
import type { AgentSpec, HarnessMessage, UserPart } from '@vo-coder/providers';
import type { ProjectAnswers } from '@vo-coder/project-config';
import { detectProject, injectScaffold } from '@vo-coder/scaffold';
import {
  buildCatalog,
  checkFit,
  looksLikeWorkRequest,
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
  type MissionAction,
  type MissionCreateInput,
} from '../shared/ipc-contract';
import { ConfigStore } from './config';
import { Journal } from './journal';
import { MemoryBank } from './membank';
import { MissionManager } from './missions';
import { ProjectStore } from './projects';
import { TelegramBridge } from './telegram';
import { TerminalManager } from './terminal';
import { AUTO_ALLOWED_TOOLS } from './tool-policy';
import { UsageTracker } from './usage';
import { executeFileIdTool, fileIdToolSpecs } from './file-id';
import { executeImageTool, imageToolSpecs } from './image-gen';
import { executeLookTool, lookToolSpecs, extractJpegPreview, RAW_EXTS } from './vision-look';
import { executeWebTool, webToolSpecs } from './web-tools';
import { executeWorkspaceTool, workspaceToolSpecs } from './workspace-tools';
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

  /** Price a usage event from the catalog and record it (any session kind). */
  const recordUsage = (
    bound: { model: string } | undefined,
    ev: { inputTokens: number; outputTokens: number },
    projectId?: string,
  ): void => {
    if (!bound) return;
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
        projectId ?? 'remote',
        ev.inputTokens,
        ev.outputTokens,
        (ev.inputTokens * inPerM + ev.outputTokens * outPerM) / 1e6,
      );
    })();
  };

  // Vodo's cross-everything memory: every chat, mission, tool run, and note
  // lands in one timestamped journal that memory_recall can search.
  const journal = new Journal(join(app.getPath('userData'), 'journal.jsonl'));
  const projectNameOf = (projectId?: string): string | undefined =>
    projectId ? projects.list().projects.find((p) => p.id === projectId)?.name : undefined;
  // Forgiving on purpose: models paraphrase project names ("solitaire" for
  // "solitare"), so match id → exact name → normalized → contains.
  const resolveProjectId = (nameOrId: string): string | undefined => {
    const all = projects.list().projects;
    const raw = nameOrId.trim();
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    return (
      all.find((p) => p.id === raw)?.id ??
      all.find((p) => p.name.toLowerCase() === raw.toLowerCase())?.id ??
      all.find((p) => norm(p.name) === norm(raw))?.id ??
      all.find((p) => norm(p.name).includes(norm(raw)) || norm(raw).includes(norm(p.name)))?.id
    );
  };
  const projectNamesHint = (): string =>
    projects.list().projects.map((p) => `"${p.name}"`).join(', ') || '(none)';

  // The lossless archive (memory bank step 1): every conversation turn,
  // verbatim, searchable forever — fail-soft if sqlite is unavailable.
  let bank: MemoryBank | null = null;
  try {
    bank = new MemoryBank(join(app.getPath('userData'), 'membank.sqlite'));
  } catch (err) {
    console.error('[membank] disabled:', err);
  }

  // Built-in tools every agent session carries: web access, mission control,
  // and memory. Mission tools resolve through a late ref — MissionManager
  // needs routing, which is defined further down.
  let missionsRef: MissionManager | null = null;
  let telegramRef: TelegramBridge | null = null;
  const builtins = {
    specs: () => [
      ...webToolSpecs(),
      ...imageToolSpecs(),
      ...fileIdToolSpecs(),
      ...journal.toolSpecs(),
      ...(bank?.toolSpecs() ?? []),
      ...(missionsRef?.toolSpecs() ?? []),
    ],
    execute: (name: string, args: unknown, ctx?: { projectId?: string; dir?: string }) => {
      // The chat's folder: an attached/session dir when the caller passes one,
      // else the project's own folder.
      const ctxDir = () =>
        ctx?.dir ??
        (ctx?.projectId
          ? projects.list().projects.find((p) => p.id === ctx.projectId)?.dir
          : undefined);
      if (name.startsWith('web_')) return executeWebTool(name, args);
      if (name === 'image_generate') {
        return executeImageTool(args, config, secrets, ctxDir());
      }
      if (name === 'look_at_image') {
        return executeLookTool(args, { config, hub }, ctxDir());
      }
      if (name === 'file_identify') return Promise.resolve(executeFileIdTool(args));
      if (name.startsWith('memory_')) return journal.executeTool(name, args);
      if (name.startsWith('archive_') || name.startsWith('map_')) {
        return bank
          ? bank.executeTool(name, args, resolveProjectId, projectNamesHint, ctx)
          : Promise.resolve({ content: 'The memory bank is unavailable.', isError: true });
      }
      if (missionsRef) return missionsRef.executeTool(name, args, ctx);
      return Promise.resolve({ content: 'Missions are not ready yet.', isError: true });
    },
  };

  // Sync mirror of the catalog for hot paths that can't await getCatalog().
  let catalogSync: ModelRecord[] = [];

  const sessions = new SessionManager({
    config,
    hub,
    mcp,
    projects,
    send: sendToWindow,
    builtins,
    modelCanSee: (modelId) => catalogSync.find((r) => r.id === modelId)?.supportsVision,
    ...(bank
      ? {
          bank: {
            syncSession: (projectId: string, sessionId: string, history: HarnessMessage[]) => {
              bank.syncSession(projectId, sessionId, history);
              // Distill new turns into the map in the background — fail-soft,
              // watermark advances only on success.
              void bank.distillPending(projectId, sessionId, completeCheap);
            },
            digest: (projectId: string) => bank.digest(projectId),
          },
        }
      : {}),
    onUsage: (sessionId, bound, ev) => {
      const meta = projects.meta(sessionId);
      if (meta) recordUsage(bound, ev, meta.projectId);
    },
    pickCheap: async (text) => {
      const pick = await routeForVodo([{ type: 'text', text }], false, false).catch(() => undefined);
      return pick ? { provider: pick.provider, model: pick.model } : undefined;
    },
    onEvent: (sessionId, event) => {
      // Journal real actions (writes/commands/infra), not read-only lookups.
      if (event.type !== 'tool_started') return;
      if (event.name !== 'ws_write' && event.name !== 'ws_run' && !event.name.includes('__')) return;
      const meta = projects.meta(sessionId);
      const a = (event.args ?? {}) as Record<string, unknown>;
      const detail =
        event.name === 'ws_write'
          ? `wrote ${a.path}`
          : event.name === 'ws_run'
            ? `ran: ${a.command}`
            : `${event.name}`;
      journal.append({
        kind: 'tool',
        text: detail,
        ...(projectNameOf(meta?.projectId) ? { project: projectNameOf(meta?.projectId) } : {}),
      });
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
    journal.append({ kind: 'project', text: `created project "${name}"` });
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
      journal.append({ kind: 'project', text: `created project "${name.trim()}"`, project: name.trim() });
      broadcastProjects();
      return { ok: true, project };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle(IPC.projectDelete, (_e, id: string) => {
    // Epitaph before the purge: the project's data goes, but a brief overview
    // stays in the shared journal so "what was that project I did in July?"
    // always has an answer.
    const data = projects.list();
    const project = data.projects.find((p) => p.id === id);
    if (project) {
      const chats = data.sessions.filter((s) => s.projectId === id);
      const topics = chats
        .slice(0, 4)
        .map((c) => `"${c.title}"`)
        .join(', ');
      const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
      const lastActive = Math.max(project.createdAt, ...chats.map((c) => c.updatedAt));
      journal.append({
        kind: 'project',
        text:
          `deleted project "${project.name}" (created ${day(project.createdAt)}, ` +
          `${chats.length} chat${chats.length === 1 ? '' : 's'}, last active ${day(lastActive)})` +
          (topics ? ` — it was about: ${topics}` : ''),
        project: project.name,
      });
    }
    for (const sessionId of projects.deleteProject(id)) sessions.dropLive(sessionId);
    bank?.purgeProject(id);
    broadcastProjects();
  });
  ipcMain.handle(IPC.projectSetDir, (_e, id: string, dir: string) => {
    try {
      if (!existsSync(dir)) return { ok: false, error: 'That folder does not exist.' };
      if (!projects.setDir(id, dir)) return { ok: false, error: 'Unknown project.' };
      journal.append({
        kind: 'project',
        text: `attached folder to "${projectNameOf(id) ?? id}"`,
        ...(projectNameOf(id) ? { project: projectNameOf(id) } : {}),
      });
      broadcastProjects();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
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
  // Point this chat at any folder (or detach with null). Takes effect on the
  // next send — specs and tool mounts re-derive from the meta every turn.
  ipcMain.handle(IPC.sessionSetDir, (_e, sessionId: string, dir: string | null) => {
    projects.setSessionDir(sessionId, dir);
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
  ipcMain.handle(IPC.setConfig, (_e, patch: Partial<AppConfig>) => {
    const next = config.set(patch);
    if ('telegramEnabled' in patch || 'telegramPaired' in patch) telegramRef?.sync();
    return next;
  });
  ipcMain.handle(IPC.setSecret, (_e, provider: string, value: string) => {
    secrets.set(provider, value);
    if (provider === 'telegram') telegramRef?.sync();
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
      // Vision is demanded only while an image is RECENT — old images get
      // stubbed for blind models (prepareMessages), so later coding turns can
      // go back to the user's coder instead of staying vision-locked forever.
      const historyHasImages = sessions
        .historyOf(sessionId)
        .slice(-6)
        .some((m) => m.role === 'user' && m.content.some((p) => p.type === 'image'));
      // Builder mode: the session's project has a folder, so the agent gets
      // workspace tools (ws_write/ws_run) and is expected to actually build —
      // route to a capable executor, not a cheap narrate-only model.
      const projectDir = (() => {
        const meta = projects.meta(sessionId);
        if (!meta) return undefined;
        // A chat-attached folder counts too: the agent has tools over it.
        return meta.dir ?? projects.list().projects.find((p) => p.id === meta.projectId)?.dir;
      })();
      const builderMode = !!projectDir;
      if (!override && mode !== 'off' && projects.meta(sessionId)?.agentId === 'default') {
        // "My agents first" / "My agents only": hand the whole job (prompt,
        // tools, model) to the user's best-matching specialist; unset agent
        // models still get cheapest-adequate model routing underneath.
        // agents-only always lands on SOME agent (best fit when no hint hits).
        if (mode === 'agents' || mode === 'agents-only') {
          const text = parts
            .filter((p): p is Extract<UserPart, { type: 'text' }> => p.type === 'text')
            .map((p) => p.text)
            .join(' ');
          const agents = config.get().agents;
          const needsVision =
            historyHasImages || parts.some((p) => p.type === 'image');
          let match = matchAgentForMessage(text, agents, {
            always: mode === 'agents-only',
          });
          // "My agents first" + a WORK request in a project: if no keyword
          // hit, still hand it to the user's best agent — you built staff so
          // project work goes to your staff, not back to the catalog.
          if (!match && mode === 'agents' && builderMode && looksLikeWorkRequest(text) && agents.length > 0) {
            const top = rankAgents(text, agents)[0];
            if (top) {
              match = {
                agent: top.agent,
                matched: top.matched.length ? top.matched : ['best fit for project work'],
              };
            }
          }
          // Image turns must land on a vision-capable agent model — swap to
          // the best-ranked agent whose model can actually see, if one exists.
          if (match && needsVision && match.agent.model) {
            try {
              const { records } = await getCatalog();
              const canSee = (modelId?: string) =>
                !modelId || records.find((r) => r.id === modelId)?.supportsVision === true;
              if (!canSee(match.agent.model)) {
                const alt = rankAgents(text, agents).find((r) => canSee(r.agent.model));
                if (alt) {
                  match = {
                    agent: alt.agent,
                    matched: [...(alt.matched.length ? alt.matched : ['best available']), 'vision required'],
                  };
                }
              }
            } catch {
              /* catalog offline — keep the original match */
            }
          }
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
        // agents-only never falls back to catalog routing — with no agents
        // defined it simply runs the selected model.
        if (!specOverride && mode !== 'agents-only') {
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
      if (result.ok) {
        const meta = projects.meta(sessionId);
        const text = parts
          .filter((p): p is Extract<UserPart, { type: 'text' }> => p.type === 'text')
          .map((p) => p.text)
          .join(' ')
          .trim();
        journal.append({
          kind: 'chat',
          text: text || '[attachment]',
          ...(projectNameOf(meta?.projectId) ? { project: projectNameOf(meta?.projectId) } : {}),
        });
      }
      return routed && result.ok ? { ...result, routed } : result;
    },
  );
  ipcMain.handle(IPC.chatCompact, async (_e, sessionId: string) => {
    const result = await sessions.compact(sessionId);
    if (result.ok) {
      const meta = projects.meta(sessionId);
      journal.append({
        kind: 'chat',
        text: 'compacted the conversation to free context',
        ...(projectNameOf(meta?.projectId) ? { project: projectNameOf(meta?.projectId) } : {}),
      });
    }
    return result;
  });
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

  initUpdater(getWindow, config);
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
      const records = await buildCatalog({ cacheDir: app.getPath('userData'), extra });
      catalogSync = records; // refresh the sync mirror for hot paths
      return { records, installed };
    })());
  void getCatalog().catch(() => {}); // warm both catalog and mirror at startup

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
      // Every session now carries built-in tools (web search, missions), so the
      // model must be able to call tools — but only demand the capable-executor
      // quality floor when the message actually asks for work; a plain "hello"
      // still routes cheap among tool-capable models.
      needsTools: true,
      agentic: builderMode && looksLikeWorkRequest(text),
      wantsThinking: config.get().thinkingDefault,
    });
    const { records, installed } = await getCatalog();
    const registered = new Set(hub.registry().ids());
    const liveOpenRouter = new Set(
      records.filter((r) => r.provider === 'openrouter').map((r) => r.id),
    );
    // User blocklist: excluded models/vendors never enter routing.
    const excluded = config
      .get()
      .excludedModels.map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const isExcluded = (m: ModelRecord): boolean =>
      excluded.some(
        (term) =>
          m.id.toLowerCase().includes(term) ||
          (m.displayName ?? '').toLowerCase().includes(term),
      );
    const eligible: ModelRecord[] = [];
    for (const m of records) {
      if (isExcluded(m)) continue;
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
    const top = suggest(signal, eligible, profileHardware(), 1, {
      tier: config.get().routeTier,
    })[0];
    if (!top?.model.provider) return undefined;
    return { provider: top.model.provider, model: top.model.id, rationale: top.rationale };
  };

  // ---- agent OS: missions + telegram remote ----
  // Both run Vodo in their OWN AgentSession instances — fully concurrent with
  // chat sessions, so a mission never blocks interactive coding.
  const vodoSpec = (): AgentSpec => {
    const cfg = config.get();
    return {
      id: 'default',
      name: 'Vodo',
      systemPrompt: cfg.systemPrompt,
      ...(cfg.thinkingDefault ? { thinking: { enabled: true } } : {}),
    };
  };
  const resolveSpec = (spec: AgentSpec) => {
    const { defaultProvider, defaultModel } = config.get();
    return hub.registry().resolve(spec, { provider: defaultProvider, model: defaultModel });
  };
  /** One-shot completion on the cheapest adequate model (distiller etc.). */
  const completeCheap = async (prompt: string): Promise<string> => {
    const pick = await routeForVodo([{ type: 'text', text: prompt.slice(0, 2000) }], false, false)
      .catch(() => undefined);
    const spec = vodoSpec();
    const bound = resolveSpec(
      pick ? { ...spec, provider: pick.provider as AgentSpec['provider'], model: pick.model } : spec,
    );
    let out = '';
    let errMsg: string | undefined;
    for await (const event of bound.provider.stream(
      { model: bound.model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] },
      { signal: new AbortController().signal },
    )) {
      if (event.type === 'text_delta') out += event.text;
      else if (event.type === 'error') errMsg = event.error.message;
    }
    if (!out.trim()) throw new Error(errMsg ?? 'empty completion');
    return out;
  };
  const remoteTools = (dir?: string) => [
    ...(dir ? [...workspaceToolSpecs(dir), ...lookToolSpecs()] : []),
    ...builtins.specs(),
    ...mcp.toolsFor(undefined),
  ];
  const remoteExecute = (name: string, args: unknown, dir?: string, projectId?: string) => {
    if (name.startsWith('ws_')) {
      return dir
        ? executeWorkspaceTool(dir, name, args)
        : Promise.resolve({ content: 'This mission has no project folder.', isError: true });
    }
    if (/^(web_|mission_|memory_|archive_|map_|image_|look_|file_)/.test(name)) {
      return builtins.execute(name, args, { projectId, ...(dir ? { dir } : {}) });
    }
    return mcp.call(name, args);
  };

  const missions = new MissionManager(join(app.getPath('userData'), 'missions.json'), {
    vodoSpec,
    projectDir: (projectId) => projects.list().projects.find((p) => p.id === projectId)?.dir,
    resolveProject: resolveProjectId,
    resolve: resolveSpec,
    route: (text, builderMode) =>
      routeForVodo([{ type: 'text', text }], false, builderMode),
    tools: remoteTools,
    execute: remoteExecute,
    askPermission: (missionTitle, tool, args) =>
      telegramRef?.askPermissionFromUser(missionTitle, tool, args) ?? Promise.resolve('deny'),
    onUsage: (bound, ev, projectId) => recordUsage(bound, ev, projectId),
    notify: (text) => telegramRef?.notify(text),
    onChanged: (list) => sendToWindow(IPC.missionsChanged, list),
    log: (text, projectId) =>
      journal.append({
        kind: 'mission',
        text,
        surface: 'mission',
        ...(projectNameOf(projectId) ? { project: projectNameOf(projectId) } : {}),
      }),
  });
  missionsRef = missions;

  const telegram = new TelegramBridge(config, secrets, {
    vodoSpec,
    resolve: resolveSpec,
    route: (text) => routeForVodo([{ type: 'text', text }], false, false),
    tools: () => remoteTools(),
    execute: (name, args) => telegramExecute(name, args),
    missionsSummary: () => missions.describeAll(),
    onUsage: (bound, ev) => recordUsage(bound, ev),
    onChanged: (info) => sendToWindow(IPC.telegramChanged, info),
    log: (text) => journal.append({ kind: 'chat', text, surface: 'telegram' }),
  });
  // Plan mode gates interactive surfaces only — scheduled missions keep their
  // own autoApprove semantics and are never silently blocked by the toggle.
  const telegramExecute = (name: string, args: unknown) => {
    if (config.get().approvalMode === 'plan' && !AUTO_ALLOWED_TOOLS.has(name)) {
      return Promise.resolve({
        content:
          'PLAN MODE: execution is disabled — this call was not run. Present a plan; the user ' +
          'switches to Auto or Manual to execute.',
        isError: true,
      });
    }
    return remoteExecute(name, args);
  };
  telegramRef = telegram;
  telegram.sync();
  app.on('before-quit', () => {
    missions.stopAll();
    telegram.stop();
  });

  ipcMain.handle(IPC.missionsList, () => missions.list());
  ipcMain.handle(IPC.missionCreate, (_e, input: MissionCreateInput) => missions.create(input));
  ipcMain.handle(IPC.missionControl, (_e, id: string, action: MissionAction) =>
    missions.control(id, action),
  );
  ipcMain.handle(IPC.telegramInfo, () => telegram.info());
  ipcMain.handle(IPC.telegramPairCode, () => telegram.generatePairCode());
  ipcMain.handle(IPC.telegramUnpair, (_e, chatId: number) => telegram.unpair(chatId));

  // ---- memory view + smart-context toggle ----
  ipcMain.handle(IPC.projectSetAssemble, (_e, projectId: string, enabled: boolean) => {
    projects.setAssemble(projectId, enabled);
    broadcastProjects();
  });
  ipcMain.handle(IPC.memStats, (_e, projectId: string) =>
    bank ? bank.stats(projectId) : { nodes: 0, archiveTurns: 0 },
  );
  ipcMain.handle(
    IPC.memMapList,
    (_e, projectId: string, opts?: { query?: string; type?: string; includeInactive?: boolean }) =>
      bank ? bank.listNodes(projectId, opts ?? {}) : [],
  );
  ipcMain.handle(IPC.memMapSetStatus, (_e, projectId: string, nodeId: number, status: string) => {
    bank?.setNodeStatus(projectId, nodeId, status);
  });
  ipcMain.handle(IPC.memMapDelete, (_e, projectId: string, nodeId: number) => {
    bank?.deleteNode(projectId, nodeId);
  });
  // Inline display of generated/project images — reads are fenced to project
  // folders and the app's own generated dir.
  ipcMain.handle(IPC.imageRead, (_e, path: string) => {
    try {
      const allowedRoots = [
        join(app.getPath('userData'), 'generated'),
        ...projects.list().projects.flatMap((p) => (p.dir ? [p.dir] : [])),
        ...projects.list().sessions.flatMap((s) => (s.dir ? [s.dir] : [])),
      ];
      const target = resolve(path);
      const inside = (root: string) => {
        const rel = relative(root, target);
        return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
      };
      if (!allowedRoots.some(inside)) {
        return { ok: false, error: 'Path outside allowed folders.' };
      }
      let data: Buffer = readFileSync(target);
      const ext = target.split('.').pop()?.toLowerCase() ?? 'png';
      // Camera RAW files render via their embedded JPEG preview.
      if (RAW_EXTS.has(`.${ext}`)) {
        const preview = extractJpegPreview(data);
        if (!preview) return { ok: false, error: 'No embedded preview in this RAW file.' };
        data = preview;
      }
      if (data.length > 24 * 1024 * 1024) return { ok: false, error: 'Image too large to preview.' };
      const mime = RAW_EXTS.has(`.${ext}`) || ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/png';
      return { ok: true, dataUrl: `data:${mime};base64,${data.toString('base64')}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

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
    ) => {
      const excluded = config
        .get()
        .excludedModels.map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      const records = (await getCatalog()).records.filter(
        (m) =>
          !excluded.some(
            (term) =>
              m.id.toLowerCase().includes(term) ||
              (m.displayName ?? '').toLowerCase().includes(term),
          ),
      );
      return suggest(signalFromPrompt(text, opts), records, profileHardware(), 3, {
        tier: config.get().routeTier,
      });
    },
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
