import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import { emitToSinks, handle as registerHandler } from './ipc-registry';
import {
  onRemoteStatusChange,
  remoteStatus,
  setMediaResolver,
  setPreviewOrigin,
  setUploadSink,
  startRemoteHost,
  stopRemoteHost,
} from './remote-server';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { hostDialog } from './host-dialog';
import { openExtraWindow } from './windows';
import { runOauthLoopback } from './oauth-loopback';
import { userDataDir } from './paths';
import { edition } from './edition';
import type { RemoteSettings } from '../shared/ipc-contract';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  addressedByName,
  EmotionalMiddleware,
  matchAgentForMessage,
  McpAdvisor,
  McpClientManager,
  mentionsName,
  rankAgents,
  searchMcpRegistry,
  type McpServerConfig,
  type RequestLogEntry,
} from '@vo-coder/core';
import type { AgentSpec, BoundModel, HarnessMessage, ToolSpec, UserPart } from '@vo-coder/providers';
import type { ProjectAnswers } from '@vo-coder/project-config';
import { detectProject, injectScaffold } from '@vo-coder/scaffold';
import {
  buildCatalog,
  checkFit,
  looksLikeImageRequest,
  looksLikeWorkRequest,
  ModelStrikes,
  profileHardware,
  signalFromPrompt,
  qualityFor,
  suggest,
  type ModelRecord,
} from '@vo-coder/capability-registry';
import {
  IPC,
  isAllowedMediaType,
  MAX_ATTACHMENT_BYTES,
  type AppConfig,
  type HostFsEntry,
  type HostFsListing,
  type MissionAction,
  type MissionCreateInput,
} from '../shared/ipc-contract';
import { closeAllCliChildren } from './claude-code-provider';
import { ConfigStore } from './config';
import { Journal } from './journal';
import { LifeImporter } from './life-import';
import { MemoryBank } from './membank';
import { MissionManager } from './missions';
import { GENERAL_PROJECT_ID, HOMELAB_PROJECT_ID, ProjectStore } from './projects';
import { TelegramBridge } from './telegram';
import { TerminalManager } from './terminal';
import { AUTO_ALLOWED_TOOLS, MEMORY_TOOLS } from './tool-policy';
import { UsageTracker } from './usage';
import { DeadModels } from './dead-models';
import { executeFileIdTool, fileIdToolSpecs } from './file-id';
import { executeImageTool, imageToolSpecs } from './image-gen';
import { executeVideoTool, videoToolSpecs } from './video-gen';
import { executePaymentTool, paymentToolSpecs, SpendLedger } from './payments';
import { executeLookTool, lookToolSpecs, extractJpegPreview, RAW_EXTS } from './vision-look';
import { executeWebTool, webToolSpecs } from './web-tools';
import { executeWorkspaceTool, insideRoot, stopLaunched, workspaceToolSpecs } from './workspace-tools';
import { XaiOAuth } from './xai-oauth';
import { McpOAuthManager } from './mcp-oauth';
import { GoogleOAuth } from './google-oauth';
import { gmailToolSpecs, executeGmailTool, GMAIL_TOOL_NAMES } from './gmail-tools';
import { PreviewManager, detectDevCommand, type PreviewBounds } from './preview';
import { ProjectWatcher } from './watcher';
import { initUpdater } from './updater';
import { endpointUrlFor, endpointVramBytes, ProviderHub } from './providers';
import { ContextFitStore } from './context-fit';
import { HOMELAB_AGENT_ID } from '../shared/homelab';
import {
  AUTO_AGENT_MAX_CAP,
  isAutoAgent,
  makeAutoAgent,
  nextAutoAgentName,
} from '../shared/auto-agents';
import { audioMimeFor } from '../shared/media';
import { executeGroupTool, groupToolSpecs } from './groups';
import {
  gateNudge,
  globalRulesPath,
  GLOBAL_RULES_TEMPLATE,
  projectGate,
  projectMdPath,
  readGlobalRules,
  writeGlobalRules,
} from './project-md';
import {
  importSkill,
  importSkillFromGitHub,
  listSkills,
  parseSkillCall,
  readSkill,
  removeSkill,
  skillCallNote,
  skillsCatalog,
} from './skills';
import { extractLesson, helpToolSpecs, vodoStepIn } from './vodo-helper';
import { SecretStore } from './secrets';
import { SessionManager } from './sessions';
import { fetchCompatCatalog } from './tts-catalog';
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

/** LAN addresses a front end could reach this machine on. */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const nics of Object.values(networkInterfaces())) {
    for (const nic of nics ?? []) {
      if (nic.family === 'IPv4' && !nic.internal) out.push(nic.address);
    }
  }
  return out;
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const config = new ConfigStore();
  const secrets = new SecretStore();
  // Safe against shutdown races: PTYs, watchers, and streams keep emitting
  // after the window is gone — sending to a destroyed webContents throws.
  const sendToWindow = (channel: string, payload: unknown): void => {
    // Attached front ends first, and deliberately before the early return
    // below: a host whose own window has gone must still keep the other
    // machine's copy streaming.
    emitToSinks(channel, payload);
    const win = getWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(channel, payload);
  };
  /** Assigned once liveIdCache exists — clears xAI routing verification after login/out. */
  let invalidateXaiLiveIds: () => void = () => {};
  const xaiOauth = new XaiOAuth(config, secrets, (channel, payload) => {
    sendToWindow(channel, payload);
    // After Grok login/out the xAI client is (re)registered with a new bearer —
    // drop cached live model ids so routing re-verifies against the live list.
    if (channel === IPC.xaiOauthEvent) {
      const ev = payload as { state?: string };
      if (ev.state === 'connected' || ev.state === 'signed_out') invalidateXaiLiveIds();
    }
  });
  setInterval(() => void xaiOauth.refreshIfNeeded(), 10 * 60_000);
  void xaiOauth.refreshIfNeeded();
  // What each local model actually costs on its own box, so the context window
  // is chosen by measurement rather than by the user guessing (a wrong guess
  // spills layers to CPU and costs ~20x throughput, silently).
  const contextFit = new ContextFitStore(join(app.getPath('userData'), 'context-fit.json'));
  const hub = new ProviderHub(
    config,
    secrets,
    () => xaiOauth.token(),
    (modelId) => contextFit.windowFor(modelId, endpointUrlFor(config.get(), modelId)),
  );
  const mcp = new McpClientManager();
  // "Sign in with GitHub" (and future OAuth-backed remote MCP servers): the
  // device-flow token lands in the server's Authorization header and the bundle
  // is kept in the encrypted secret store for background refresh.
  const mcpOAuth = new McpOAuthManager(config, secrets, mcp, sendToWindow);
  setInterval(() => void mcpOAuth.refreshIfNeeded(), 10 * 60_000);
  void mcpOAuth.refreshIfNeeded();
  // Gmail sign-in (bring-your-own Google client) — the token feeds the built-in
  // gmail_* tools; refreshed in the background like the other OAuth logins.
  const googleOAuth = new GoogleOAuth(config, secrets, sendToWindow);
  setInterval(() => void googleOAuth.refreshIfNeeded(), 10 * 60_000);
  void googleOAuth.refreshIfNeeded();
  const projects = new ProjectStore();
  projects.ensureDefault();
  const usage = new UsageTracker(join(app.getPath('userData'), 'usage.json'), sendToWindow);

  /**
   * Is this endpoint billed by a subscription/plan rather than per-token? Its
   * catalog token prices are then fiction — they must be zeroed for the meter
   * AND for routing/UI, or auto-routing steers away from a model that is
   * actually free on the user's plan. One predicate so the four sites that
   * cared (usage, routing, catalog, suggest) cannot drift apart again — they
   * had: only this list zeroed every plan-billed provider, the other three
   * zeroed xAI alone.
   */
  const isSubscriptionBilled = (providerId: string | undefined): boolean => {
    const p = providerId?.toLowerCase() ?? '';
    return (
      p === 'nvidia' ||
      p === 'zai' ||
      // Gemini's AI Studio free tier bills nothing, so treat it like NVIDIA's
      // free endpoint: shown free, and auto-routing is not steered away from it
      // by catalog list prices the user never actually pays.
      p === 'gemini' ||
      p === 'claude-code' ||
      (p === 'xai' && hub.usingXaiOAuth())
    );
  };
  /** Zero a record's pricing when its endpoint is subscription-billed; pass others through. */
  const zeroSubscriptionPricing = <T extends { provider?: string }>(rec: T): T =>
    isSubscriptionBilled(rec.provider)
      ? { ...rec, pricing: { inputPerMTok: 0, outputPerMTok: 0 } }
      : rec;

  /** Price a usage event from the catalog and record it (any session kind). */
  const recordUsage = (
    bound: { model: string; provider?: { id?: string } } | undefined,
    ev: { inputTokens: number; outputTokens: number },
    projectId?: string,
  ): void => {
    if (!bound) return;
    void (async () => {
      let inPerM = 0;
      let outPerM = 0;
      // Pricing is per-ENDPOINT. Grok login (subscription OAuth) is preferred
      // over any saved xAI API key for requests — that path is subscription-
      // billed, not pay-per-token. NVIDIA's free tier is the same idea.
      if (!isSubscriptionBilled(bound.provider?.id)) {
        try {
          const { records } = await getCatalog();
          const rec = records.find((r) => r.id === bound.model);
          inPerM = Math.max(0, rec?.pricing?.inputPerMTok ?? 0);
          outPerM = Math.max(0, rec?.pricing?.outputPerMTok ?? 0);
        } catch {
          /* unpriced — tokens still count */
        }
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
  // Every attempt to spend, approved or not — the daily cap is computed from it.
  const spendLedger = new SpendLedger(join(app.getPath('userData'), 'spending.json'));
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
  // Life import: dumps → provenance-stamped life notes. Progress streams to
  // every attached front end (window and remote clients alike).
  const lifeImporter = bank
    ? new LifeImporter({ bank, notify: (ev) => sendToWindow(IPC.lifeProgress, ev) })
    : null;

  /**
   * Hiring. Vodo must never be stuck for hands: when a group needs more people
   * than the user has built, it hires one here — a REAL agent persisted to the
   * agent list, named from the pioneer pool, wearing the user's auto-agent
   * defaults. Its role is not baked in; it arrives in the task it is given,
   * which is what makes hiring a single cheap decision.
   *
   * Returns undefined when the cap is reached or the name pool is exhausted —
   * the caller then re-tasks an idle member instead.
   */
  const autoAgentLimit = (): number =>
    Math.max(0, Math.min(config.get().autoAgents.max, AUTO_AGENT_MAX_CAP));
  const hireAutoAgent = (): AgentSpec | undefined => {
    const cfg = config.get();
    const existing = cfg.agents.filter(isAutoAgent);
    if (existing.length >= autoAgentLimit()) return undefined;
    const name = nextAutoAgentName(cfg.agents.map((a) => a.name));
    if (!name) return undefined;
    const hire = makeAutoAgent(name, cfg.autoAgents);
    config.set({ agents: [...cfg.agents, hire] });
    sendToWindow(IPC.configChanged, config.get());
    return hire;
  };

  // Built-in tools every agent session carries: web access, mission control,
  // and memory. Mission tools resolve through a late ref — MissionManager
  // needs routing, which is defined further down.
  let missionsRef: MissionManager | null = null;
  let telegramRef: TelegramBridge | null = null;
  /**
   * Files the chat is already showing inline (image_generate results). Opening
   * Preview for one of these throws the user onto another tab to look at a
   * picture that is right there in the conversation. Bounded — it only has to
   * outlive the turn that made the image.
   */
  const shownInChat = new Set<string>();
  const rememberShownInChat = (path: string) => {
    shownInChat.add(resolve(path));
    if (shownInChat.size > 50) shownInChat.delete(shownInChat.values().next().value!);
  };
  /** Every group tool the model is offered — the dispatch reads this. */
  const GROUP_TOOL_NAMES = new Set(groupToolSpecs().map((s) => s.name));
  const builtins = {
    specs: () => [
      ...webToolSpecs(),
      ...(googleOAuth.status().connected ? gmailToolSpecs() : []),
      ...imageToolSpecs(),
      ...videoToolSpecs(),
      ...paymentToolSpecs(config),
      ...fileIdToolSpecs(),
      ...journal.toolSpecs(),
      ...(bank?.toolSpecs() ?? []),
      ...(missionsRef?.toolSpecs() ?? []),
      ...groupToolSpecs(),
      ...helpToolSpecs(),
      {
        name: 'preview_open',
        description:
          "Show a built page or document (HTML, PDF, built app output) in the app's Preview " +
          'pane so the user sees the result immediately. Path is relative to the project ' +
          'folder. Use it after assembling a deliverable — showing beats describing. NOT for ' +
          'images you just generated: those already render in the chat under the tool call, ' +
          'and opening Preview only drags the user off the conversation to see them.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File to show, relative to the project folder' },
          },
          required: ['path'],
        },
      },
      {
        name: 'project_create',
        description:
          'Create a new project: make its folder on disk, register it so it appears in the ' +
          "app's Projects list, and move THIS chat into it so your file tools work there. Use " +
          'it when the user asks to start a project and says where to put it — including when ' +
          'the request arrives from Telegram. A project needs its own folder: this is what ' +
          'gives a group project somewhere to deliver into. If the folder already exists it is ' +
          'adopted rather than replaced, and nothing inside it is touched.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Project name, as the user said it' },
            parentDir: {
              type: 'string',
              description:
                'Absolute path of the folder to create the project folder INSIDE ' +
                '(e.g. "C:/Users/me/Projects" makes "C:/Users/me/Projects/<name>")',
            },
            dir: {
              type: 'string',
              description:
                'Use this EXACT folder instead of making one under parentDir. Give one or the other.',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'skill_read',
        description:
          'Read one of the installed SKILLS — packaged instructions for a specific kind of ' +
          'task (your briefing lists the catalog when any are installed). Call it BEFORE ' +
          'improvising on a task a skill covers, and follow what it says. Returns the full ' +
          'instructions plus any bundled files with their locations.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Skill name (or slug) from the catalog' },
          },
          required: ['name'],
        },
      },
    ],
    execute: (
      name: string,
      args: unknown,
      ctx?: { projectId?: string; dir?: string; sessionId?: string; signal?: AbortSignal },
    ) => {
      // The chat's folder. Read from the session's LIVE meta first: ctx is
      // captured once per turn, so a project created earlier in this same turn
      // would otherwise be invisible to the calls that follow it — and
      // project_create then start-a-group-here could never work in one go.
      const ctxDir = () =>
        (ctx?.sessionId ? projects.meta(ctx.sessionId)?.dir : undefined) ??
        ctx?.dir ??
        (ctx?.projectId
          ? projects.list().projects.find((p) => p.id === ctx.projectId)?.dir
          : undefined);
      if (name.startsWith('web_')) return executeWebTool(name, args);
      if (name === 'project_create') {
        const a = (args ?? {}) as { name?: unknown; parentDir?: unknown; dir?: unknown };
        const title = typeof a.name === 'string' ? a.name.trim() : '';
        const parent = typeof a.parentDir === 'string' ? a.parentDir.trim() : '';
        const exact = typeof a.dir === 'string' ? a.dir.trim() : '';
        if (!title) return Promise.resolve({ content: 'Give the project a name.', isError: true });
        if (!parent && !exact) {
          return Promise.resolve({
            content:
              'Say WHERE it goes: parentDir (a folder to create it inside) or dir (an exact ' +
              'folder to use). Ask the user for a location rather than inventing one.',
            isError: true,
          });
        }
        try {
          // Windows forbids these in a path segment; a name with a slash would
          // otherwise silently create a nested folder somewhere unexpected.
          const safe = title.replace(/[<>:"/\\|?*]+/g, '-').replace(/\s+/g, ' ').trim();
          const dir = exact ? resolve(exact) : resolve(join(parent, safe || 'project'));
          mkdirSync(dir, { recursive: true });
          // One folder ↔ one project: a second job in the same folder JOINS the
          // project that already owns it instead of minting a twin. Working
          // through Telegram made this loud — every dispatched task built its
          // own "Knitting Wizard" row.
          const { project, adopted } = projects.createOrAdopt(title, dir);
          // Move the calling chat in and bind its folder, so the very next tool
          // call in this same turn already has hands inside the project.
          if (ctx?.sessionId) {
            projects.moveSession(ctx.sessionId, project.id);
            projects.setSessionDir(ctx.sessionId, dir);
            bank?.moveSession(ctx.sessionId, project.id);
          }
          journal.append({
            kind: 'project',
            text: `${adopted ? 'joined project' : 'created project'} "${project.name}"`,
            project: project.name,
          });
          broadcastProjects();
          return Promise.resolve({
            content: adopted
              ? `"${project.name}" already exists at ${dir} — this chat joined it rather than ` +
                'making a second one. Its earlier work is on disk; look before you rebuild ' +
                'anything. Your file tools and group_start work here.'
              : `Created project "${project.name}" at ${dir}. It is in the Projects list now, and ` +
                'this chat is inside it — your file tools and group_start work here.',
          });
        } catch (err) {
          return Promise.resolve({
            content: `Could not create it: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          });
        }
      }
      if (name === 'skill_read') {
        const want = String((args as { name?: unknown })?.name ?? '').trim();
        const userData = app.getPath('userData');
        const hit = readSkill(userData, want);
        if (!hit) {
          const names = listSkills(userData)
            .map((s) => s.name)
            .join(', ');
          return Promise.resolve({
            content: `No skill matches "${want}". Installed: ${names || '(none)'}.`,
            isError: true,
          });
        }
        if ((config.get().disabledSkills ?? []).includes(hit.meta.slug)) {
          return Promise.resolve({
            content: `The skill "${hit.meta.name}" is turned OFF in Settings — not using it.`,
            isError: true,
          });
        }
        return Promise.resolve({ content: hit.content });
      }
      if (name === 'image_generate') {
        // Folder-less chats fall back to the generic folder (Documents\Vo-Coder),
        // not the hidden userData scratch — generated pictures should land where
        // the user can actually find them. Both roots are read-allowed for the
        // inline preview, so this only changes WHERE, never whether it shows.
        return executeImageTool(args, config, secrets, ctxDir() ?? config.get().genericDir, {
          xaiToken: () => xaiOauth.token(),
        }).then((res) => {
          if (res.imagePath) rememberShownInChat(res.imagePath);
          return res;
        });
      }
      if (name === 'payment_spend') {
        // Reaching here means a human already approved it: the gate ahead of
        // this cannot be waived by any mode, mission flag or group allowance.
        return executePaymentTool(args, config, secrets, spendLedger, {
          askedBy:
            (ctx?.sessionId ? projects.meta(ctx.sessionId)?.title : undefined) ?? 'an agent',
        });
      }
      if (name === 'video_generate') {
        return executeVideoTool(
          args,
          config,
          secrets,
          ctxDir() ?? config.get().genericDir, // same generic-folder floor as image_generate
          { xaiToken: () => xaiOauth.token() },
          ctx?.signal,
        );
      }
      if (name === 'look_at_image') {
        return executeLookTool(args, { config, hub }, ctxDir());
      }
      if (GMAIL_TOOL_NAMES.has(name)) {
        return executeGmailTool(name, args, { token: () => googleOAuth.accessToken() });
      }
      // Routed from the SPEC list, not a hand-written set: group_status was
      // advertised to the model and then rejected as unknown, because adding a
      // tool meant remembering to edit this line too. Now it cannot drift.
      if (GROUP_TOOL_NAMES.has(name)) {
        // A group needs its OWN folder: members inherit it and the whole run
        // delivers files into it. The generic scratch folder is for loose
        // single files — a "project" built there is a project nobody can find.
        if (name === 'group_start') {
          const d = ctxDir();
          const generic = config.get().genericDir;
          if (!d || (generic && resolve(d) === resolve(generic))) {
            return Promise.resolve({
              content:
                'A group project needs its OWN project folder — ' +
                (d
                  ? 'this chat only has the generic scratch folder, which holds loose files, not projects'
                  : 'this chat has no folder') +
                '. Either make one with project_create (ask the user WHERE it goes), or tell them ' +
                'to start the chat with "Work in a folder" — NOT the folder button beside the ' +
                'composer, which only points you at a location to look inside. Then call ' +
                'group_start again. Do not start the group without a folder.',
              isError: true,
            });
          }
        }
        // Older groups were spawned dir-less — heal them the moment the
        // coordinator touches the group again, so a live run picks up hands.
        if ((name === 'group_send' || name === 'group_add') && ctx?.sessionId) {
          const live = projects
            .groups()
            .find((g) => !g.endedAt && g.coordinatorId === ctx.sessionId);
          if (live) {
            ensureGroupDirs(live);
            // Proof of DELIVERY for this turn. Writing an assignment table in
            // chat looks like delegating and reaches nobody — the members read
            // their own chats, not the coordinator's. Seating a new member
            // with a task counts the same as sending one.
            coordDispatched.set(live.id, (coordDispatched.get(live.id) ?? 0) + 1);
          }
        }
        return executeGroupTool(name, args, {
          // An agent held by a running mission is not available to be seated:
          // it is one model on one GPU and it already has a job.
          agents: () => {
            const busy = missionsRef?.busyAgents() ?? new Map<string, string>();
            return config.get().agents.filter((a) => !busy.has(a.id));
          },
          hire: hireAutoAgent,
          autoAgentCount: () => config.get().agents.filter(isAutoAgent).length,
          autoAgentMax: () => autoAgentLimit(),
          // The same held agents, by name — so a refused seat names the mission
          // instead of claiming the agent does not exist.
          onMission: () => {
            const busy = missionsRef?.busyAgents() ?? new Map<string, string>();
            return config
              .get()
              .agents.filter((a) => busy.has(a.id))
              .map((a) => ({ name: a.name, mission: busy.get(a.id)! }));
          },
          // Resolve ANY agent by id, unfiltered — a member's card (its memory
          // flag especially) must resolve even after a mission claims that agent
          // or when it is off the seatable roster (Mr Homelab). The brief text
          // is keyed on this, so a lookup miss defaulting to "has memory" would
          // hand a memory-off member instructions for tools it does not have.
          agentById: (id: string) => config.get().agents.find((a) => a.id === id),
          qualityOf: qualityOfAgent,
          createSession: (pid, agentId, title, groupId, dir) =>
            projects.createSession(pid, agentId, title, groupId, dir).id,
          send: (sid, body) => {
            void sessions.send(sid, [{ type: 'text', text: body }], undefined, undefined, {
              echo: true,
            });
          },
          addGroup: (group) => {
            // Did the USER ask for this group? The Group project button sends
            // its planning turn with noRoute, which arms pendingGroupPlans for
            // that session and is still armed while group_start runs. Anything
            // else is Vodo splitting work on his own initiative.
            const asked = !!ctx?.sessionId && pendingGroupPlans.has(ctx.sessionId);
            projects.addGroup(asked ? group : { ...group, auto: true });
            broadcastProjects();
          },
          groups: () => projects.groups(),
          // The group itself becomes a map node — the memory used to hold the
          // members' task nodes with nothing saying they were one project.
          record: (group) => {
            bank?.applyOps(group.projectId, [
              {
                op: 'upsert',
                type: 'task',
                title: `GROUP PROJECT: ${group.goal.slice(0, 70)}`,
                body:
                  `Parallel group of ${group.members.length}:\n` +
                  group.members.map((m) => `- ${m.agentName}: ${m.task.slice(0, 120)}`).join('\n'),
                tags: 'group,parallel',
              },
            ]);
          },
          // Both annotated on purpose: `sessions` is still being inferred at
          // this point (it owns these builtins), so an inferred return type
          // here closes a cycle TypeScript cannot resolve.
          statusOf: (sid: string): string => sessions.statusOf(sid),
          // The tail of what a member actually said — "still working" claimed
          // about an idle member is how a finished group sat parked.
          lastSaid: (sid: string): string => {
            const msgs: HarnessMessage[] = sessions.historyOf(sid);
            for (let i = msgs.length - 1; i >= 0; i--) {
              const m = msgs[i];
              if (!m || m.role !== 'assistant') continue;
              const text = m.content
                .map((p) => (p.type === 'text' ? p.text : ''))
                .join(' ')
                .trim();
              if (text) return text;
            }
            return '';
          },
          warm: (provider, model) => {
            void warmModel(provider, model);
          },
          hasProjectMd: (dir) => projectMdPath(dir) !== null,
          updateGroup: (group) => {
            projects.updateGroup(group);
            broadcastProjects();
          },
        }, ctx?.projectId, ctx?.sessionId, ctxDir());
      }
      if (name === 'preview_open') {
        const dir = ctxDir();
        if (!dir) {
          return Promise.resolve({
            content: 'This chat has no project folder to preview from.',
            isError: true,
          });
        }
        const rel = String((args as { path?: unknown })?.path ?? '').trim();
        const abs = resolve(dir, rel);
        // Same confinement rule as the workspace tools: never outside the dir.
        // insideRoot handles the sibling-prefix escape a bare startsWith missed.
        if (!insideRoot(dir, abs)) {
          return Promise.resolve({ content: 'Path escapes the project folder.', isError: true });
        }
        if (!existsSync(abs)) {
          return Promise.resolve({ content: `No such file: ${rel}`, isError: true });
        }
        // Not an error — the job is done, just not by switching tabs.
        if (shownInChat.has(abs)) {
          return Promise.resolve({
            content: `${rel} is already visible in the chat, under the tool call that made it. Preview left alone.`,
          });
        }
        const opened = preview.openFile(abs);
        if (!opened.ok) {
          return Promise.resolve({ content: opened.error ?? 'Preview failed.', isError: true });
        }
        sendToWindow(IPC.previewShowRequested, {});
        return Promise.resolve({ content: `Preview opened: ${rel}` });
      }
      if (name === 'ask_vodo') {
        return (async () => {
          // Members only. Vodo has no groupId and cannot recurse into itself;
          // missions have no sessionId and get a plain refusal.
          const sessionId = ctx?.sessionId;
          const meta = sessionId ? projects.meta(sessionId) : undefined;
          const group = meta?.groupId
            ? projects.groups().find((g) => g.id === meta.groupId && !g.endedAt)
            : undefined;
          if (!group) {
            return {
              content: 'ask_vodo is for group members — you are the one others ask.',
              isError: true,
            };
          }
          const member = group.members.find((m) => m.sessionId === sessionId);
          const agentName = member?.agentName ?? 'teammate';
          const problem = String((args as { problem?: unknown })?.problem ?? '').trim();
          if (!problem) {
            return { content: 'Describe what you tried and what happened.', isError: true };
          }
          const answer = await vodoStepIn(
            {
              vodoSpec,
              resolve: resolveSpec,
              tools: remoteTools,
              execute: remoteExecute,
              onUsage: (bound, ev, projectId) => recordUsage(bound, ev, projectId),
            },
            { problem, agentName, task: member?.task, dir: ctx?.dir, projectId: ctx?.projectId },
          );
          // The lesson is the learning loop: it lands in the map, the digest
          // carries it to every member's next turn, and the same stumble
          // should not need Vodo twice.
          const lesson = extractLesson(answer);
          if (lesson && bank && ctx?.projectId) {
            bank.applyOps(ctx.projectId, [
              {
                op: 'upsert',
                type: 'fact',
                title: `lesson (${agentName}): ${lesson.slice(0, 80)}`,
                body: lesson.slice(0, 400),
                tags: `lesson,${agentName}`,
              },
            ]);
          }
          journal.append({
            kind: 'tool',
            text: `Vodo stepped in for ${agentName}: ${problem.slice(0, 100)}`,
            ...(projectNameOf(ctx?.projectId) ? { project: projectNameOf(ctx?.projectId)! } : {}),
          });
          return { content: answer };
        })();
      }
      if (name === 'file_identify') return Promise.resolve(executeFileIdTool(args));
      if (name.startsWith('memory_')) return journal.executeTool(name, args);
      if (name.startsWith('archive_') || name.startsWith('map_') || name.startsWith('life_')) {
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
  /**
   * How capable an agent's model is, 1–10 — the SAME scale Auto routing uses,
   * so "strong" means one thing across the app. The catalog answers first;
   * a model it has never seen (a GGUF straight off HuggingFace) falls back to
   * the family/parameter patterns. The "@endpoint" pin is stripped first,
   * because "model@gpu2" is a routing address, not a different model.
   */
  const agentProfile = (
    agent: AgentSpec,
  ): { quality?: number; vision?: boolean; tools?: boolean; image?: boolean } => {
    const pinned = agent.model;
    if (!pinned) return {}; // rides the app default — unknown here
    const at = pinned.lastIndexOf('@');
    const bare = at > 0 ? pinned.slice(0, at) : pinned;
    const rec = catalogSync.find((r) => r.id === bare || r.id === pinned);
    return {
      quality: rec?.quality ?? qualityFor(bare),
      ...(rec?.supportsVision !== undefined ? { vision: rec.supportsVision } : {}),
      ...(rec?.supportsTools !== undefined ? { tools: rec.supportsTools } : {}),
      ...(rec?.outputsImage !== undefined ? { image: rec.outputsImage } : {}),
    };
  };
  const qualityOfAgent = (agent: AgentSpec): number | undefined => agentProfile(agent).quality;

  // Two consecutive failed runs bench a model (30 min) — routing and agent
  // handoffs skip benched models so a broken pick hands the job over instead
  // of failing the same way forever.
  const strikes = new ModelStrikes();
  // Models the endpoint permanently 404s (listed but not served — NVIDIA's
  // free tier does this for pulled models). Learned once, hidden from pickers.
  const dead = new DeadModels(join(app.getPath('userData'), 'dead-models.json'));
  const sessions = new SessionManager({
    config,
    hub,
    mcp,
    projects,
    send: sendToWindow,
    builtins,
    modelCanSee: (modelId) => catalogSync.find((r) => r.id === modelId)?.supportsVision,
    // Usable window: the measured/pinned local window first (what Ollama will
    // actually enforce), else the catalog's length for cloud models.
    modelWindow: (modelId) =>
      contextFit.windowFor(modelId, endpointUrlFor(config.get(), modelId)) ??
      catalogSync.find((r) => r.id === modelId)?.contextLength,
    agentProfile,
    busyAgents: () => missionsRef?.busyAgents() ?? new Map<string, string>(),
    skillsCatalog: () => skillsCatalog(app.getPath('userData'), config.get().disabledSkills ?? []),
    ...(bank
      ? {
          bank: {
            syncSession: (projectId: string, sessionId: string, history: HarnessMessage[]) => {
              bank.syncSession(projectId, sessionId, history);
              // Distill new turns into the map in the background — fail-soft,
              // watermark advances only on success.
              void bank.distillPending(projectId, sessionId, completeCheap);
            },
            digest: (projectId: string, maxChars?: number, query?: string) =>
              bank.digest(projectId, maxChars, query),
            lifeDigest: (maxChars?: number) => bank.lifeDigest(maxChars),
          },
          distill: (projectId: string, sessionId: string) =>
            bank.distillPending(projectId, sessionId, completeCheap),
        }
      : {}),
    onUsage: (sessionId, bound, ev) => {
      const meta = projects.meta(sessionId);
      if (meta) recordUsage(bound, ev, meta.projectId);
    },
    onEvent: (sessionId, event) => {
      // Group follow-through: models reliably STATE the plan and then end the
      // turn without calling group_start — observed twice, with prompts that
      // could not have been clearer. Saying and doing sit on opposite sides of
      // a turn boundary for many models, so the boundary is handled here
      // mechanically: when a planning turn goes idle without a group existing,
      // push exactly one follow-up telling Vodo to call the tool or explicitly
      // decline. One retry, then it stays the user's move.
      if (event.type === 'status' && event.status === 'idle') {
        // The button path arms this through noRoute, but a group asked for in
        // plain chat ("put the team on this") never did — so the whole
        // follow-through below could not fire on the one route users actually
        // take, and a stated plan ended the turn with nothing running. Arm it
        // from the model's own last turn instead of from the entry point.
        // The user stopping the chat outranks every follow-through: a stated
        // plan in a turn the USER killed is not a plan to chase, and nudging
        // it 50ms after the Stop reads as the Stop button not working.
        if (sessions.wasUserStopped(sessionId)) pendingGroupPlans.delete(sessionId);
        if (!pendingGroupPlans.has(sessionId) && statedGroupPlan(sessionId)) {
          pendingGroupPlans.set(sessionId, { retried: false });
        }
        const pending = pendingGroupPlans.get(sessionId);
        if (pending) {
          const started = projects
            .groups()
            .some((g) => !g.endedAt && g.coordinatorId === sessionId);
          if (started || pending.retried) {
            pendingGroupPlans.delete(sessionId);
          } else {
            pending.retried = true;
            // Next tick: this fires mid-event-dispatch, while the session's
            // state machine is still settling into idle — sending now could
            // bounce off a stale "busy".
            setTimeout(() => {
              if (sessions.wasUserStopped(sessionId)) return;
              void sessions.send(sessionId, [
                {
                  type: 'text',
                  text:
                    'You stated the plan but did not call group_start, so nothing has started. ' +
                    'If you meant to split the work, call group_start NOW with exactly the parts ' +
                    'you listed. If you decided the job cannot run in parallel after all, say ' +
                    '"not splitting" and do it yourself.',
                },
              ]);
            }, 50);
          }
        }
      }
      // Teach-to-ask: a weak member that fails the same kind of step twice in
      // a row gets told to escalate instead of retrying blind. The advice is
      // queued mid-run and delivered at the next turn boundary; a success
      // resets the streak.
      if (event.type === 'tool_result' && memberOf(sessionId)) {
        if (event.isError) {
          const n = (memberErrors.get(sessionId) ?? 0) + 1;
          memberErrors.set(sessionId, n);
          if (n === 2) {
            void sessions.inject(sessionId, [
              {
                type: 'text',
                text:
                  'Two tool calls in a row have failed. Stop retrying blind — call ask_vodo now ' +
                  'and describe exactly what you are trying to do, what you called, and the ' +
                  'error. Vodo will do the step or teach you the way, and the lesson is saved ' +
                  'so you can do it yourself next time.',
              },
            ]);
          }
        } else {
          memberErrors.delete(sessionId);
        }
      }
      // Vodo reviews a LOCAL member's work when its turn ends: the strong
      // model judges, the weak model fixes — the self-improving half of "one
      // strong cloud model, the rest local". Alternation guard: the turn that
      // RESPONDS to a review is not itself reviewed, so this converges
      // instead of ping-ponging.
      // A member starting work re-arms the completion driver for the next wave
      // — including a fresh retry budget.
      if (event.type === 'status' && event.status === 'streaming') {
        const info = memberOf(sessionId);
        if (info) {
          groupSynthesisFired.delete(info.group.id);
          groupFinishAttempts.delete(info.group.id);
          // New member work makes the old proof stale — the finish must be
          // proven again after this wave lands.
          coordProofRuns.delete(info.group.id);
        }
      }
      // The coordinator's finishing turn dying (stall abort, provider error,
      // tool-budget pause) must not strand the group one step from done. An
      // error while the finish is in flight flags the group; the coordinator's
      // next idle re-fires the driver with a resume brief (capped attempts).
      // A turn that ends CLEANLY clears the flag — and a user Stop never sets
      // it, so stopping stays stopped.
      {
        const g = projects
          .groups()
          .find((gr) => !gr.endedAt && gr.coordinatorId === sessionId);
        if (g) {
          if (event.type === 'status' && event.status === 'streaming') {
            // New turn: the delivery count starts at zero, so "ended without
            // dispatching" is a fact about THIS turn.
            coordDispatched.set(g.id, 0);
            coordSelfWork.set(g.id, 0);
          } else if (event.type === 'tool_started') {
            // Hands-on tools only: reading/inspecting IS oversight, and the
            // coordination tools are his actual job.
            if (event.name === 'ws_write' || event.name === 'ws_run' || event.name === 'ws_assemble') {
              coordSelfWork.set(g.id, (coordSelfWork.get(g.id) ?? 0) + 1);
            }
            // ws_run doubles as PROOF — the only tool that can show the
            // result actually building, testing, starting.
            if (event.name === 'ws_run') {
              coordProofRuns.set(g.id, (coordProofRuns.get(g.id) ?? 0) + 1);
            }
          } else if (event.type === 'error') {
            // Driver-fired finish → re-fire the driver. A turn the USER
            // started (told Vodo "finish" by hand) has no fired flag — it
            // gets a direct auto-continue instead of dying on the floor.
            if (groupSynthesisFired.has(g.id)) coordStalled.add(g.id);
            else coordUserStalled.add(g.id);
          } else if (event.type === 'done' && event.stopReason !== 'aborted') {
            coordStalled.delete(g.id);
            coordUserStalled.delete(g.id);
            coordContinues.delete(g.id);
          } else if (event.type === 'status' && event.status === 'idle') {
            if (sessions.wasUserStopped(sessionId)) {
              // The user pulled the plug on the coordinator: whatever stall
              // bookkeeping this turn accumulated, resuming now would override
              // the Stop. The group stays as it is until the user speaks.
              coordStalled.delete(g.id);
              coordUserStalled.delete(g.id);
              coordContinues.delete(g.id);
            } else if (coordStalled.has(g.id)) {
              coordStalled.delete(g.id);
              coordUserStalled.delete(g.id);
              groupSynthesisFired.delete(g.id);
              setTimeout(() => {
                if (!sessions.wasUserStopped(sessionId)) maybeFinishGroup(g.id);
              }, 3000);
            } else if (coordUserStalled.delete(g.id)) {
              const n = (coordContinues.get(g.id) ?? 0) + 1;
              coordContinues.set(g.id, n);
              if (n <= 2) {
                setTimeout(() => {
                  if (sessions.wasUserStopped(sessionId)) return;
                  void sessions.send(sessionId, [
                    {
                      type: 'text',
                      text:
                        'Your turn was interrupted mid-work (model stall) — this is an ' +
                        'automatic continue. Pick up EXACTLY where you stopped: ' +
                        'ws_list/ws_read what is already on disk and do not redo it. Write ' +
                        'long files in SEVERAL ws_write calls — first normal, the rest with ' +
                        'append:true — one giant write is what stalls. Delegating the ' +
                        'remainder to a member with group_send also works.',
                    },
                  ]);
                }, 1500);
              }
            } else if (
              // The user's recurring miss: the group "finishes", the report
              // reads done, and the app does not start — because nothing was
              // ever RUN. A closing turn (driver-woken, no dispatches, all
              // members idle) with zero ws_run since the group went quiet is
              // exactly that moment. Said once per group, and only where
              // there is a folder to run anything in.
              groupSynthesisFired.has(g.id) &&
              coordDispatched.get(g.id) === 0 &&
              (coordProofRuns.get(g.id) ?? 0) === 0 &&
              !coordProofNudged.has(g.id) &&
              !!projects.meta(g.coordinatorId!)?.dir &&
              g.members.every((m) => sessions.statusOf(m.sessionId) === 'idle')
            ) {
              coordProofNudged.add(g.id);
              coordDispatched.delete(g.id);
              const attempts = groupFinishAttempts.get(g.id) ?? 0;
              if (attempts < FINISH_ATTEMPTS_MAX) {
                groupFinishAttempts.set(g.id, attempts + 1);
                setTimeout(() => {
                  void sessions.send(g.coordinatorId!, [
                    {
                      type: 'text',
                      text:
                        'THE FINISH WAS NEVER PROVEN. The group is closing but nothing has been ' +
                        'RUN since the members went quiet — not the build, not the tests, not ' +
                        'the app itself. "The files exist" is not tested. Do it now with ' +
                        'ws_run: build and tests first, then actually START the result ' +
                        '(background:true for a server or GUI) and read the output. If the ' +
                        'start fails, the job is NOT done — group_send the fix to the right ' +
                        'member (or seat a fresh specialist with group_add) and prove it again ' +
                        'after. Report done only after a clean run.',
                    },
                  ]);
                }, 1500);
              }
            } else if (
              // ONLY a driver-woken finishing turn is held to this. Otherwise
              // every ordinary reply after the job is done — the user simply
              // chatting with Vodo — would be answered with a demand to
              // dispatch work that does not exist.
              groupSynthesisFired.has(g.id) &&
              coordDispatched.get(g.id) === 0 &&
              g.members.every((m) => sessions.statusOf(m.sessionId) === 'idle')
            ) {
              // The turn ended having DELIVERED nothing — the assignments were
              // written in chat, where no member can read them. Say exactly
              // that, once, instead of another generic "the group is quiet".
              coordDispatched.delete(g.id);
              const attempts = groupFinishAttempts.get(g.id) ?? 0;
              if (attempts < FINISH_ATTEMPTS_MAX) {
                groupFinishAttempts.set(g.id, attempts + 1);
                setTimeout(() => {
                  void sessions.send(g.coordinatorId!, [
                    {
                      type: 'text',
                      text:
                        'NOTHING WAS DELIVERED. Your last turn named who does what, but the ' +
                        'members cannot see this chat — they only ever receive what you send ' +
                        'with group_send, and you called it zero times. Every member is idle ' +
                        'right now, waiting. Call group_send ONCE PER MEMBER with the full ' +
                        'instruction (the exact files, the exact deliverable, where to write ' +
                        'it) — a table in your reply reaches nobody. If there is genuinely ' +
                        'nothing left to hand out, finish the job yourself and report.',
                    },
                  ]);
                }, 1500);
              }
            } else if (groupSynthesisFired.has(g.id)) {
              // The deadlock this group kept hitting: woken to finish, Vodo
              // ANSWERED instead of dispatching ("I'll integrate when they
              // report back") and went idle. Nothing is running, so no member
              // will ever stream — and only a member streaming re-arms the
              // driver. The group sits at 100% done, forever, and the user
              // typing "why don't you start?" changes nothing.
              const quiet = g.members.every(
                (m) => sessions.statusOf(m.sessionId) === 'idle',
              );
              if (quiet) {
                groupSynthesisFired.delete(g.id);
                setTimeout(() => maybeFinishGroup(g.id), 2500);
              }
            } else if (
              // The boss just DID the hands-on work himself on an ordinary
              // (user-initiated) turn while people sat idle. Seen live on a
              // ~800k-token run: the standing "delegate" rule at the top of
              // the prompt loses to hours of in-context precedent, so the
              // correction lands as a MESSAGE — recency wins where position
              // zero cannot. Capped, and a turn that dispatches resets it.
              coordDispatched.get(g.id) === 0 &&
              (coordSelfWork.get(g.id) ?? 0) >= 3 &&
              g.members.some((m) => sessions.statusOf(m.sessionId) === 'idle')
            ) {
              const n = (coordSelfNudges.get(g.id) ?? 0) + 1;
              coordSelfNudges.set(g.id, n);
              if (n <= 2) {
                const idle = g.members
                  .filter((m) => sessions.statusOf(m.sessionId) === 'idle')
                  .map((m) => m.agentName);
                const did = coordSelfWork.get(g.id) ?? 0;
                setTimeout(() => {
                  void sessions.send(g.coordinatorId!, [
                    {
                      type: 'text',
                      text:
                        `YOU JUST DID THE HANDS-ON WORK YOURSELF — ${did} ws_write/ws_run calls ` +
                        `this turn while ${idle.length} member(s) sat idle (${idle.join(', ')}). ` +
                        'You are the coordinator: work like this goes to a member via group_send, ' +
                        'with the exact files and deliverable named. Hand the NEXT step to one of ' +
                        'them now. The only exceptions: no member has the tools, or a member ' +
                        'already failed the step twice — if that is genuinely the case, say which ' +
                        'exception applies and carry on.',
                    },
                  ]);
                }, 1500);
              }
            }
            if ((coordDispatched.get(g.id) ?? 0) > 0) coordSelfNudges.delete(g.id);
          }
        }
      }
      // A MEMBER's turn dying mid-work (stall abort, provider error, the
      // tool-budget "Paused after" check-in) used to end as a red bubble the
      // USER had to act on — "i had to tell him to continue". The boss handles
      // it now: flag here, and the member's idle below tells Vodo, who sends
      // the continue with group_send. A clean stream end clears the flag, and
      // a user Stop emits no error — stopping stays stopped.
      if (memberOf(sessionId)) {
        if (event.type === 'error') memberStalled.add(sessionId);
        else if (event.type === 'done' && event.stopReason !== 'aborted') {
          memberStalled.delete(sessionId);
        }
      }
      if (event.type === 'status' && event.status === 'idle') {
        const info = memberOf(sessionId);
        if (info) {
          memberErrors.delete(sessionId);
          // Interrupted mid-work → the boss gets told and sends the continue.
          // Review is skipped for this idle: judging half-finished work spends
          // a strong-model call on noise. The finish check is skipped too —
          // Vodo's note supersedes it, and the continued member's next clean
          // idle runs the normal path.
          const stalled = memberStalled.delete(sessionId);
          if (stalled) {
            const n = (memberStallNotifies.get(sessionId) ?? 0) + 1;
            memberStallNotifies.set(sessionId, n);
            if (n === 1) {
              // First interruption: just continue — no boss round-trip needed
              // for what one line fixes. Repeats escalate to Vodo below.
              setTimeout(() => {
                void sessions.send(sessionId, [
                  {
                    type: 'text',
                    text:
                      'Your run was interrupted mid-work (model stall) — this is an automatic ' +
                      'continue. Pick up EXACTLY where you stopped: ws_list/ws_read what is ' +
                      'already on disk and do not redo it. If you were writing a long file, ' +
                      'write the REST of it in smaller pieces with ws_write append:true — one ' +
                      'giant write is what stalls.',
                  },
                ]);
              }, 1500);
            } else if (n <= 3 && info.group.coordinatorId) {
              const who = info.member?.agentName ?? info.agent?.name ?? 'a member';
              void sessions.send(info.group.coordinatorId, [
                {
                  type: 'text',
                  text:
                    `MEMBER INTERRUPTED (again): ${who} keeps stalling mid-work — their part ` +
                    `"${(info.member?.task ?? '').slice(0, 80)}" may be half-done. It already ` +
                    'auto-continued once. Check the map/folder, and either group_send ' +
                    `${who} precise smaller steps (chunked ws_write append:true for long ` +
                    'files), or ' +
                    (n >= 3
                      ? 'stop re-sending — reassign the remainder to another member or do ' +
                        'that step yourself now.'
                      : 'reassign the remainder / take the step over if it stalls again.'),
                },
              ]);
            }
          } else {
            // A turn that completed cleanly resets the member's interruption budget.
            memberStallNotifies.delete(sessionId);
          }
          // What the member just said — shared by the question catch and the review.
          const history = sessions.historyOf(sessionId);
          const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
          const outText =
            lastAssistant && lastAssistant.role === 'assistant'
              ? lastAssistant.content
                  .filter((p): p is Extract<(typeof lastAssistant.content)[number], { type: 'text' }> => p.type === 'text')
                  .map((p) => p.text)
                  .join('\n')
                  .trim()
              : '';
          // A member that ends its turn with a question is asking a user who
          // is NOT in its chat — seen live: "should I move on to another
          // task?" hanging forever while the group looked stuck. The BOSS
          // answers: forward the tail to Vodo, who replies with group_send
          // (usually "your part is done — stop", or the decision they need).
          const asksQuestion = outText.replace(/["'*`_)\]\s]+$/g, '').endsWith('?');
          let questionForwarded = false;
          if (!stalled && asksQuestion && info.group.coordinatorId) {
            const n = (memberQuestions.get(sessionId) ?? 0) + 1;
            memberQuestions.set(sessionId, n);
            if (n <= 4) {
              questionForwarded = true;
              const who = info.member?.agentName ?? info.agent?.name ?? 'a member';
              void sessions.send(info.group.coordinatorId, [
                {
                  type: 'text',
                  text:
                    `MEMBER QUESTION: ${who} ended their turn asking, instead of working or ` +
                    `stopping:\n«${outText.slice(-350)}»\n` +
                    `The user is NOT in the members' chats — YOU answer. group_send ${who} the ` +
                    'decision they need, or if their part is complete: "Your part is done — ' +
                    'mark it done in the map and stop." If they keep asking instead of ' +
                    'working, give exact step-by-step instructions or reassign the remainder.',
                },
              ]);
            }
          } else if (!asksQuestion) {
            memberQuestions.delete(sessionId);
          }
          let reviewInitiated = false;
          const provider = info.agent?.provider;
          const local =
            provider === 'ollama' || provider === 'lmstudio' || provider === 'llamacpp';
          if (!stalled && !questionForwarded && local) {
            if (memberReviewFlag.has(sessionId)) {
              memberReviewFlag.delete(sessionId);
            } else {
              // Tiny outputs (acks) are not worth a strong-model pass.
              if (outText.length >= 200) {
                reviewInitiated = true;
                memberReviewFlag.add(sessionId);
                setTimeout(() => {
                  void (async () => {
                    try {
                      const verdict = (
                        await completeStrong(
                          "You are Vodo, reviewing a weaker local model's work on its part of a " +
                            'group project.\n' +
                            `THEIR PART: ${info.member?.task ?? 'unknown'}\n\n` +
                            `THEIR LATEST OUTPUT:\n${outText.slice(0, 6000)}\n\n` +
                            'If the work is solid and on-task, reply with exactly: APPROVED\n' +
                            'Otherwise list at most 5 concrete, minimal fixes as bullets — ' +
                            'things THEY can do themselves. No praise, no rewriting it for them.',
                        )
                      ).trim();
                      if (/^APPROVED\b/i.test(verdict)) {
                        memberReviewFlag.delete(sessionId);
                        // Approval may have been the last open question — the
                        // finish check runs from here, not from the idle that
                        // preceded the review.
                        maybeFinishGroup(info.group.id);
                        return;
                      }
                      void sessions.send(sessionId, [
                        {
                          type: 'text',
                          text:
                            'VODO REVIEW of your last output — address these, and only mark your ' +
                            'task done when they are fixed:\n\n' +
                            verdict.slice(0, 2000),
                        },
                      ]);
                    } catch {
                      memberReviewFlag.delete(sessionId);
                      // A failed review must not leave the group stranded.
                      maybeFinishGroup(info.group.id);
                    }
                  })();
                }, 100);
              }
            }
          }
          // No review in flight for this idle → this member may have been the
          // last one working; see if the whole group is quiet now. A forwarded
          // question suppresses it — Vodo's answer restarts the wave anyway.
          if (!stalled && !questionForwarded && !reviewInitiated) maybeFinishGroup(info.group.id);
        }
      }
      // Routing self-heal: 2 consecutive failed runs bench the model so the
      // next route tries a different one (deprecated ids, dead endpoints).
      // The tool-budget check-in ("Paused after…") is a pause, not a failure.
      if (event.type === 'error' && !event.error.message.startsWith('Paused after')) {
        const bound = sessions.boundOf(sessionId);
        if (bound) {
          strikes.fail(bound.provider.id, bound.model, event.error.message);
          // 404 model-not-found is deterministic — the endpoint does not serve
          // this model at all. Hide it from the pickers from now on.
          if (event.error.status === 404 || /not available on this endpoint/i.test(event.error.message)) {
            dead.markDead(bound.provider.id, bound.model);
          }
        }
      } else if (event.type === 'done' && event.stopReason !== 'aborted') {
        const bound = sessions.boundOf(sessionId);
        if (bound) {
          strikes.ok(bound.provider.id, bound.model);
          dead.revive(bound.provider.id, bound.model);
        }
      }
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

  registerHandler(IPC.usageGet, () => usage.get());
  registerHandler(IPC.xaiOauthStatus, () => xaiOauth.status());
  registerHandler(IPC.xaiOauthBegin, () => xaiOauth.begin());
  registerHandler(IPC.xaiOauthSignOut, () => {
    xaiOauth.signOut();
    invalidateXaiLiveIds();
  });
  registerHandler(IPC.googleOauthStatus, () => googleOAuth.status());
  registerHandler(IPC.googleOauthBegin, () => googleOAuth.begin());
  registerHandler(IPC.googleOauthSignOut, () => googleOAuth.signOut());

  // ---- projects & chat sessions ----
  /**
   * The sidebar view, with the collab workspace swept first.
   *
   * Swept here rather than inside list(): list() runs on every broadcast, and
   * re-reading a directory on each one would turn a chat event into disk work.
   * A folder dropped into the workspace by hand appears the next time the
   * projects view is asked for, which is the moment anybody could notice it.
   */
  const listProjects = () => {
    const root = config.get().collabRoot;
    projects.syncCollabWorkspace(root);
    const data = projects.list();
    return {
      ...data,
      // Derived, never stored — a project is collab because of where it is.
      projects: data.projects.map((p) => ({ ...p, collab: projects.isCollab(p, root) })),
    };
  };
  const broadcastProjects = () => sendToWindow(IPC.projectsChanged, listProjects());
  registerHandler(IPC.projectsList, () => listProjects());
  registerHandler(IPC.projectCreate, (_e, name: string, dir?: string) => {
    const project = projects.createProject(name, dir);
    journal.append({ kind: 'project', text: `created project "${name}"` });
    broadcastProjects();
    return project;
  });
  registerHandler(IPC.projectCreateIn, (_e, parentDir: string, name: string) => {
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
  registerHandler(IPC.projectOpenExisting, (_e, dir: string) => {
    try {
      const resolved = resolve(dir);
      if (!existsSync(resolved)) return { ok: false, error: 'That folder does not exist.' };
      // Same path already registered — reopen instead of duplicating.
      const existing = projects.list().projects.find(
        (p) => p.dir && resolve(p.dir).toLowerCase() === resolved.toLowerCase(),
      );
      if (existing) {
        journal.append({
          kind: 'project',
          text: `reopened existing project "${existing.name}"`,
          project: existing.name,
        });
        broadcastProjects();
        return { ok: true, project: existing, created: false };
      }
      const base = resolved.split(/[\\/]/).filter(Boolean).pop() || 'Project';
      const project = projects.createProject(base, resolved);
      journal.append({
        kind: 'project',
        text: `opened existing folder as project "${project.name}"`,
        project: project.name,
      });
      broadcastProjects();
      return { ok: true, project, created: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  registerHandler(IPC.projectDelete, (_e, id: string) => {
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
  registerHandler(IPC.projectSetDir, (_e, id: string, dir: string) => {
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
  registerHandler(IPC.sessionCreate, (_e, projectId: string, agentId?: string) => {
    // Mr Homelab's project is created on demand — his tab is the only door.
    if (projectId === HOMELAB_PROJECT_ID) projects.ensureHomelab();
    const meta = projects.createSession(projectId, agentId);
    broadcastProjects();
    return meta;
  });
  registerHandler(IPC.sessionOpen, (_e, sessionId: string) => {
    const meta = projects.meta(sessionId);
    if (!meta) throw new Error(`Unknown chat session "${sessionId}".`);
    return { meta, history: sessions.historyOf(sessionId) };
  });
  registerHandler(IPC.sessionDelete, (_e, sessionId: string) => {
    sessions.dropLive(sessionId);
    projects.deleteSession(sessionId);
    broadcastProjects();
  });
  registerHandler(IPC.sessionRename, (_e, sessionId: string, title: string) => {
    projects.renameSession(sessionId, title);
    broadcastProjects();
  });
  // Delete a whole group project in one act: every member chat, the
  // coordinator chat, and the group record — the sidebar clean-up that used
  // to be nine × clicks.
  registerHandler(IPC.groupDelete, (_e, groupId: string) => {
    const group = projects.groups().find((g) => g.id === groupId);
    // The record can be gone while its chats remain (legacy runs, drift).
    // The sweep by session groupId is what guarantees the bundle really
    // dies — the stored member list alone misses orphans.
    const ids = new Set<string>([
      ...(group?.members.map((m) => m.sessionId) ?? []),
      ...(group?.coordinatorId ? [group.coordinatorId] : []),
      ...projects
        .list()
        .sessions.filter((m) => m.groupId === groupId)
        .map((m) => m.id),
    ]);
    for (const id of ids) {
      // A member may be mid-stream — stop it so no zombie run outlives its chat.
      sessions.stop(id);
      sessions.dropLive(id);
      projects.deleteSession(id);
    }
    projects.removeGroup(groupId);
    groupSynthesisFired.delete(groupId);
    groupFinishAttempts.delete(groupId);
    coordStalled.delete(groupId);
    coordSelfWork.delete(groupId);
    coordSelfNudges.delete(groupId);
    coordProofRuns.delete(groupId);
    coordProofNudged.delete(groupId);
    broadcastProjects();
  });
  registerHandler(IPC.sessionSetAgent, (_e, sessionId: string, agentId: string) => {
    sessions.setAgent(sessionId, agentId);
    broadcastProjects();
  });
  // Point this chat at any folder (or detach with null). Takes effect on the
  // next send — specs and tool mounts re-derive from the meta every turn.
  registerHandler(IPC.sessionSetDir, (_e, sessionId: string, dir: string | null) => {
    try {
      projects.setSessionDir(sessionId, dir);
      // ONE FOLDER ↔ ONE PROJECT. Binding a chat to a real folder REHOMES the
      // chat into the project that owns that folder (created from the folder's
      // name when none does), and its memory-bank record follows. Seen live
      // without this: a chat left in the old app's project was bound to a
      // fresh folder, the shared briefing still led with the OLD app's tasks,
      // and Vodo went back to building the old app. Group-tied and Homelab
      // chats stay put — their machinery pins them — and the generic scratch
      // folder never becomes a project.
      if (dir) {
        const gen = config.get().genericDir;
        const isGeneric = !!gen && resolve(dir).toLowerCase() === resolve(gen).toLowerCase();
        const meta = projects.meta(sessionId);
        const groupTied =
          !!meta?.groupId || projects.groups().some((g) => g.coordinatorId === sessionId);
        const pinned = meta?.projectId === HOMELAB_PROJECT_ID;
        if (meta && !isGeneric && !groupTied && !pinned) {
          const target = projects.projectForDir(dir);
          if (target.id !== meta.projectId && projects.moveSession(sessionId, target.id)) {
            bank?.moveSession(sessionId, target.id);
            journal.append({
              kind: 'project',
              text: `chat rehomed to "${target.name}" — bound to its folder`,
              project: target.name,
            });
          }
        }
      }
      broadcastProjects();
      return { ok: true as const };
    } catch (err) {
      // Never reject silently — the renderer surfaces this so the picker can't
      // "do nothing". (Historically config.get() could throw here when Documents
      // failed to resolve on a fresh Windows/OneDrive profile.)
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
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

  // One folder ↔ one project. Rows made before that invariant existed (every
  // Telegram-dispatched task minted its own) are merged into the oldest one:
  // chats and groups are re-parented, nothing is deleted, projects.json is
  // backed up first.
  for (const m of projects.mergeDuplicateDirs()) {
    for (const sessionId of m.sessionIds) bank?.moveSession(sessionId, m.keptId);
    console.log(
      `[projects] merged ${m.merged.length} duplicate(s) of "${m.keptName}" ` +
        `(${m.sessionIds.length} chats moved)`,
    );
    journal.append({
      kind: 'project',
      text: `merged ${m.merged.length} duplicate project(s) into "${m.keptName}" — ${m.sessionIds.length} chats`,
      project: m.keptName,
    });
  }

  // Reconnect configured MCP servers on startup (fire and forget; status shows in UI).
  for (const cfg of config.get().mcpServers) {
    void mcp.connect(cfg);
  }

  registerHandler(IPC.getConfig, () => config.get());
  registerHandler(IPC.setConfig, (_e, patch: Partial<AppConfig>) => {
    const next = config.set(patch);
    if ('telegramEnabled' in patch || 'telegramPaired' in patch) telegramRef?.sync();
    return next;
  });
  registerHandler(IPC.setSecret, (_e, provider: string, value: string) => {
    secrets.set(provider, value);
    if (provider === 'telegram') telegramRef?.sync();
    return secrets.status();
  });
  registerHandler(IPC.secretStatus, () => secrets.status());
  // Loading a local model reads gigabytes off disk — a minute of silence
  // before the first token. Starting that when the user PICKS the agent, not
  // when they send, hides it behind their typing. Best-effort by design: a
  // sleeping box or an unknown model must never surface an error here.
  /** Who Vodo handed each conversation to lately — breaks routing ties only. */
  const recentAgents = new Map<string, string[]>();
  /** Planning turns awaiting their group_start call — see onEvent. */
  const pendingGroupPlans = new Map<string, { retried: boolean }>();
  /** "I'm calling group_start…" as intent, not as a mention of the tool. */
  const INTENDS_GROUP_START =
    /\b(?:now|next|then|let me|i'?ll|i'?m|going to|about to|ready to|will|use|using|call|calling|start|starting)\b[^.\n]{0,60}group_start/i;
  /**
   * Did the newest assistant turn SAY it was splitting the job? Read off the
   * model's own words because the intent can arrive by any route — the Group
   * project button, or simply asking Vodo to put the team on something — and
   * only the button ever set a flag up front. A turn that actually emitted the
   * call is not a plan awaiting one: it either started a group (caught by the
   * `started` check) or was declined, and re-nudging a declined call would
   * argue with the user's own answer.
   */
  const statedGroupPlan = (sessionId: string): boolean => {
    const history = sessions.historyOf(sessionId);
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (m.role !== 'assistant') continue;
      if (m.content.some((p) => p.type === 'tool_call' && p.name === 'group_start')) return false;
      const text = m.content
        .map((p) => (p.type === 'text' || p.type === 'thinking' ? p.text : ''))
        .join('\n');
      // The escape hatch the nudge itself offers has to be honoured here too.
      if (/\bnot splitting\b/i.test(text)) return false;
      return INTENDS_GROUP_START.test(text);
    }
    return false;
  };
  /** Consecutive failed tool calls per group member — 2 in a row earns a nudge. */
  const memberErrors = new Map<string, number>();
  /** Members whose next idle is the RESPONSE to a review — reviewed work, not re-reviewed. */
  const memberReviewFlag = new Set<string>();
  /** Groups whose finish prompt has been sent for the current work wave. */
  const groupSynthesisFired = new Set<string>();
  /** Finish attempts this wave — a dying coordinator model must not loop forever. */
  const groupFinishAttempts = new Map<string, number>();
  const FINISH_ATTEMPTS_MAX = 3;
  /** Groups whose finishing turn hit an error (stall abort, tool-budget pause). */
  const coordStalled = new Set<string>();
  /** Coordinator turns the USER started that died — auto-continued directly. */
  const coordUserStalled = new Set<string>();
  /** Direct coordinator continues per group — capped; a clean turn resets. */
  const coordContinues = new Map<string, number>();
  /** group_send calls the coordinator actually made during its current turn. */
  const coordDispatched = new Map<string, number>();
  /** ws_write/ws_run/ws_assemble calls the coordinator made himself this turn. */
  const coordSelfWork = new Map<string, number>();
  /** Self-work corrections sent per group — capped; a dispatching turn resets. */
  const coordSelfNudges = new Map<string, number>();
  /**
   * ws_run calls since the group last went quiet — the PROOF counter. Cleared
   * whenever a member streams again (new work makes old proof stale), NOT per
   * coordinator turn: proof from an earlier finishing turn still counts.
   */
  const coordProofRuns = new Map<string, number>();
  /** Groups already told their finish was never proven — once, ever. */
  const coordProofNudged = new Set<string>();
  /** Members whose current turn hit an error — their idle goes to the boss, not the user. */
  const memberStalled = new Set<string>();
  /** Stall notes sent to Vodo per member — capped so a dying model cannot spam the boss. */
  const memberStallNotifies = new Map<string, number>();
  /** Trailing-question forwards per member — capped; a working turn resets it. */
  const memberQuestions = new Map<string, number>();
  /**
   * Members of groups created before dirs were inherited have no workspace —
   * copy the coordinator's folder onto any member still missing one, so a
   * live group heals without being restarted.
   */
  const ensureGroupDirs = (group: { coordinatorId?: string; members: Array<{ sessionId: string }> }): void => {
    const coordDir = group.coordinatorId ? projects.meta(group.coordinatorId)?.dir : undefined;
    if (!coordDir) return;
    for (const m of group.members) {
      if (!projects.meta(m.sessionId)?.dir) projects.setSessionDir(m.sessionId, coordDir);
    }
  };
  /**
   * The completion driver. Members finish, mark their tasks done, and go
   * idle — and an idle coordinator cannot "wait for their briefs": nothing
   * ever wakes it, so the group used to stall at 100% done with the final
   * deliverable never assembled. When the LAST member goes quiet, this wakes
   * the coordinator with the finishing brief: verify, assemble, preview,
   * self-review, report. Re-arms whenever a member starts working again.
   */
  const maybeFinishGroup = (groupId: string): void => {
    if (groupSynthesisFired.has(groupId)) return;
    const attempts = groupFinishAttempts.get(groupId) ?? 0;
    if (attempts >= FINISH_ATTEMPTS_MAX) return;
    const group = projects.groups().find((g) => g.id === groupId && !g.endedAt);
    if (!group || !group.coordinatorId) return;
    // Every route into this driver — member idles, stall recovery, timers —
    // stands down while the user's Stop on the coordinator is in force. The
    // group resumes when the user speaks to Vodo again (send clears the flag).
    if (sessions.wasUserStopped(group.coordinatorId)) return;
    ensureGroupDirs(group);
    if (!group.members.every((m) => sessions.statusOf(m.sessionId) === 'idle')) return;
    if (sessions.statusOf(group.coordinatorId) !== 'idle') return;
    groupSynthesisFired.add(groupId);
    groupFinishAttempts.set(groupId, attempts + 1);
    // The coordinator is usually Vodo (memory on), but a memory-off agent can
    // start a group and hold this seat. Naming map_query/map_update to one that
    // has no map tools is a false instruction — and the runTool gate now
    // refuses the call anyway — so the brief must match its tools, exactly as
    // memberBrief already does for members.
    const coordAgentId = projects.meta(group.coordinatorId)?.agentId;
    const coordHasMemory =
      !coordAgentId ||
      coordAgentId === 'default' ||
      config.get().agents.find((a) => a.id === coordAgentId)?.memory !== false;
    const brief =
      attempts === 0
        ? 'THE GROUP IS QUIET — every member is idle. You are the coordinator: the job is NOT ' +
          'finished until the final deliverable exists, is verified, and is shown. You DELEGATE ' +
          '— you do member-level work yourself only when no member can. Members CANNOT read ' +
          'this chat: an assignment only exists once group_send has carried it. Now:\n' +
          (coordHasMemory
            ? '1. map_query the task nodes and ws_list the folder — check what each part actually '
            : '1. ws_list the folder — check what each part actually ') +
          'delivered as FILES, not as chat text.\n' +
          '2. Work that is missing, wrong, or still unassembled goes to a MEMBER via ' +
          'group_send: send a broken part back to its owner with a concrete fix list; hand the ' +
          'assembly (merge the parts into the final deliverable, exact output file named) to ' +
          'your most capable member. When the parts are block files, the assembly is ONE ' +
          'ws_assemble call in blueprint order — nobody re-types blocks by hand. One member ' +
          'can hold several follow-ups, but send each as its own group_send.\n' +
          '2b. IDLE MEMBERS ARE SPARE CAPACITY: spread the remaining work across them — one ' +
          'group_send each — instead of stacking several jobs on one member or doing them ' +
          'yourself. Small jobs count: verifying a file, updating a doc, running a check. ' +
          'Queued parts from the start go out now too. If the work needs a specialty nobody ' +
          'seated has, group_add brings another roster agent in with their first task.\n' +
          '3. Then STOP and wait — you are woken again when the group goes quiet. Never claim ' +
          'members are "still working" without calling group_status: an idle member is waiting ' +
          'for YOU, and waiting for someone who is already finished parks the whole job. On each ' +
          'wake: review what came back with ws_read, group_send fixes if needed (at most two ' +
          'rounds per member), and only take a step over yourself if a member has failed it ' +
          'twice or lacks the tools.\n' +
          '4. PROVE IT BEFORE YOU CALL IT DONE. Run what the project runs, with ws_run: the ' +
          'build, the tests, and the actual START of the app or entry point (background:true ' +
          'for a server/GUI) — then read the output. Files existing is not tested; a ' +
          'deliverable that never ran is not done. A failed run means the group is NOT ' +
          'finished: dispatch the fix and prove it again.\n' +
          '5. Only after a clean run: open the deliverable with preview_open, then WRITE THE ' +
          'REPORT INTO THIS CHAT. You are the only one the user reads: pointing at a file ' +
          '("the summary is in REPORT.md", "see the assessment folder") makes them go hunting ' +
          'for something you could have said. Read what the members produced and give ONE ' +
          'account in your reply — what was built and where it lives, what each part ' +
          'contributed, what you RAN and what it printed, what is still open, what to look at ' +
          'first. Long is fine; a link to a file instead of the answer is not.\n' +
          '6. Then clear the desk. ' +
          (coordHasMemory
            ? 'Anything from those notes that matters LATER goes into the ' +
              'memory map with map_update (decisions, gotchas, what broke and why) — the map is ' +
              'what survives; the notes are not. Mark the GROUP PROJECT task node done, then call ' +
              'team_clean to throw away the scratch under .vodo/team/. Blueprints, block files and ' +
              'member reports are coordination leftovers: once the work is summarised and the ' +
              'lessons are in the map, they are clutter in the user\'s project.'
            : 'Everything worth keeping is in the report you just wrote — you carry no project ' +
              'map. Then call team_clean to throw away the scratch under .vodo/team/: blueprints, ' +
              'block files and member reports are coordination leftovers, clutter in the user\'s ' +
              'project once the work is summarised.')
        : 'THE GROUP IS STILL QUIET AND THE JOB IS STILL NOT DONE. Every member is idle — ' +
          'nobody is working, so nobody will report back to you, and saying you will wait ' +
          'parks the job forever. Check the facts first (group_status for who is running, ' +
          'ws_list for what is on disk), then either group_send the remaining work to a NAMED ' +
          'member right now, or do the last step yourself. The job is not done until the ' +
          'result actually RAN clean under ws_run — build, tests, start. Finish by opening ' +
          'the result with preview_open, ' +
          (coordHasMemory
            ? 'marking the group task node done with map_update, '
            : '') +
          'and reporting IN THIS CHAT what exists, where, and what it printed when you ran it — ' +
          'the account itself, not a filename to go and read. ' +
          (coordHasMemory
            ? 'Put anything worth keeping in the memory map, then team_clean the scratch under .vodo/team/.'
            : 'Then team_clean the scratch under .vodo/team/.');
    setTimeout(() => {
      void sessions.send(group.coordinatorId, [{ type: 'text', text: brief }]);
    }, 200);
  };
  /** This session's live group membership, or undefined. */
  const memberOf = (sessionId: string) => {
    const meta = projects.meta(sessionId);
    const group = meta?.groupId
      ? projects.groups().find((g) => g.id === meta.groupId && !g.endedAt)
      : undefined;
    if (!group || !meta) return undefined;
    return {
      group,
      member: group.members.find((m) => m.sessionId === sessionId),
      agent: config.get().agents.find((a) => a.id === meta.agentId),
    };
  };
  const warming = new Set<string>();
  const warmModel = async (providerId: string, model: string): Promise<void> => {
    const key = `${providerId}/${model}`;
    if (warming.has(key)) return;
    const provider = hub.registry().get(providerId);
    if (!provider?.warm) return;
    warming.add(key);
    try {
      await provider.warm(model);
      // The model is resident right now, which is the only moment its real
      // cache cost is observable — /api/ps reports nothing about a model that
      // is not loaded. Measure here or not at all.
      if (provider.measure) {
        const cfg = config.get();
        const url = endpointUrlFor(cfg, model);
        const chosen = contextFit.record(
          model,
          url,
          await provider.measure(model),
          Date.now(),
          endpointVramBytes(cfg, model),
        );
        if (chosen) console.log(`[fit] ${model} → ${chosen} tokens on ${url}`);
      }
    } catch {
      /* the real request will report anything that matters */
    } finally {
      warming.delete(key);
    }
  };
  registerHandler(IPC.modelWarm, (_e, providerId: string, model: string) =>
    warmModel(providerId, model),
  );
  // A group project: one goal, several agents, side by side in one project.
  // Members are ordinary sessions, so they archive and distil like any chat —
  // and because the digest is project-scoped and leads with active task nodes,
  // each member sees what the others are in the middle of without any
  // message-passing between them.
  //
  // There is no "start a group" IPC on purpose. A group is only ever started
  // by Vodo calling group_start, so the split is planned by the strong model
  // that has the project's folder, memory map and tools — in the thread, where
  // the user can see it and argue with it — instead of invisibly by whichever
  // model happened to be cheapest.
  registerHandler(IPC.groupList, () => projects.groups());
  registerHandler(IPC.groupEnd, (_e, groupId: string) => {
    // Ending a run STOPS it. endGroup only stamped a timestamp, so members
    // mid-turn carried on writing files and burning a GPU each while the user
    // watched a group they had already closed — "end" has to mean end. The
    // transcripts stay: stopping a turn is not deleting the chat.
    const group = projects.groups().find((g) => g.id === groupId);
    for (const member of group?.members ?? []) sessions.stop(member.sessionId);
    projects.endGroup(groupId);
    broadcastProjects();
    return projects.groups();
  });
  registerHandler(IPC.listModels, async (_e, providerId: string) => {
    const provider = hub.registry().get(providerId);
    if (!provider) {
      const disabled = (config.get().disabledProviders ?? [])
        .map((p) => p.toLowerCase())
        .includes(providerId.toLowerCase());
      const isXai = providerId.toLowerCase() === 'xai';
      throw new Error(
        disabled
          ? `Provider "${providerId}" is turned off — enable it in Settings → API keys.`
          : isXai
            ? 'Provider "xai" is not configured — add an API key or Sign in with X (Grok login) in Settings.'
            : `Provider "${providerId}" is not configured — add its API key in Settings.`,
      );
    }
    // Live /v1/models first. For every configured provider, merge curated catalog
    // chat/vision models so pickers stay populated when the endpoint is sparse
    // or briefly fails (common with Grok login). Pure image-gen seeds stay out —
    // those belong only in Settings → Image model.
    let live: Awaited<ReturnType<typeof provider.listModels>> = [];
    try {
      live = await provider.listModels();
    } catch (err) {
      if (providerId.toLowerCase() !== 'xai') throw err;
      // Grok OAuth can briefly 401 while tokens refresh — fall back to seed.
    }
    const byId = new Map(live.map((m) => [m.id, m]));
    try {
      const { records } = await getCatalog();
      for (const r of records) {
        if ((r.provider ?? '').toLowerCase() !== providerId.toLowerCase()) continue;
        // Skip pure image generators (no vision/tools/chat tags).
        const tags = r.tags ?? [];
        const pureImage =
          r.outputsImage === true &&
          r.supportsVision !== true &&
          r.supportsTools !== true &&
          (tags.length === 0 || tags.every((t) => t === 'image-gen' || t === 'image'));
        if (pureImage) continue;
        if (!byId.has(r.id)) {
          byId.set(r.id, {
            id: r.id,
            provider: providerId,
            displayName: r.displayName ?? r.id,
            contextLength: r.contextLength,
            supportsTools: r.supportsTools,
            supportsVision: r.supportsVision,
            supportsThinking: r.supportsThinking,
          });
        } else {
          const cur = byId.get(r.id)!;
          byId.set(r.id, {
            ...cur,
            displayName: cur.displayName ?? r.displayName ?? r.id,
            contextLength: cur.contextLength ?? r.contextLength,
            supportsTools: cur.supportsTools ?? r.supportsTools,
            supportsVision: cur.supportsVision ?? r.supportsVision,
            supportsThinking: cur.supportsThinking ?? r.supportsThinking,
          });
        }
      }
    } catch {
      /* catalog optional — live list alone is fine */
    }
    // Listed-but-not-served models (learned from 404s) stay out of the pickers.
    return dead.filter(providerId, [...byId.values()]);
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

  registerHandler(
    IPC.chatSend,
    async (
      _e,
      sessionId: string,
      parts: UserPart[],
      override?: { provider?: string; model?: string },
      opts?: { noRoute?: boolean },
    ) => {
      const invalid = validateParts(parts);
      if (invalid) return { ok: false, error: invalid };
      // What the person actually typed — captured before the group-aware code
      // below appends steering notes to `parts`. Only THIS is echoed.
      const typedParts = [...parts];
      // noRoute is only ever the group-planning turn (the button) — arm the
      // follow-through watchdog for it.
      if (opts?.noRoute) pendingGroupPlans.set(sessionId, { retried: false });
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
      // The coordinator seat of a live group is Vodo BY DEFINITION — the user
      // types "retry" there to continue the finish, and routing that to a
      // 12B local agent hands the whole assembly to the weakest model in the
      // fleet. Seen live. A coordinator never routes while its group runs.
      const liveGroupHere = projects
        .groups()
        .find((g) => !g.endedAt && g.coordinatorId === sessionId);
      const isLiveCoordinator = !!liveGroupHere;
      // The user prodding a parked group ("why don't you start?") re-arms the
      // completion driver. Without this the finish fires once per wave and a
      // coordinator that answered instead of delegating can never be woken
      // again — nothing the user types brings the group back.
      if (liveGroupHere && liveGroupHere.members.every((m) => sessions.statusOf(m.sessionId) === 'idle')) {
        groupSynthesisFired.delete(liveGroupHere.id);
        groupFinishAttempts.delete(liveGroupHere.id);
      }
      // The delegation rule travels WITH the user's message. On a marathon
      // coordinator chat (~800k tokens seen live) the standing system-prompt
      // rule is buried under hours of pre-rule precedent of Vodo working
      // hands-on — and the model follows the precedent. A short note at the
      // very end of the request is the one position history cannot bury.
      // Appended AFTER history, so provider prompt caching keeps its prefix.
      // "Use ALL the agents" is an explicit ask that must not shrink to
      // however many parts Vodo happened to think of. Detected from the
      // user's own words and answered in the same recency position — with
      // the concrete names, because "use more agents" without names reads
      // as satisfied by any two.
      const wholeTeamAsk =
        /\b(all|every)\s+(the\s+|your\s+|of\s+the\s+)?agents?\b|\bwhole\s+team\b|\buse\s+everyone\b|\ball\s+of\s+them\b/i.test(
          parts
            .filter((p): p is Extract<UserPart, { type: 'text' }> => p.type === 'text')
            .map((p) => p.text)
            .join(' '),
        );
      // "Everyone" cannot include an agent a mission is already holding — it is
      // one model on one GPU. Naming it here would have Vodo try to seat it,
      // and the seat is refused downstream; the held ones are listed separately
      // so he can say why the team is short rather than appear to skip someone.
      const onMissionNow = missionsRef?.busyAgents() ?? new Map<string, string>();
      const heldNote = (): string => {
        const held = config
          .get()
          .agents.filter((ag) => ag.enabled !== false && onMissionNow.has(ag.id))
          .map((ag) => `${ag.name} (mission: ${onMissionNow.get(ag.id)})`);
        return held.length
          ? ` ${held.join(', ')} ${held.length > 1 ? 'are' : 'is'} on a mission and cannot be ` +
            'seated — say so rather than counting them in.'
          : '';
      };
      if (liveGroupHere && !opts?.noRoute) {
        const idleNames = liveGroupHere.members
          .filter((m) => sessions.statusOf(m.sessionId) === 'idle')
          .map((m) => m.agentName);
        const unseated = wholeTeamAsk
          ? config
              .get()
              .agents.filter(
                (ag) =>
                  ag.enabled !== false &&
                  ag.id !== HOMELAB_AGENT_ID &&
                  !onMissionNow.has(ag.id) &&
                  !liveGroupHere.members.some((m) => m.agentId === ag.id),
              )
              .map((ag) => ag.name)
          : [];
        if (idleNames.length > 0 || unseated.length > 0) {
          const idleNote =
            idleNames.length > 0
              ? `\n[group: ${idleNames.length} of ${liveGroupHere.members.length} members idle — ` +
                `${idleNames.slice(0, 4).join(', ')}${idleNames.length > 4 ? ', …' : ''}. If this ` +
                'request is work, group_send it to one of them with the full instruction instead ' +
                'of doing it yourself; group_status shows the whole board.'
              : '\n[group:';
          const teamAsk = wholeTeamAsk
            ? ' The user asked for the WHOLE TEAM: give every idle member a part (one ' +
              'group_send each)' +
              (unseated.length > 0
                ? `, and seat the unused roster agents with group_add — ${unseated.join(', ')}`
                : '') +
              ' — or say, agent by agent, why there is nothing useful for them.' +
              heldNote()
            : '';
          parts = [...parts, { type: 'text', text: `${idleNote}${teamAsk}]` }];
        }
      } else if (
        wholeTeamAsk &&
        !opts?.noRoute &&
        projectDir &&
        projectDir !== config.get().genericDir
      ) {
        // No group yet: the whole-team ask shapes the SPLIT — one part per
        // enabled agent, before group_start is even called.
        const roster = config
          .get()
          .agents.filter(
            (ag) =>
              ag.enabled !== false && ag.id !== HOMELAB_AGENT_ID && !onMissionNow.has(ag.id),
          )
          .map((ag) => ag.name);
        if (roster.length >= 2) {
          parts = [
            ...parts,
            {
              type: 'text',
              text:
                `\n[the user asked for the WHOLE TEAM — ${roster.length} agents free right now: ` +
                `${roster.join(', ')}. Plan the split so EVERY one of them gets a part: ` +
                `group_start with ${roster.length} parts (extra parts queue safely, and ` +
                'group_add can seat anyone missed later) — or say, agent by agent, why there ' +
                `is no useful part for them.${heldNote()}]`,
            },
          ];
        }
      }
      // The PROJECT GATE: the one-time senior-dev brake. A folder that has
      // quietly grown into a real development project — many code files, no
      // git, no VO-CODER.md — gets ONE conversational intervention. The note
      // rides the user's message (the position history cannot bury), the
      // agent turns it into a talk instead of a questionnaire, and what is
      // agreed lands in VO-CODER.md. Offered is persisted BEFORE the turn
      // runs: whatever the user decides, the brake never taps twice.
      if (projectDir && projectDir !== config.get().genericDir && !liveGroupHere && !opts?.noRoute) {
        const offered = config.get().projectGateOffered;
        const seen = new Set(offered.map((p) => p.toLowerCase()));
        if (!seen.has(projectDir.toLowerCase())) {
          const crossed = projectGate(projectDir);
          if (crossed) {
            config.set({ projectGateOffered: [...offered, projectDir].slice(-300) });
            parts = [
              ...parts,
              { type: 'text', text: gateNudge(crossed.codeFiles, crossed.capped) },
            ];
          }
        }
      }
      // "/skill-name do X" — the user summoning a skill by name. The catalog
      // in the system prompt leaves the choice to the agent; typing the name
      // takes that choice back, so the instruction rides the message where
      // history cannot bury it. An unknown or switched-off name is left alone.
      const skillCall = (() => {
        const first = parts.find(
          (p): p is Extract<UserPart, { type: 'text' }> => p.type === 'text',
        );
        if (!first) return null;
        return parseSkillCall(app.getPath('userData'), config.get().disabledSkills, first.text);
      })();
      if (skillCall) parts = [...parts, { type: 'text', text: skillCallNote(skillCall) }];
      // "Generate an image of X": the answer is a picture, and the picture comes
      // from the configured image model no matter who holds the turn — the chat
      // model only has to call image_generate. Routing can only pick a WORSE
      // tool caller here (cheapest-capable and agent ties both favour the local
      // fleet, which is how a banana request landed on gemma4:12b and stalled),
      // so the turn stays on the model the user picked.
      const imageTurn = (() => {
        if (!config.get().imageModel) return false;
        const text = parts
          .filter((p): p is Extract<UserPart, { type: 'text' }> => p.type === 'text')
          .map((p) => p.text)
          .join(' ');
        return looksLikeImageRequest(text);
      })();
      if (
        !override &&
        !opts?.noRoute &&
        !isLiveCoordinator &&
        !imageTurn &&
        mode !== 'off' &&
        projects.meta(sessionId)?.agentId === 'default'
      ) {
        // "My agents first" / "My agents only": hand the whole job (prompt,
        // tools, model) to the user's best-matching specialist; unset agent
        // models still get cheapest-adequate model routing underneath.
        // agents-only always lands on SOME agent (best fit when no hint hits).
        if (mode === 'agents' || mode === 'agents-only') {
          const text = parts
            .filter((p): p is Extract<UserPart, { type: 'text' }> => p.type === 'text')
            .map((p) => p.text)
            .join(' ');
          // Mr Homelab is NOT in the ordinary routing pool: he owns his own
          // tab, and a specialist whose hints cover "network/server/backup"
          // would otherwise absorb half of normal chat. Groups can still
          // assign him infrastructure parts (see the group path).
          // Vodo stands IN the pool, not outside it: he is an agent like the
          // rest, the one in charge, and usually the strongest model there.
          // Left out, "always land on an agent" meant always land on someone
          // ELSE — the person being spoken to could never be the answer, so
          // "you, stop using the agents" was itself handed to an agent.
          // He carries no prompt or hints here on purpose. His real prompt is
          // long and would score vague word-overlap against every message,
          // stealing work from specialists; with none, a specialist's keyword
          // hit beats him outright, and he takes what nobody specializes in —
          // which is what "in charge" means.
          const boss: AgentSpec = {
            id: 'default',
            name: vodoSpec().name,
            provider: config.get().defaultProvider,
            model: config.get().defaultModel,
          };
          // An agent on a mission is one GPU already working. Routing skips it
          // rather than handing the same card a second job.
          const onMission = missionsRef?.busyAgents() ?? new Map<string, string>();
          const agents = [
            boss,
            ...config
              .get()
              .agents.filter(
                (ag) =>
                  ag.id !== HOMELAB_AGENT_ID && ag.enabled !== false && !onMission.has(ag.id),
              ),
          ];
          const needsVision =
            historyHasImages || parts.some((p) => p.type === 'image');

          // Talking to the boss ABOUT someone is not talking to that someone.
          // "so tarantonio should have exactly what is in v1 … start working
          // on his side" is an order for Vodo to carry out — routing it to
          // Tarantonio delivered it to the one person it was not addressed to,
          // who then read instructions written about him in the third person
          // while the boss never heard them at all. A name in the third person
          // now PINS the turn to the coordinator: he has the roster and the
          // delegate tool, and passing the job on is his job. Addressing an
          // agent — "@name", or opening the message with the name — still
          // hands it straight over.
          const aboutSomeoneElse =
            agents.some((ag) => ag.id !== 'default' && mentionsName(text, ag)) &&
            !agents.some((ag) => addressedByName(text, ag));
          const recent = recentAgents.get(sessionId) ?? [];
          let match = aboutSomeoneElse
            ? null
            : matchAgentForMessage(text, agents, {
                always: mode === 'agents-only',
                hasImage: needsVision,
                recent,
                // Ties go to the more capable model, and the boss is usually it.
                qualityOf: qualityOfAgent,
              });
          // The boss winning means nobody else was a better fit — that is the
          // turn staying where it already is, not a handover to announce.
          if (match?.agent.id === 'default') match = null;
          // A specialist takes the turn on REAL evidence — its routing hints
          // or its name. Loose overlap with its system prompt is not enough to
          // take the conversation away from the person being spoken to: seen
          // live, "you try again stop using the agents" was handed to a
          // specialist whose prompt merely contains the word "agents". The
          // boss keeps it and delegates as he sees fit, which is his job.
          if (
            mode === 'agents-only' &&
            match &&
            match.matched.every((m) => /specialty terms$/.test(m))
          ) {
            match = null;
          }
          // "My agents first" + a WORK request in a project: if no keyword
          // hit, still hand it to the user's best agent — you built staff so
          // project work goes to your staff, not back to the catalog. But only
          // an agent with a REAL signal (score > 0): a specialist whose hints
          // are all off-topic (e.g. a vision agent with no image on the table)
          // must hand the job over to catalog routing, not absorb it by being
          // the only staff around.
          if (
            !match &&
            !aboutSomeoneElse &&
            mode === 'agents' &&
            builderMode &&
            looksLikeWorkRequest(text) &&
            agents.length > 0
          ) {
            const top = rankAgents(text, agents, { hasImage: needsVision, recent })[0];
            if (top && top.score > 0) {
              match = {
                agent: top.agent,
                matched: top.matched.length ? top.matched : ['best fit for project work'],
              };
            }
          }
          // Handover: a matched agent whose model is benched (repeated recent
          // failures) passes the job to the next ranked agent with a healthy
          // model — or, in "agents first" mode, back to catalog routing.
          if (match?.agent.model) {
            const benchedOf = (a: AgentSpec) =>
              !!a.model &&
              strikes.benched(a.provider ?? config.get().defaultProvider, a.model);
            if (benchedOf(match.agent)) {
              const failing = match.agent;
              const healthy = rankAgents(text, agents, { hasImage: needsVision }).find(
                (r) => r.agent.id !== failing.id && !benchedOf(r.agent),
              );
              if (healthy) {
                match = {
                  agent: healthy.agent,
                  matched: [
                    ...(healthy.matched.length ? healthy.matched : ['best available']),
                    `handover: ${failing.name} model failing`,
                  ],
                };
              } else if (mode === 'agents') {
                match = null; // no healthy specialist — catalog routing takes it
              }
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
                const alt = rankAgents(text, agents, { hasImage: needsVision }).find((r) =>
                  canSee(r.agent.model),
                );
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
            // Remember who just worked so a tie next turn goes elsewhere.
            // Bounded: only the last few matter, and a real match ignores it.
            recentAgents.set(
              sessionId,
              [...recent.filter((id) => id !== match!.agent.id), match.agent.id].slice(-4),
            );
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
      if (imageTurn && !routed) {
        const im = config.get().imageModel;
        routed = {
          provider: '',
          model: '',
          rationale: `image request — no handoff; image_generate renders it with ${im?.model ?? 'the image model'}`,
        };
      }
      const result = sessions.send(sessionId, parts, override, specOverride, { echo: true, echoParts: typedParts });
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
  registerHandler(IPC.chatCompact, async (_e, sessionId: string) => {
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
  registerHandler(IPC.chatInject, (_e, sessionId: string, parts: UserPart[]) => {
    const invalid = validateParts(parts);
    if (invalid) return { ok: false, error: invalid };
    observeMessage(sessionId, parts);
    return sessions.inject(sessionId, parts, { echo: true });
  });
  registerHandler(IPC.chatCancelInject, (_e, sessionId: string, injectionId: number) =>
    sessions.cancelInjection(sessionId, injectionId),
  );
  registerHandler(IPC.chatStop, (_e, sessionId: string) => sessions.stop(sessionId));
  registerHandler(IPC.chatReset, (_e, sessionId: string) => sessions.reset(sessionId));

  registerHandler(IPC.mcpList, () => mcp.list());
  registerHandler(IPC.mcpConnect, async (_e, name: string) => {
    const cfg = config.get().mcpServers.find((s) => s.name === name);
    if (!cfg) throw new Error(`No MCP server named "${name}" in config.`);
    return mcp.connect(cfg);
  });
  registerHandler(IPC.mcpDisconnect, (_e, name: string) => mcp.disconnect(name));
  registerHandler(IPC.mcpSearch, (_e, query: string) => searchMcpRegistry(query));
  registerHandler(IPC.mcpAdd, async (_e, cfg: McpServerConfig) => {
    const others = config.get().mcpServers.filter((s) => s.name !== cfg.name);
    config.set({ mcpServers: [...others, cfg] });
    return mcp.connect(cfg);
  });
  registerHandler(IPC.mcpOauthBegin, (_e, serverName: string) => mcpOAuth.begin(serverName));
  registerHandler(IPC.mcpOauthSignOut, (_e, serverName: string) => mcpOAuth.signOut(serverName));
  // ---- skills: packaged know-how, read on demand via skill_read ----
  registerHandler(IPC.skillsList, () => listSkills(app.getPath('userData')));
  registerHandler(IPC.skillsImport, async (_e, kind: 'folder' | 'file') => {
    const win = getWindow();
    if (!win) return { ok: false, error: 'No window.' };
    const picked = await hostDialog.showOpenDialog(
      win,
      kind === 'folder'
        ? { title: 'Pick a skill folder (SKILL.md inside)', properties: ['openDirectory'] }
        : {
            title: 'Pick a skill markdown file',
            filters: [{ name: 'Markdown', extensions: ['md'] }],
            properties: ['openFile'],
          },
    );
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: 'cancelled' };
    const res = importSkill(app.getPath('userData'), picked.filePaths[0]);
    return res.ok ? { ok: true, name: res.name } : { ok: false, error: res.error };
  });
  registerHandler(IPC.skillsImportUrl, async (_e, url: string) => {
    const res = await importSkillFromGitHub(app.getPath('userData'), String(url ?? ''));
    if (!res.ok) return { ok: false, error: res.error };
    return {
      ok: true,
      name: res.imported.map((s) => s.name).join(', '),
      count: res.imported.length,
    };
  });
  registerHandler(IPC.skillsRemove, (_e, slug: string) =>
    removeSkill(app.getPath('userData'), String(slug ?? '')),
  );
  registerHandler(IPC.advisorDismiss, (_e, topic: string) => advisor.dismiss(topic));
  registerHandler(IPC.openExternal, (_e, url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url);
    return Promise.resolve();
  });

  // ---- integrated terminal (real PTY) ----
  const terminals = new TerminalManager(sendToWindow);
  registerHandler(IPC.termCreate, (_e, opts: { cwd?: string; cols?: number; rows?: number }) =>
    terminals.create(opts ?? {}),
  );
  registerHandler(IPC.termInput, (_e, id: number, data: string) => terminals.input(id, data));
  registerHandler(IPC.termResize, (_e, id: number, cols: number, rows: number) =>
    terminals.resize(id, cols, rows),
  );
  registerHandler(IPC.termKill, (_e, id: number) => terminals.kill(id));
  app.on('will-quit', () => terminals.killAll());

  // ---- code preview watcher ----
  const projectWatcher = new ProjectWatcher(sendToWindow);
  registerHandler(IPC.watchStart, (_e, dir: string) => projectWatcher.start(dir));
  registerHandler(IPC.watchStop, () => projectWatcher.stop());
  registerHandler(IPC.watchReadFile, (_e, relPath: string) => projectWatcher.read(relPath));
  registerHandler(IPC.watchWriteFile, (_e, relPath: string, content: string) =>
    projectWatcher.write(relPath, content),
  );
  registerHandler(IPC.watchReadBaseline, (_e, relPath: string) =>
    projectWatcher.readBaseline(relPath),
  );

  initUpdater(getWindow, config);
  registerHandler(IPC.permissionRespond, (_e, requestId: string, decision: 'allow' | 'deny') =>
    sessions.respondPermission(requestId, decision),
  );

  /**
   * Browse the host's disk for the remote picker.
   *
   * Deliberately not fenced to the allowed roots that guard media reads. Those
   * exist so a front end cannot turn a path into BYTES it was never offered;
   * this is a person choosing where their next project lives, and a picker
   * that cannot leave four folders is not a picker. Anything holding the key
   * can already open a terminal here, so listing names grants nothing new —
   * and reading a file still goes through its own check.
   */
  // Always local (see CLIENT_CHANNELS): a sign-in redirects to 127.0.0.1,
  // which is whichever machine the browser is on — this one.
  registerHandler(IPC.oauthLoopback, (_e, authUrlTemplate: string) =>
    runOauthLoopback(String(authUrlTemplate ?? '')),
  );

  // A second window on the chosen side — see windows.openExtraWindow.
  registerHandler(IPC.openWindowAs, (_e, role: 'local' | 'client') => openExtraWindow(role));

  /**
   * Bring a finished file over from the host and put it where the person
   * wants it. Always local (see CLIENT_CHANNELS): the save dialog and the
   * file that comes out of it belong to the machine being looked at.
   *
   * Fetched here rather than in the window because the file can be gigabytes,
   * and streaming it to disk beats holding all of it in the page first.
   */
  registerHandler(IPC.saveToThisComputer, async (_e, url: string, suggestedName: string) => {
    try {
      const win = getWindow();
      const picked = win
        ? await dialog.showSaveDialog(win, { defaultPath: suggestedName })
        : await dialog.showSaveDialog({ defaultPath: suggestedName });
      if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
      const res = await fetch(url);
      if (!res.ok || !res.body) return { ok: false, error: `The host answered ${res.status}.` };
      // The DOM and Node each declare a ReadableStream and TypeScript sees
      // both here; the object is Node's, which is what fromWeb wants.
      await pipeline(
        Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(picked.filePath),
      );
      return { ok: true, saved: picked.filePath };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerHandler(IPC.hostFsMkdir, (_e, parent: string, name: string) => {
    try {
      const safe = basename(String(name ?? '')).replace(/[\/:*?"<>|]/g, '_').trim();
      if (!safe) return { ok: false, error: 'That name cannot be used.' };
      const target = join(resolve(String(parent)), safe);
      mkdirSync(target, { recursive: true });
      return { ok: true, path: target };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerHandler(IPC.hostFsList, (_e, path?: string): HostFsListing => {
    const entry = (full: string, name: string): HostFsEntry | null => {
      try {
        const st = statSync(full);
        return {
          name,
          path: full,
          dir: st.isDirectory(),
          size: st.isDirectory() ? 0 : st.size,
          modified: st.mtimeMs,
        };
      } catch {
        // A drive with no disc, a permission-denied folder, a broken link:
        // skipped rather than failing the whole listing around it.
        return null;
      }
    };

    // No path means "where would you like to start" — drives and the folders
    // this app already lives in, rather than dumping the user at C:\.
    if (!path) {
      const starts = [
        ...new Set(
          [
            config.get().genericDir,
            ...projects.list().projects.flatMap((p) => (p.dir ? [p.dir] : [])),
            (() => {
              try {
                return app.getPath('documents');
              } catch {
                return '';
              }
            })(),
            (() => {
              try {
                return app.getPath('home');
              } catch {
                return '';
              }
            })(),
            ...(process.platform === 'win32'
              ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((d) => `${d}:\\`)
              : ['/']),
          ].filter(Boolean),
        ),
      ];
      const entries = starts
        .map((p) => entry(p, basename(p) || p))
        .filter((e): e is HostFsEntry => e !== null && e.dir);
      return { ok: true, path: '', parent: null, entries };
    }

    try {
      const dir = resolve(path);
      const entries = readdirSync(dir)
        .map((name) => entry(join(dir, name), name))
        .filter((e): e is HostFsEntry => e !== null)
        // Folders first, then names — the order every file dialog uses, and
        // the one a person scanning for a folder expects.
        .sort((a, b) =>
          a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1,
        );
      const up = dirname(dir);
      return { ok: true, path: dir, parent: up === dir ? null : up, entries };
    } catch (err) {
      return {
        ok: false,
        path: String(path),
        parent: null,
        entries: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  registerHandler(IPC.scaffoldPickDir, async () => {
    const win = getWindow();
    if (!win) return null;
    const result = await hostDialog.showOpenDialog(win, {
      title: 'Choose a project folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  registerHandler(IPC.scaffoldDetect, (_e, dir: string) => detectProject(dir));
  registerHandler(IPC.scaffoldGenerate, (_e, dir: string, answers: ProjectAnswers, force?: boolean) =>
    injectScaffold(dir, answers, { force, generatedAt: new Date().toISOString() }),
  );

  // ---- capability registry + Vodo routing ----
  interface CatalogCache {
    records: ModelRecord[];
    /** Models actually present on local servers (ollama/lmstudio/llamacpp). */
    installed: Record<string, string[]>;
  }
  let catalogPromise: Promise<CatalogCache> | null = null;
  const getCatalog = (): Promise<CatalogCache> =>
    (catalogPromise ??= (async () => {
      // Locally installed models join the catalog; seed entries with matching
      // ids keep their curated quality/footprint data on merge.
      const extra: ModelRecord[] = [];
      const installed: Record<string, string[]> = {};
      for (const providerId of ['ollama', 'lmstudio', 'llamacpp', 'flm'] as const) {
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
          // Cloud records arrive from OpenRouter already carrying what they can
          // do; local ones are only an id, so the server is asked directly —
          // but ONLY for models an agent is actually pinned to. Asking about
          // all of them is one HTTP call per installed model (18 on one box
          // here) to answer a question nobody asked.
          const pinned = new Set(
            config
              .get()
              .agents.filter((a) => a.enabled !== false && a.model)
              .map((a) => a.model!),
          );
          const caps = new Map<string, string[]>();
          if (provider.capabilities) {
            const wanted = models.filter((m) => pinned.has(m.id)).slice(0, 12);
            await Promise.allSettled(
              wanted.map(async (m) => {
                const list = await Promise.race([
                  provider.capabilities!(m.id),
                  new Promise<string[]>((r) => setTimeout(() => r([]), 2000)),
                ]);
                if (list.length) caps.set(m.id, list);
              }),
            );
          }
          extra.push(
            ...models.map((m) => {
              const c = caps.get(m.id);
              return {
                id: m.id,
                provider: providerId,
                displayName: `${m.id} (installed)`,
                tags: ['local'],
                // Absent stays absent: "unknown" and "cannot" must not be the
                // same thing, or an unprobed agent reads as unable to build.
                ...(c ? { supportsTools: c.includes('tools') } : {}),
                ...(c ? { supportsVision: c.includes('vision') } : {}),
              };
            }),
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

  // Native remote providers retire model ids the seed still lists (gpt-5-codex
  // outlived its OpenAI deprecation here) — verify routing candidates against
  // the provider's LIVE model list, like OpenRouter ids already are. Fail-open:
  // no list (offline, timeout, unsupported endpoint) → no filtering.
  const liveIdCache = new Map<string, { ids: Set<string> | null; at: number }>();
  const LIVE_IDS_TTL = 60 * 60_000;
  const NATIVE_VERIFIED = ['openai', 'xai', 'anthropic'] as const;
  invalidateXaiLiveIds = () => {
    liveIdCache.delete('xai');
  };
  const liveNativeIds = async (): Promise<Map<string, Set<string> | null>> => {
    const out = new Map<string, Set<string> | null>();
    const registered = new Set(hub.registry().ids());
    await Promise.all(
      NATIVE_VERIFIED.filter((p) => registered.has(p)).map(async (providerId) => {
        const hit = liveIdCache.get(providerId);
        if (hit && Date.now() - hit.at < LIVE_IDS_TTL) {
          out.set(providerId, hit.ids);
          return;
        }
        let ids: Set<string> | null = null;
        try {
          const provider = hub.registry().get(providerId);
          if (provider) {
            const models = await Promise.race([
              provider.listModels(),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`${providerId} timeout`)), 2500),
              ),
            ]);
            ids = models.length ? new Set(models.map((m) => m.id)) : null;
          }
        } catch {
          ids = null;
        }
        liveIdCache.set(providerId, { ids, at: Date.now() });
        out.set(providerId, ids);
      }),
    );
    return out;
  };

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
    // Subscription-billed endpoints (Grok login, NVIDIA free tier, GLM Coding
    // Plan, Claude Code) carry catalog API rates that never appear on a bill —
    // zero them so auto-routing does not rank a free-on-plan model as if it
    // cost $2-3/MTok and steer away from it.
    const pricedRecords = records.map(zeroSubscriptionPricing);
    const registered = new Set(hub.registry().ids());
    const liveOpenRouter = new Set(
      pricedRecords.filter((r) => r.provider === 'openrouter').map((r) => r.id),
    );
    const liveNative = await liveNativeIds();
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
    for (const m of pricedRecords) {
      if (isExcluded(m)) continue;
      if (m.provider && registered.has(m.provider)) {
        if (m.provider === 'ollama' || m.provider === 'lmstudio' || m.provider === 'llamacpp') {
          if (installed[m.provider]?.includes(m.id)) eligible.push(m);
        } else if (m.provider === 'openrouter') {
          // Only route to ids that exist on OpenRouter right now.
          if (liveOpenRouter.size === 0 || liveOpenRouter.has(m.id)) eligible.push(m);
        } else {
          // Native providers: skip ids the provider no longer serves
          // (deprecated/retired models linger in the seed).
          const live = liveNative.get(m.provider);
          if (!live || live.has(m.id)) eligible.push(m);
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
    // Benched models (2 recent consecutive failures) sit out — the job is
    // handed to the next candidate instead of retrying a known-broken pick.
    const routable = eligible.filter((m) => !strikes.benched(m.provider ?? '', m.id));
    const avoided = eligible.length !== routable.length ? strikes.benchedModels() : [];
    const top = suggest(signal, routable, profileHardware(), 1, {
      tier: config.get().routeTier,
    })[0];
    if (!top?.model.provider) return undefined;
    return {
      provider: top.model.provider,
      model: top.model.id,
      rationale:
        top.rationale +
        (avoided.length ? ` · avoiding ${avoided.join(', ')} after repeated errors` : ''),
    };
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
  // One-shot, non-streamed-to-UI completion: collect the whole reply or throw.
  const collectOnce = async (
    bound: BoundModel,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string> => {
    let out = '';
    let errMsg: string | undefined;
    for await (const event of bound.provider.stream(
      { model: bound.model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] },
      { signal: signal ?? new AbortController().signal },
    )) {
      if (event.type === 'text_delta') out += event.text;
      else if (event.type === 'error') errMsg = event.error.message;
    }
    if (!out.trim()) throw new Error(errMsg ?? 'empty completion');
    return out;
  };
  const completeCheap = async (prompt: string): Promise<string> => {
    const pick = await routeForVodo([{ type: 'text', text: prompt.slice(0, 2000) }], false, false)
      .catch(() => undefined);
    const spec = vodoSpec();
    const bound = resolveSpec(
      pick ? { ...spec, provider: pick.provider as AgentSpec['provider'], model: pick.model } : spec,
    );
    return collectOnce(bound, prompt);
  };
  // Vodo's own voice on the user's default (strong) model — review and help
  // must never be cheap-routed: judging a weaker model's work with an equally
  // weak model teaches nothing.
  const completeStrong = (prompt: string): Promise<string> => collectOnce(resolveSpec(vodoSpec()), prompt);
  // `spec` is the agent actually running this surface (a mission handed to a
  // hired agent). Without it — Telegram, Vodo's own chores — the toolset is
  // Vodo's: full memory, every MCP server. With it, the SAME per-agent gates
  // the interactive SessionManager applies hold here too: an agent with no
  // project memory gets no memory tools, and each agent reaches only the MCP
  // servers on its card, not every connected server.
  const remoteTools = (dir?: string, spec?: AgentSpec) => [
    ...(dir ? [...workspaceToolSpecs(dir), ...lookToolSpecs()] : []),
    ...builtins
      .specs()
      .filter((t) => spec?.memory !== false || !MEMORY_TOOLS.has(t.name)),
    ...mcp.toolsFor(spec ? spec.mcpServers : undefined),
  ];
  const remoteExecute = (
    name: string,
    args: unknown,
    dir?: string,
    projectId?: string,
    spec?: AgentSpec,
  ) => {
    // Same execution-time gate as SessionManager.runTool: hiding the spec is
    // not enough — refuse a memory tool outright for a memory-off agent.
    if (spec?.memory === false && MEMORY_TOOLS.has(name)) {
      return Promise.resolve({
        content:
          'This agent has no project memory, so this tool is not available to it. Work from the ' +
          'instructions you were given.',
        isError: true,
      });
    }
    // MCP tools are namespaced "<server>__<tool>", and the separator is barred
    // from raw names, so the double underscore is a reliable marker. Check it
    // FIRST: a server named "ws" or "web" would otherwise produce ws__read /
    // web__search, match the prefix tests below, and be misrouted into the
    // built-in executor instead of reaching its own server.
    if (name.includes('__')) return mcp.call(name, args);
    if (name.startsWith('ws_')) {
      return dir
        ? executeWorkspaceTool(dir, name, args)
        : Promise.resolve({ content: 'This mission has no project folder.', isError: true });
    }
    // Match the builtin by NAME, not by a prefix list — the interactive path's
    // hand-written regex here had already dropped video_, so video_generate on
    // a mission fell through to mcp.call and errored. Membership stays correct
    // as builtins are added. lookToolSpecs rides along: look_at_image is
    // advertised separately (folder-backed only) but executed here.
    if (
      builtins.specs().some((t) => t.name === name) ||
      lookToolSpecs().some((t) => t.name === name)
    ) {
      return builtins.execute(name, args, { projectId, ...(dir ? { dir } : {}) });
    }
    return mcp.call(name, args);
  };

  const missions = new MissionManager(join(app.getPath('userData'), 'missions.json'), {
    vodoSpec,
    agentSpec: (agentId) => config.get().agents.find((a) => a.id === agentId),
    emitToUi: (sessionId, event) => sendToWindow(IPC.chatEvent, { sessionId, event }),
    projectDir: (projectId) => projects.list().projects.find((p) => p.id === projectId)?.dir,
    resolveProject: resolveProjectId,
    resolve: resolveSpec,
    // Missions run unattended: a CLI agent on a mission keeps one CLI-side
    // conversation per mission and must never wedge on an unanswerable
    // permission prompt.
    bindCliSession: (bound, ctx) => ({
      model: bound.model,
      provider: hub.bindCli(bound.provider, { ...ctx, permissionMode: 'bypassPermissions' }),
    }),
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

  /**
   * Telegram's Vodo is a dispatcher, not a builder: the phone has no folders,
   * no file tools and no team. This hands a job to the Vodo at the machine by
   * opening a real chat and sending the brief — which is why the work then
   * appears in the app like any other, and why the group it may start is
   * watchable there.
   */
  /** Project names the phone-side Vodo may aim a dispatch at. */
  const existingProjectNames = (): string[] =>
    projects
      .list()
      .projects.filter((p) => p.id !== GENERAL_PROJECT_ID && p.dir)
      .map((p) => p.name)
      .slice(0, 30);
  const dispatchToolSpec = (): ToolSpec => ({
    name: 'vodo_dispatch',
    description:
      'Hand a job to Vodo at the machine, who has the folders, the file tools and the agent ' +
      'team. Use it for anything to be BUILT. It opens a new chat there and sends your brief; ' +
      'the user can watch it in the app. Write the brief as an instruction to someone who ' +
      'cannot see this Telegram conversation: say what to build, WHERE the project folder goes, ' +
      'and whether it is a plain project (work it alone) or a GROUP PROJECT (split it across ' +
      'the agents). MOST WORK CONTINUES SOMETHING THAT EXISTS: when it belongs to a project the ' +
      'user already has, name it in `project` so the chat opens INSIDE it — otherwise one job ' +
      'spread over several messages becomes a pile of identical half-projects.' +
      (existingProjectNames().length
        ? ` Existing projects: ${existingProjectNames().join(', ')}.`
        : ''),
    inputSchema: {
      type: 'object',
      properties: {
        brief: {
          type: 'string',
          description: 'The complete instruction, standing on its own with all the context',
        },
        title: { type: 'string', description: 'Short title for the chat (a few words)' },
        project: {
          type: 'string',
          description:
            'The EXISTING project this work belongs to, by name (see the list in this description). ' +
            'Leave it out only when this is genuinely a new thing.',
        },
      },
      required: ['brief'],
    },
  });
  const executeDispatch = async (args: unknown): Promise<{ content: string; isError?: boolean }> => {
    const a = (args ?? {}) as { brief?: unknown; title?: unknown; project?: unknown };
    const brief = typeof a.brief === 'string' ? a.brief.trim() : '';
    if (!brief) return { content: 'Say what to hand over.', isError: true };
    const title = (typeof a.title === 'string' && a.title.trim()) || brief.slice(0, 48);
    // Continuing work goes back INTO its project, with that project's folder
    // already attached. Every dispatch used to start in General and rely on
    // project_create to rehome it, so one job carried over several phone
    // messages scattered into a row of identical half-projects.
    const wanted = typeof a.project === 'string' ? a.project.trim() : '';
    const target = wanted ? projects.findByName(wanted) : undefined;
    const meta = target
      ? projects.createSession(target.id, 'default', title, undefined, target.dir)
      : projects.createSession(GENERAL_PROJECT_ID, 'default', title);
    broadcastProjects();
    journal.append({ kind: 'chat', text: `dispatched from Telegram: ${title}`, surface: 'telegram' });
    const where = target
      ? `[This continues the project "${target.name}"${target.dir ? ` at ${target.dir}` : ''} — ` +
        'its folder is already attached. Read what is there before building anything new, and do ' +
        'NOT create a second project for it.]\n'
      : '';
    void sessions.send(
      meta.id,
      [
      {
        type: 'text',
        text:
          `[Dispatched from Telegram — the user is away from the machine and cannot see this ` +
          `chat. Do the work here; they will read the result on their phone.]\n${where}\n${brief}`,
      },
    ],
      undefined,
      undefined,
      { echo: true },
    );
    const missed = wanted && !target ? ` (no project named "${wanted}" — started a fresh one)` : '';
    return {
      content: target
        ? `Handed to Vodo at the machine — chat "${title}" is running inside "${target.name}".`
        : `Handed to Vodo at the machine — chat "${title}" is running in the app.${missed}`,
    };
  };

  const telegram = new TelegramBridge(config, secrets, {
    vodoSpec,
    resolve: resolveSpec,
    tools: () => [...remoteTools(), dispatchToolSpec()],
    execute: (name, args) => telegramExecute(name, args),
    missionsSummary: () => missions.describeAll(),
    onUsage: (bound, ev) => recordUsage(bound, ev),
    onChanged: (info) => sendToWindow(IPC.telegramChanged, info),
    log: (text) => journal.append({ kind: 'chat', text, surface: 'telegram' }),
    transcribe: (data, mimeType, fileName) => voice.transcribeFile(data, mimeType, fileName),
    synthesize: (text) => voice.synthesize(text),
    // Same folder policy as everything else the agents touch: a phone is not a
    // way around it. Vodo can send you what he could already read.
    readFile: (path: string) => {
      const target = insideAllowedRoots(path);
      if (!target) return { error: 'That path is outside the folders Vo-Coder may read.' };
      try {
        const data = readFileSync(target);
        return { data: new Uint8Array(data), name: basename(target) };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
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
    // Handing work to the machine IS execution, so it sits behind the same
    // gate as everything else — it just is not a tool the app's own Vodo has.
    if (name === 'vodo_dispatch') return executeDispatch(args);
    return remoteExecute(name, args);
  };
  telegramRef = telegram;
  telegram.sync();
  app.on('before-quit', () => {
    missions.stopAll();
    telegram.stop();
    // Anything the agents launched to look at goes with the app. A detached
    // launch outlives its turn on purpose, but not the session — otherwise
    // closing Vo-Coder leaves its leftovers running with nobody to stop them.
    stopLaunched();
    // CLI agent children (Claude Code turns) die with the app too.
    closeAllCliChildren();
  });

  // Claude Code CLI: is it installed and answering? Settings' Check button.
  registerHandler(IPC.claudeCliCheck, () => hub.cliAgent().healthCheck());

  registerHandler(IPC.missionsList, () => missions.list());
  registerHandler(IPC.missionCreate, (_e, input: MissionCreateInput) => missions.create(input));
  registerHandler(IPC.missionControl, (_e, id: string, action: MissionAction) =>
    missions.control(id, action),
  );
  registerHandler(IPC.telegramInfo, () => telegram.info());
  registerHandler(IPC.telegramPairCode, () => telegram.generatePairCode());
  registerHandler(IPC.telegramUnpair, (_e, chatId: number) => telegram.unpair(chatId));

  // ---- memory view + smart-context toggle ----
  registerHandler(IPC.projectSetAssemble, (_e, projectId: string, enabled: boolean) => {
    projects.setAssemble(projectId, enabled);
    broadcastProjects();
  });
  registerHandler(IPC.memStats, (_e, projectId: string) =>
    bank ? bank.stats(projectId) : { nodes: 0, archiveTurns: 0 },
  );
  registerHandler(
    IPC.memMapList,
    (_e, projectId: string, opts?: { query?: string; type?: string; includeInactive?: boolean }) =>
      bank ? bank.listNodes(projectId, opts ?? {}) : [],
  );
  registerHandler(IPC.memMapSetStatus, (_e, projectId: string, nodeId: number, status: string) => {
    bank?.setNodeStatus(projectId, nodeId, status);
  });
  registerHandler(IPC.memMapDelete, (_e, projectId: string, nodeId: number) => {
    bank?.deleteNode(projectId, nodeId);
  });
  registerHandler(
    IPC.memMapGraph,
    (_e, projectId: string, opts?: { includeInactive?: boolean }) =>
      bank ? bank.graph(projectId, opts ?? {}) : { nodes: [], edges: [] },
  );

  // ---- imported life memory (Memory → Archives) ----
  registerHandler(IPC.lifePickFile, async () => {
    const win = getWindow();
    if (!win) return {};
    const picked = await hostDialog.showOpenDialog(win, {
      title: 'Pick a chat export (.zip or conversations.json)',
      filters: [
        { name: 'Chat export', extensions: ['zip', 'json'] },
        { name: 'All files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    refocusMain();
    return picked.canceled || !picked.filePaths[0] ? {} : { path: picked.filePaths[0] };
  });
  registerHandler(IPC.lifeScan, (_e, path: string) =>
    lifeImporter
      ? lifeImporter.scan(path)
      : { ok: false, error: 'The memory bank is unavailable.' },
  );
  registerHandler(
    IPC.lifeStart,
    async (
      _e,
      path: string,
      opts: {
        depth: 'deep' | 'skim';
        provider?: string;
        model?: string;
        resumeBatchId?: number;
      },
    ) => {
      if (!lifeImporter) return { ok: false, error: 'The memory bank is unavailable.' };
      try {
        const spec = vodoSpec();
        // The digester: the pinned pick from the UI, else the cheap route —
        // extraction work, not conversation, so cheap is the right default.
        let digester: BoundModel;
        let modelLabel: string;
        if (opts.provider && opts.model) {
          digester = resolveSpec({
            ...spec,
            provider: opts.provider as AgentSpec['provider'],
            model: opts.model,
          });
          modelLabel = `${opts.provider}/${opts.model}`;
        } else {
          const pick = await routeForVodo(
            [{ type: 'text', text: 'summarize and extract durable facts from chat transcripts' }],
            false,
            false,
          ).catch(() => undefined);
          digester = resolveSpec(
            pick
              ? { ...spec, provider: pick.provider as AgentSpec['provider'], model: pick.model }
              : spec,
          );
          modelLabel = pick ? `auto → ${pick.provider}/${pick.model}` : 'app default';
        }
        // The final "what I learned" pass speaks with Vodo's own voice — his
        // configured model, never the cheap route. Its input is tiny.
        const strong = resolveSpec(spec);
        return await lifeImporter.start(
          path,
          {
            depth: opts.depth === 'skim' ? 'skim' : 'deep',
            modelLabel,
            ...(opts.resumeBatchId !== undefined ? { resumeBatchId: opts.resumeBatchId } : {}),
          },
          (prompt, signal) => collectOnce(digester, prompt, signal),
          (prompt, signal) => collectOnce(strong, prompt, signal),
        );
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  registerHandler(IPC.lifeCancel, () => {
    lifeImporter?.cancel();
  });
  registerHandler(IPC.lifeState, () => ({
    batches: bank?.lifeBatches() ?? [],
    noteCount: bank?.lifeCount() ?? 0,
    ...(lifeImporter?.running() ? { running: lifeImporter.running() } : {}),
  }));
  registerHandler(
    IPC.lifeNotes,
    (_e, opts?: { query?: string; kind?: string; includeInactive?: boolean }) =>
      bank?.lifeNotes(opts ?? {}) ?? [],
  );
  registerHandler(IPC.lifeNoteStatus, (_e, id: number, status: string) => {
    bank?.lifeSetStatus(id, status);
  });
  registerHandler(IPC.lifeNoteDelete, (_e, id: number) => {
    bank?.lifeDeleteNote(id);
  });
  registerHandler(IPC.lifeBatchDelete, (_e, id: number) => {
    bank?.lifeBatchDelete(id);
  });
  // Inline display of generated/project images — reads are fenced to project
  // folders and the app's own generated dir.
  /**
   * Where a viewer may read generated media from. The generic folder belongs
   * here too: a folder-less chat writes there (that is the whole point of it),
   * and image_generate in a General chat once saved a picture the viewer then
   * refused to open — generated, on disk, and invisible.
   */
  const insideAllowedRoots = (path: string): string | null => {
    const generic = config.get().genericDir;
    const roots = [
      join(app.getPath('userData'), 'generated'),
      ...(generic ? [generic] : []),
      ...projects.list().projects.flatMap((p) => (p.dir ? [p.dir] : [])),
      ...projects.list().sessions.flatMap((s) => (s.dir ? [s.dir] : [])),
    ];
    const target = resolve(path);
    const inside = (root: string) => {
      const rel = relative(root, target);
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    };
    return roots.some(inside) ? target : null;
  };

  registerHandler(IPC.globalRulesRead, () => ({
    path: globalRulesPath(),
    text: readGlobalRules() || GLOBAL_RULES_TEMPLATE,
  }));
  registerHandler(IPC.globalRulesWrite, (_e, text: string) => {
    try {
      writeGlobalRules(String(text ?? ''));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerHandler(IPC.imageRead, (_e, path: string) => {
    try {
      const target = insideAllowedRoots(path);
      if (!target) return { ok: false, error: 'Path outside allowed folders.' };
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

  // Raw bytes, not a data URL: the renderer wraps them in a Blob so the player
  // can seek without a base64 copy a third larger than the file.
  registerHandler(IPC.videoRead, (_e, path: string) => {
    try {
      const target = insideAllowedRoots(path);
      if (!target) return { ok: false, error: 'Path outside allowed folders.' };
      const data = readFileSync(target);
      if (data.length > 200 * 1024 * 1024) return { ok: false, error: 'File too large to play.' };
      const ext = target.split('.').pop()?.toLowerCase() ?? 'mp4';
      // Audio too: a player needs bytes and a type, and where they came from —
      // a generated narration mp3 or a rendered clip — changes nothing here.
      const mimeType =
        audioMimeFor(target) ??
        (ext === 'webm' ? 'video/webm' : ext === 'mov' ? 'video/quicktime' : 'video/mp4');
      return {
        ok: true,
        data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        mimeType,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerHandler(IPC.registryCatalog, async () => {
    const hardware = profileHardware();
    // Catalog seed stores xAI *API* rates. Grok login (OAuth) is subscription-
    // billed — zero those rates in the payload the UI reads so Chat/Settings
    // never show $2/$6 while SuperGrok is the live credential (even if an API
    // key is also saved; the hub prefers OAuth for requests).
    const xaiSubFree = hub.usingXaiOAuth();
    const records = (await getCatalog()).records.map((m) => {
      const fit = checkFit(m, hardware);
      if (xaiSubFree && (m.provider ?? '').toLowerCase() === 'xai') {
        return { ...m, fit, pricing: { inputPerMTok: 0, outputPerMTok: 0 } };
      }
      return { ...m, fit };
    });
    return { hardware, records };
  });
  registerHandler(
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
      const liveNative = await liveNativeIds();
      const xaiSubFree = hub.usingXaiOAuth();
      const records = (await getCatalog()).records
        .filter((m) => {
          if (
            excluded.some(
              (term) =>
                m.id.toLowerCase().includes(term) ||
                (m.displayName ?? '').toLowerCase().includes(term),
            )
          ) {
            return false;
          }
          if (strikes.benched(m.provider ?? '', m.id)) return false;
          const live = m.provider ? liveNative.get(m.provider) : undefined;
          return !live || live.has(m.id);
        })
        .map((r) =>
          xaiSubFree && (r.provider ?? '').toLowerCase() === 'xai'
            ? { ...r, pricing: { inputPerMTok: 0, outputPerMTok: 0 } }
            : r,
        );
      return suggest(signalFromPrompt(text, opts), records, profileHardware(), 3, {
        tier: config.get().routeTier,
      });
    },
  );

  // ---- voice (PTT + live chat) ----
  const voice = new VoiceHost(config, secrets);
  registerHandler(IPC.voiceTranscribe, async (_e, wav: ArrayBuffer) => {
    try {
      const text = await voice.transcribe(new Uint8Array(wav));
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  registerHandler(IPC.voiceSynthesize, async (_e, text: string) => {
    try {
      const out = await voice.synthesize(String(text ?? ''));
      if (!out) {
        // Not a failure — the engine simply speaks out loud here rather than
        // handing over a file. The caller has its own voice for that case, and
        // saying so plainly is what lets it use it.
        return { ok: false, error: 'This computer’s voice plays here and cannot be sent.' };
      }
      return {
        ok: true,
        data: out.data.buffer.slice(out.data.byteOffset, out.data.byteOffset + out.data.byteLength),
        mimeType: out.mimeType,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  registerHandler(IPC.voiceSpeak, async (_e, text: string) => {
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
  registerHandler(IPC.voiceStopSpeak, () => voice.stopSpeak());
  registerHandler(IPC.voiceCompatCatalog, (_e, baseUrl: string) =>
    fetchCompatCatalog(baseUrl, secrets.get('tts-custom') ?? null),
  );
  registerHandler(IPC.voiceSystemVoices, () => voice.listVoices());
  registerHandler(IPC.voiceSetupWhisper, async () => {
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
  // A dev server we spawned must not outlive the app.
  app.on('before-quit', () => {
    preview.close();
    // Nor the last turn's tokens/cost — record() only writes on an 800ms debounce.
    usage.flush();
  });
  registerHandler(IPC.previewOpen, (_e, url: string) => preview.open(url));
  registerHandler(IPC.previewOpenFile, (_e, path: string) => preview.openFile(path));
  registerHandler(IPC.previewDetect, async (_e, dir: string) => {
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
    // 2) A bundler project (Vite/Next/CRA…): its index.html is a module entry
    // that ONLY works through the dev server — loading it from disk renders
    // blank. Offer to start the server instead of a broken static file.
    const dev = detectDevCommand(dir);
    if (dev) return { kind: 'dev', command: dev.command, port: dev.port };
    // 3) A genuinely static entry page (vanilla HTML/CSS/JS — relative paths).
    for (const rel of ['index.html', 'dist/index.html', 'build/index.html', 'public/index.html', 'src/index.html']) {
      const candidate = join(dir, rel);
      if (existsSync(candidate)) return { kind: 'file', path: candidate };
    }
    return { kind: 'none' };
  });
  registerHandler(IPC.previewStartDev, async (_e, dir: string) => {
    const result = await preview.startDev(dir);
    if (result.ok && result.url) preview.open(result.url);
    return result;
  });
  registerHandler(IPC.previewStopDev, () => {
    // A stopped server leaves a dead page behind — clear the pane with it.
    const result = preview.stopServer();
    preview.close();
    return result;
  });
  registerHandler(IPC.previewClose, () => preview.close());
  registerHandler(IPC.previewHide, () => preview.hide());
  registerHandler(IPC.previewReload, () => preview.reload());
  registerHandler(IPC.previewBounds, (e, bounds: PreviewBounds) => {
    // The renderer measures in CSS pixels; the native view is placed in
    // window DIPs. CSS px × zoomFactor = DIP, whatever the OS display scale —
    // without this, any UI zoom (Settings or the stock Ctrl+± accelerators)
    // shifts the overlay off its placeholder.
    const z = e.sender.getZoomFactor();
    preview.setBounds({
      x: bounds.x * z,
      y: bounds.y * z,
      width: bounds.width * z,
      height: bounds.height * z,
    });
  });
  registerHandler(IPC.previewState, () => preview.stateValidated());

  // ---- remote mode ----
  //
  // Run Vodo on one computer and drive it from another — a second desktop, or
  // the companion phone app. The server is an authenticated socket for calls
  // and events plus plain HTTP for anything that wants byte ranges, all on one
  // port, so there is one thing to type into the other machine and one
  // firewall answer to give.

  /**
   * Media handed out by unguessable id rather than by path.
   *
   * The id IS the credential: it is only minted for a path that already passed
   * the allowed-roots check, and an <img> cannot send an auth header, so the
   * address has to carry its own right. Stable per file, or every thumbnail
   * would mint a new one and this map would grow for as long as the app runs.
   */
  const mediaRefs = new Map<string, { path: string; mimeType: string }>();

  registerHandler(IPC.mediaUrl, (_e, path: string) => {
    const target = insideAllowedRoots(String(path));
    if (!target) return { ok: false, error: 'Path outside allowed folders.' };
    const ext = target.split('.').pop()?.toLowerCase() ?? '';
    const mimeType =
      audioMimeFor(target) ??
      (ext === 'png'
        ? 'image/png'
        : ext === 'jpg' || ext === 'jpeg'
          ? 'image/jpeg'
          : ext === 'gif'
            ? 'image/gif'
            : ext === 'webp'
              ? 'image/webp'
              : ext === 'webm'
                ? 'video/webm'
                : ext === 'mov'
                  ? 'video/quicktime'
                  : 'video/mp4');
    const existing = [...mediaRefs].find(([, v]) => v.path === target);
    if (existing) return { ok: true, id: existing[0], mimeType };
    const id = randomBytes(24).toString('base64url');
    mediaRefs.set(id, { path: target, mimeType });
    return { ok: true, id, mimeType };
  });
  setMediaResolver((id) => mediaRefs.get(id) ?? null);

  registerHandler(IPC.hostFileUpload, (_e, name: string, bytes: ArrayBuffer) => {
    try {
      const safe = basename(String(name ?? 'file')).replace(/[\/:*?"<>|]/g, '_') || 'file';
      const dir = join(userDataDir(), 'uploads', randomBytes(8).toString('hex'));
      mkdirSync(dir, { recursive: true });
      const target = join(dir, safe);
      writeFileSync(target, Buffer.from(new Uint8Array(bytes)));
      return { ok: true, path: target };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /**
   * Where an uploaded file lands, checked against the key.
   *
   * The HTTP path cannot present the socket handshake, so the key rides in the
   * query and is checked here. A wrong key gets nowhere to write, and the
   * endpoint answers 403 without touching the disk. The name is stripped to
   * its last segment first — a front end is not a trusted source of paths, and
   * "../.." in a filename must land as a filename.
   */
  setUploadSink((name, key) => {
    const token = config.get().remote.listen.token;
    if (!token || key !== token) return null;
    const safe = basename(String(name ?? 'file')).replace(/[\/:*?"<>|]/g, '_') || 'file';
    const dir = join(userDataDir(), 'uploads', randomBytes(8).toString('hex'));
    mkdirSync(dir, { recursive: true });
    return { path: join(dir, safe) };
  });

  // This edition serves no preview of its own, so there is nothing for the
  // /preview route to forward to and it answers 503 rather than pretending.
  setPreviewOrigin(() => null);

  /**
   * Synchronous by necessity — the preload asks this before it can build
   * window.vo, and exposeInMainWorld cannot wait for a promise. Deliberately
   * on ipcMain directly rather than through the registry: it answers a
   * question about THIS machine, so a remote front end asking it must get its
   * own answer, never the host's.
   */
  ipcMain.on(IPC.remoteBootstrap, (event) => {
    event.returnValue = { remote: config.get().remote, edition: edition() };
  });

  registerHandler(IPC.remoteInfo, () => remoteStatus(lanAddresses()));
  registerHandler(IPC.remoteSettingsGet, () => config.get().remote);
  registerHandler(IPC.remoteSettingsSet, (_e, patch: Partial<RemoteSettings>) => {
    const before = config.get().remote;
    const next = { ...before, ...patch };
    config.set({ remote: next });
    // Re-listen when what the listener is made of changed. Without this,
    // editing the port, the key or the encryption did nothing until a restart
    // — and said nothing either, so the panel showed the new port beside a
    // server still on the old one.
    if (next.role === 'host' && JSON.stringify(before.listen) !== JSON.stringify(next.listen)) {
      void startRemoteHost(next);
    }
    return next;
  });

  /**
   * Switch which end of the wire this window is.
   *
   * Applied by reloading: the preload picks its transport when it loads, so it
   * runs again and comes back attached to the other side. That is why this
   * needs no restart — the role was never baked into the process, only into
   * the window.
   */
  registerHandler(IPC.remoteApplyRole, (_e, patch: Partial<RemoteSettings>) => {
    const next = { ...config.get().remote, ...patch };
    config.set({ remote: next });
    if (next.role === 'host') void startRemoteHost(next);
    else stopRemoteHost();
    // Reloaded after the reply is on its way, or the caller loses the socket
    // mid-call and sees a rejection instead of a switch.
    setTimeout(() => getWindow()?.webContents.reload(), 80);
  });

  // Serve this machine, if that is what it has been told to be. Started here
  // rather than at boot so every handler is registered before the first front
  // end can call one.
  if (config.get().remote.role === 'host') void startRemoteHost(config.get().remote);
  onRemoteStatusChange(() => sendToWindow(IPC.remoteChanged, remoteStatus(lanAddresses())));
}
