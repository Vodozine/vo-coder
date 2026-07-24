import { AgentSession, type McpClientManager, type PermissionDecision } from '@vo-coder/core';
import type { AgentSpec, BoundModel, HarnessMessage, ToolSpec, UserPart } from '@vo-coder/providers';
import { IPC, type PermissionPrompt, type SendResult } from '../shared/ipc-contract';
import type { ConfigStore } from './config';
import type { ProjectStore } from './projects';
import type { ProviderHub } from './providers';
import { fmtStamp } from './journal';
import { AUTO_ALLOWED_TOOLS } from './tool-policy';
import { lookToolSpecs } from './vision-look';
import { executeWorkspaceTool, workspaceToolSpecs } from './workspace-tools';

interface SessionManagerDeps {
  config: ConfigStore;
  hub: ProviderHub;
  mcp: McpClientManager;
  projects: ProjectStore;
  send: (channel: string, payload: unknown) => void;
  /** Always-on tools every session gets (web search/fetch, mission control). */
  builtins?: {
    specs(): ToolSpec[];
    execute(
      name: string,
      args: unknown,
      ctx?: { projectId?: string; dir?: string },
    ): Promise<{ content: string; isError?: boolean; imagePath?: string }>;
  };
  /** Fired for every provider usage report, with the model that produced it. */
  onUsage?: (
    sessionId: string,
    bound: BoundModel | undefined,
    usage: { inputTokens: number; outputTokens: number },
  ) => void;
  /** Observer for session events (activity journaling). */
  onEvent?: (sessionId: string, event: import('@vo-coder/core').SessionEvent) => void;
  /** Cheapest-adequate model pick for internal jobs (context compaction). */
  pickCheap?: (
    text: string,
  ) => Promise<{ provider: string; model: string } | undefined>;
  /** Lossless archive — new turns sync on every persist. */
  bank?: {
    syncSession(projectId: string, sessionId: string, history: HarnessMessage[]): void;
    /** Bounded map briefing for window-as-buffer assembly. */
    digest(projectId: string): string;
  };
  /** Catalog lookup: does this model accept image input? undefined = unknown. */
  modelCanSee?: (modelId: string) => boolean | undefined;
}

const IMAGE_STUB =
  '[image attachment from earlier in this conversation — not visible to the current model; ' +
  'ask the user or route to a vision model if its contents matter now]';

/** Window-as-buffer tuning: only kicks in past this many messages… */
const ASSEMBLE_MIN_MESSAGES = 12;
/** …and keeps roughly this many chars (~5k tokens) of recent turns verbatim. */
const ASSEMBLE_BUFFER_CHARS = 20_000;

function approxChars(msg: HarnessMessage): number {
  if (msg.role === 'tool') return msg.content.length;
  let n = 0;
  for (const part of msg.content) {
    if (part.type === 'text' || part.type === 'thinking') n += part.text.length;
    else if (part.type === 'tool_call') n += JSON.stringify(part.args ?? {}).length + 40;
    else n += 400; // images/files: replayed as refs, keep a nominal weight
  }
  return n;
}

const PERMISSION_TIMEOUT_MS = 5 * 60_000;

/**
 * One live AgentSession per chat session id, created lazily with its history
 * restored from disk. Every session belongs to a project and points at an
 * agent spec; transcripts persist on every send and on run completion.
 */
export class SessionManager {
  private sessions = new Map<string, AgentSession>();
  private pendingPermissions = new Map<string, (d: PermissionDecision) => void>();
  private permSeq = 0;
  /** Last resolved provider/model per session — attributes usage to a model. */
  private lastBound = new Map<string, BoundModel>();

  constructor(private deps: SessionManagerDeps) {}

  private specFor(agentId: string): AgentSpec {
    if (agentId === 'default') {
      const cfg = this.deps.config.get();
      return {
        id: 'default',
        name: 'Vodo',
        systemPrompt: cfg.systemPrompt,
        ...(cfg.thinkingDefault ? { thinking: { enabled: true } } : {}),
      };
    }
    const spec = this.deps.config.get().agents.find((a) => a.id === agentId);
    if (!spec) throw new Error(`Unknown agent "${agentId}".`);
    return spec;
  }

  private agentSpecSafe(sessionId: string): AgentSpec | undefined {
    const meta = this.deps.projects.meta(sessionId);
    if (!meta) return undefined;
    try {
      return this.specFor(meta.agentId);
    } catch {
      return undefined;
    }
  }

  private projectDirFor(sessionId: string): string | undefined {
    const meta = this.deps.projects.meta(sessionId);
    if (!meta) return undefined;
    // A folder attached to THIS chat wins over the project's folder — that's
    // the "point a chat at any folder" affordance (catalog photos, review code).
    if (meta.dir) return meta.dir;
    return this.deps.projects.list().projects.find((p) => p.id === meta.projectId)?.dir;
  }

  /** Smart context on for this session's project (and the bank is available)? */
  private assembleEnabled(sessionId: string): string | null {
    if (!this.deps.bank) return null;
    const meta = this.deps.projects.meta(sessionId);
    if (!meta) return null;
    const project = this.deps.projects.list().projects.find((p) => p.id === meta.projectId);
    return project?.assemble ? project.id : null;
  }

  /**
   * The buffer cut: keep ~ASSEMBLE_BUFFER_CHARS of recent turns, then snap
   * FORWARD to the next user message so the request always opens on a user
   * turn and tool_call/result pairs are never split. 0 = full replay.
   */
  private bufferCut(history: readonly HarnessMessage[]): number {
    if (history.length <= ASSEMBLE_MIN_MESSAGES) return 0;
    let chars = 0;
    let over = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      chars += approxChars(history[i]!);
      if (chars > ASSEMBLE_BUFFER_CHARS) {
        over = i;
        break;
      }
      if (i === 0) return 0; // whole history fits the buffer budget
    }
    for (let k = over; k < history.length; k++) {
      if (history[k]!.role === 'user') return k;
    }
    return 0;
  }

  /** Window-as-buffer briefing, appended to the prompt when assembly is on. */
  private assemblyNote(sessionId: string): string {
    const projectId = this.assembleEnabled(sessionId);
    if (!projectId) return '';
    const digest = this.deps.bank!.digest(projectId);
    return (
      '\n\nSMART CONTEXT IS ON: older turns of this conversation are NOT replayed — your working ' +
      'context is this project briefing plus the most recent messages. Durable project knowledge:\n' +
      (digest || '(the map is still filling in)') +
      '\nFor anything older or verbatim, use archive_search / archive_read / map_query — the full ' +
      'record always exists.'
    );
  }

  /** Folder-backed projects: tell the agent it has hands and where they work. */
  private projectized(spec: AgentSpec, sessionId: string): AgentSpec {
    const dir = this.projectDirFor(sessionId);
    const builtinNote = this.deps.builtins
      ? `\n\nCurrent local date-time: ${fmtStamp(Date.now())}.\n` +
        'You can always search the web (web_search, then web_fetch to read a result) and run ' +
        'background missions (mission_create / mission_list / mission_control) — use a mission for ' +
        'long or repeating work instead of doing it inline. You also have cross-everything memory: ' +
        'memory_recall searches the timestamped journal of ALL activity (every chat in every ' +
        'project, missions, Telegram, file writes, commands) — use it for questions about what the ' +
        'user was doing at some time or in some project. memory_note pins a durable fact there. ' +
        'For what was actually SAID, archive_search full-text-searches the lossless verbatim ' +
        'archive of all conversations, and archive_read pulls the exact surrounding turns. ' +
        "map_query reads the project's memory map (durable decisions/components/tasks/facts with " +
        'links); map_update corrects it. image_generate renders images with the configured image ' +
        "model into the project's designs/ folder — use it for mockups, icons, art."
      : '';
    const assembly = this.assemblyNote(sessionId);
    const planNote =
      this.deps.config.get().approvalMode === 'plan'
        ? '\n\nPLAN MODE IS ON: make NO changes — mutating tools (ws_write, ws_run, mission ' +
          'creation, MCP actions) are disabled and will not execute. Explore with read-only ' +
          'tools if needed, then answer with a concrete numbered plan: what files change, what ' +
          'commands run, what the risks are. The user flips to Auto or Manual to execute it.'
        : '';
    if (!dir) {
      return builtinNote || assembly || planNote
        ? { ...spec, systemPrompt: `${spec.systemPrompt ?? ''}${builtinNote}${assembly}${planNote}` }
        : spec;
    }
    // A folder attached directly to the chat is an INSPECTION surface (catalog
    // photos, review code, dig through files) — different framing than a
    // project folder, where the agent is expected to build.
    if (this.deps.projects.meta(sessionId)?.dir) {
      return {
        ...spec,
        systemPrompt:
          `${spec.systemPrompt ?? ''}\n\n` +
          `The user attached the folder "${dir}" to this chat — work with its CONTENTS directly: ` +
          `ws_list (browse, pass a path for subfolders), ws_read (read any text/code file), ` +
          `look_at_image (SEE an image file — the vision model describes it in detail; camera RAW ` +
          `files like NEF/CR2/ARW work too via their embedded preview), file_identify (decode ` +
          `camera/app naming schemes and formats from file names — which device shot it, dates), ` +
          `ws_write (save notes/reports/catalogs into the folder), ws_run (run commands there).\n` +
          `- Cataloging photos: ws_list the images, file_identify the names (source camera + ` +
          `dates), look_at_image EACH one, then ws_write a catalog (e.g. catalog.md) with one ` +
          `entry per photo — subject, light, colors, and especially the mood/feel — so photos ` +
          `can be found later by vibe ("the moody one", "sunny beach"). Skip the RAW twin when ` +
          `a RAW+JPEG pair exists. If a catalog file already exists, read it first and extend it.\n` +
          `- Finding a photo by feel: ws_read the catalog if there is one and match from it ` +
          `before re-looking at images.\n` +
          `- Reviewing code: ws_list, ws_read the key files, give concrete findings with ` +
          `file references.\n` +
          `Do the work yourself with the tools instead of instructing the user.` +
          `${builtinNote}${assembly}${planNote}`,
      };
    }
    return {
      ...spec,
      systemPrompt:
        `${spec.systemPrompt ?? ''}\n\n` +
        `You are working in the project folder "${dir}". You have direct workspace tools: ` +
        `ws_list (see files), ws_read (read a file), ws_write (create/overwrite a file), ` +
        `ws_run (run shell commands like npm install, npm run build, tests), and ` +
        `look_at_image (SEE an image file in the folder — the vision model describes it). ` +
        `DO THE WORK YOURSELF with these tools — write the files and run the commands instead of ` +
        `giving the user manual instructions.\n` +
        `HARD RULES:\n` +
        `- NEVER end a reply by telling the user to run a command ("To deploy: npm run build", ` +
        `"cd X && …", "rebuild and test"). If a command is worth mentioning, YOU run it with ` +
        `ws_run and report its output instead.\n` +
        `- After changing files, ALWAYS verify: run the build/tests/linter with ws_run (or open ` +
        `the entry file check) BEFORE answering. A reply about code changes must end with what ` +
        `you ran and what happened, not with homework for the user.\n` +
        `- To LAUNCH the built app or a dev server for the user to try, call ws_run with ` +
        `background:true — it starts the process and returns at once. NEVER launch a GUI app or a ` +
        `server with a normal ws_run: it never exits, so the turn would hang.\n` +
        `- Only destructive commands (deleting data, force-push, system changes) need asking first.` +
        `${builtinNote}${assembly}${planNote}`,
    };
  }

  private sessionFor(sessionId: string): AgentSession {
    const meta = this.deps.projects.meta(sessionId);
    if (!meta) throw new Error(`Unknown chat session "${sessionId}".`);
    let session = this.sessions.get(sessionId);
    if (session) {
      // Pick up agent edits (or a switched agent) since the last send.
      session.spec = this.projectized(this.specFor(meta.agentId), sessionId);
      return session;
    }
    session = new AgentSession({
      id: sessionId,
      spec: this.projectized(this.specFor(meta.agentId), sessionId),
      // Building a real app takes many steps (install → build → fix → rebuild →
      // verify → launch); 16 was far too few and cut off mid-task. 60 gives room
      // while still backstopping a runaway loop — and the pause is now a "say
      // continue" check-in, not a dead error.
      maxToolTurns: 60,
      // Window-as-buffer: checked at send time, so the Memory-view toggle
      // applies to live sessions immediately.
      contextStart: (history) =>
        this.assembleEnabled(sessionId) ? this.bufferCut(history) : 0,
      // Old images stop handcuffing every later turn to vision models: when
      // the resolved model explicitly can't see, image parts become text
      // stubs instead of a provider 400.
      prepareMessages: (messages, bound) => {
        if (this.deps.modelCanSee?.(bound.model) !== false) return [...messages];
        return messages.map((m) =>
          m.role === 'user' && m.content.some((p) => p.type === 'image')
            ? {
                ...m,
                content: m.content.map((p) =>
                  p.type === 'image' ? ({ type: 'text', text: IMAGE_STUB } as const) : p,
                ),
              }
            : m,
        );
      },
      resolve: (spec) => {
        const { defaultProvider, defaultModel } = this.deps.config.get();
        const bound = this.deps.hub
          .registry()
          .resolve(spec, { provider: defaultProvider, model: defaultModel });
        this.lastBound.set(sessionId, bound);
        return bound;
      },
      emit: (sid, event) => {
        this.deps.send(IPC.chatEvent, { sessionId: sid, event });
        this.deps.onEvent?.(sid, event);
        if (event.type === 'usage') {
          this.deps.onUsage?.(sid, this.lastBound.get(sid), event);
        }
        if (event.type === 'status' && event.status === 'idle') this.persist(sid);
      },
      toolExecutor: {
        tools: () => {
          const dir = this.projectDirFor(sessionId);
          return [
            ...(dir ? [...workspaceToolSpecs(dir), ...lookToolSpecs()] : []),
            ...(this.deps.builtins?.specs() ?? []),
            ...this.deps.mcp.toolsFor(this.agentSpecSafe(sessionId)?.mcpServers),
          ];
        },
        execute: (name, args, signal) => {
          // Plan mode: read-only tools work; anything mutating is blocked
          // with feedback the model can plan around instead of a bare denial.
          if (
            this.deps.config.get().approvalMode === 'plan' &&
            !AUTO_ALLOWED_TOOLS.has(name)
          ) {
            return Promise.resolve({
              content:
                'PLAN MODE: execution is disabled — this call was not run. Do not retry it. ' +
                'Gather what you need with read-only tools, then present a numbered plan; the ' +
                'user switches to Auto or Manual to execute.',
              isError: true,
            });
          }
          if (name.startsWith('ws_')) {
            const dir = this.projectDirFor(sessionId);
            if (!dir) {
              return Promise.resolve({
                content: 'This chat belongs to a project without a folder.',
                isError: true,
              });
            }
            return executeWorkspaceTool(dir, name, args, signal);
          }
          if (
            this.deps.builtins &&
            (name.startsWith('web_') ||
              name.startsWith('mission_') ||
              name.startsWith('memory_') ||
              name.startsWith('archive_') ||
              name.startsWith('map_') ||
              name.startsWith('image_') ||
              name.startsWith('look_') ||
              name.startsWith('file_'))
          ) {
            // The session knows its own project — tools default to it instead
            // of making the model guess a name. dir carries the chat's folder
            // (attached or project) for look_at_image / image saves.
            return this.deps.builtins.execute(name, args, {
              projectId: this.deps.projects.meta(sessionId)?.projectId,
              dir: this.projectDirFor(sessionId),
            });
          }
          return this.deps.mcp.call(name, args);
        },
      },
      permission: (req) => this.requestPermission(sessionId, req.name, req.args),
    });
    session.history.push(...this.deps.projects.loadTranscript(sessionId));
    this.sessions.set(sessionId, session);
    return session;
  }

  historyOf(sessionId: string): HarnessMessage[] {
    return this.sessions.get(sessionId)?.history ?? this.deps.projects.loadTranscript(sessionId);
  }

  /** The provider/model that served this session's last run (routing strikes). */
  boundOf(sessionId: string): BoundModel | undefined {
    return this.lastBound.get(sessionId);
  }

  send(
    sessionId: string,
    parts: UserPart[],
    override?: { provider?: string; model?: string },
    specOverride?: AgentSpec,
  ): SendResult {
    try {
      const session = this.sessionFor(sessionId);
      // Vodo delegation: this turn runs with the specialist's full spec
      // (prompt, tools, model); the next send re-resolves from the meta.
      if (specOverride) session.spec = this.projectized(specOverride, sessionId);
      const result = session.send(parts, override);
      if (result.ok) this.persist(sessionId);
      return result;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Context compaction: replace the conversation with a model-written summary
   * so the next turn replays a fraction of the tokens. The summary is produced
   * by the cheapest adequate model — compacting should cost less than the
   * bloat it removes.
   */
  async compact(sessionId: string): Promise<{ ok: boolean; summary?: string; error?: string }> {
    try {
      const session = this.sessionFor(sessionId);
      if (session.getStatus() !== 'idle') {
        return { ok: false, error: 'Wait for the current run to finish first.' };
      }
      if (session.history.length < 4) {
        return { ok: false, error: 'Nothing worth compacting yet.' };
      }

      // Flatten the transcript (recent tail wins if it's enormous).
      const lines: string[] = [];
      for (const msg of session.history) {
        if (msg.role === 'user') {
          const text = msg.content
            .map((p) => (p.type === 'text' ? p.text : `[${p.type}]`))
            .join(' ');
          lines.push(`USER: ${text}`);
        } else if (msg.role === 'assistant') {
          for (const part of msg.content) {
            if (part.type === 'text' && part.text) lines.push(`ASSISTANT: ${part.text}`);
            else if (part.type === 'tool_call') {
              lines.push(`ASSISTANT ran ${part.name}(${JSON.stringify(part.args ?? {}).slice(0, 120)})`);
            }
          }
        } else {
          lines.push(`TOOL RESULT: ${msg.content.slice(0, 400)}`);
        }
      }
      let transcript = lines.join('\n');
      if (transcript.length > 90_000) transcript = `…\n${transcript.slice(-90_000)}`;

      const prompt =
        'Compact this conversation into a continuation briefing for yourself. Preserve: the goals, ' +
        'every decision made, current state of any work (files, commands, results), open questions, ' +
        'and user preferences. Drop pleasantries and dead ends. Write it dense but complete:\n\n' +
        transcript;

      const pick = await this.deps.pickCheap?.(prompt.slice(0, 2000)).catch(() => undefined);
      const spec = session.spec;
      const bound = this.deps.hub
        .registry()
        .resolve(pick ? { ...spec, provider: pick.provider, model: pick.model } : spec, {
          provider: this.deps.config.get().defaultProvider,
          model: this.deps.config.get().defaultModel,
        });

      let summary = '';
      let errorMsg: string | undefined;
      for await (const event of bound.provider.stream(
        {
          model: bound.model,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        },
        { signal: new AbortController().signal },
      )) {
        if (event.type === 'text_delta') summary += event.text;
        else if (event.type === 'error') errorMsg = event.error.message;
      }
      summary = summary.trim();
      if (!summary) return { ok: false, error: errorMsg ?? 'The summarizer returned nothing.' };

      session.history.length = 0;
      session.history.push(
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `[Conversation compacted to save context] Continuation briefing:\n\n${summary}`,
            },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Got it — continuing from that briefing.' }],
        },
      );
      this.persist(sessionId);
      return { ok: true, summary };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  inject(sessionId: string, parts: UserPart[]): SendResult {
    try {
      const result = this.sessionFor(sessionId).inject(parts);
      if (result.ok) this.persist(sessionId);
      return result;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  stop(sessionId: string): void {
    this.sessions.get(sessionId)?.stop();
  }

  reset(sessionId: string): void {
    this.sessions.get(sessionId)?.reset();
    this.deps.projects.saveTranscript(sessionId, []);
    this.deps.projects.touch(sessionId);
    this.deps.send(IPC.projectsChanged, this.deps.projects.list());
  }

  setAgent(sessionId: string, agentId: string): void {
    this.deps.projects.setAgent(sessionId, agentId);
    const live = this.sessions.get(sessionId);
    if (live) {
      try {
        live.spec = this.specFor(agentId);
      } catch {
        /* unknown agent — next send reports it */
      }
    }
  }

  dropLive(sessionId: string): void {
    const live = this.sessions.get(sessionId);
    if (live) {
      live.stop();
      this.sessions.delete(sessionId);
    }
  }

  private persist(sessionId: string): void {
    const live = this.sessions.get(sessionId);
    if (!live) return;
    this.deps.projects.saveTranscript(sessionId, live.history);
    const meta = this.deps.projects.meta(sessionId);
    if (meta) this.deps.bank?.syncSession(meta.projectId, sessionId, live.history);
    const firstUser = live.history.find((m) => m.role === 'user');
    const firstText =
      firstUser && firstUser.role === 'user'
        ? firstUser.content
            .filter((p): p is Extract<UserPart, { type: 'text' }> => p.type === 'text')
            .map((p) => p.text)
            .join(' ')
            .trim()
        : '';
    this.deps.projects.touch(sessionId, firstText || undefined);
    this.deps.send(IPC.projectsChanged, this.deps.projects.list());
  }

  private requestPermission(
    sessionId: string,
    name: string,
    args: unknown,
  ): Promise<PermissionDecision> {
    if (AUTO_ALLOWED_TOOLS.has(name)) return Promise.resolve('allow');
    const mode = this.deps.config.get().approvalMode;
    // Auto: the user opted into autonomous agents. Plan: allow through so the
    // executor's plan-mode block answers instructively (no modal either way).
    // Destructive infra tools still enforce their own confirm tier downstream.
    if (mode === 'auto' || mode === 'plan') return Promise.resolve('allow');
    return new Promise((resolve) => {
      const requestId = `perm_${++this.permSeq}`;
      this.pendingPermissions.set(requestId, resolve);
      const prompt: PermissionPrompt = {
        requestId,
        sessionId,
        agentName: this.agentSpecSafe(sessionId)?.name ?? 'Agent',
        name,
        args,
      };
      this.deps.send(IPC.permissionRequest, prompt);
      setTimeout(() => {
        if (this.pendingPermissions.delete(requestId)) resolve('deny');
      }, PERMISSION_TIMEOUT_MS);
    });
  }

  respondPermission(requestId: string, decision: PermissionDecision): void {
    const resolve = this.pendingPermissions.get(requestId);
    if (resolve) {
      this.pendingPermissions.delete(requestId);
      resolve(decision);
    }
  }
}
