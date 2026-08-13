import {
  AgentSession,
  type McpClientManager,
  type PermissionDecision,
  type SessionEvent,
} from '@vo-coder/core';
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { AgentSpec, BoundModel, HarnessMessage, ToolSpec, UserPart } from '@vo-coder/providers';
import { IPC, type PermissionPrompt, type SendResult } from '../shared/ipc-contract';
import { isAudioPath } from '../shared/media';
import type { ConfigStore } from './config';
import type { ProjectStore } from './projects';
import type { ProviderHub } from './providers';
import { ALWAYS_CONFIRM_TOOLS, AUTO_ALLOWED_TOOLS } from './tool-policy';
import { lookToolSpecs } from './vision-look';
import { globalRulesNote, projectMdNote } from './project-md';
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
      ctx?: { projectId?: string; dir?: string; sessionId?: string; signal?: AbortSignal },
    ): Promise<{
      content: string;
      isError?: boolean;
      imagePath?: string;
      videoPath?: string;
      audioPath?: string;
    }>;
  };
  /** Fired for every provider usage report, with the model that produced it. */
  onUsage?: (
    sessionId: string,
    bound: BoundModel | undefined,
    usage: { inputTokens: number; outputTokens: number },
  ) => void;
  /** Observer for session events (activity journaling). */
  onEvent?: (sessionId: string, event: SessionEvent) => void;
  /** Cheapest-adequate model pick for internal jobs (context compaction). */
  pickCheap?: (
    text: string,
  ) => Promise<{ provider: string; model: string } | undefined>;
  /**
   * Fold pending turns into the map now (normally it happens in the
   * background on every persist). Awaited only by "consolidate".
   */
  distill?: (projectId: string, sessionId: string) => Promise<void>;
  /** Lossless archive — new turns sync on every persist. */
  bank?: {
    syncSession(projectId: string, sessionId: string, history: HarnessMessage[]): void;
    /** Bounded map briefing, ranked against the current message when given. */
    digest(projectId: string, maxChars?: number, query?: string): string;
  };
  /** Catalog lookup: does this model accept image input? undefined = unknown. */
  modelCanSee?: (modelId: string) => boolean | undefined;
  /** Catalog lookup: what an agent's model is and can do. */
  agentProfile?: (agent: AgentSpec) => {
    quality?: number;
    vision?: boolean;
    tools?: boolean;
    image?: boolean;
  };
  /** Agent id -> title of the running mission holding it. */
  busyAgents?: () => Map<string, string>;
  /** The skills catalog note (empty when no skills are installed/enabled). */
  skillsCatalog?: () => string;
}

const IMAGE_STUB =
  '[image attachment from earlier in this conversation — not visible to the current model; ' +
  'ask the user or route to a vision model if its contents matter now]';

/** Window-as-buffer tuning: only kicks in past this many messages… */
const ASSEMBLE_MIN_MESSAGES = 12;
/** …and keeps roughly this many chars (~5k tokens) of recent turns verbatim. */
const ASSEMBLE_BUFFER_CHARS = 20_000;

/** How recently a file must have been written to count as "the agent made this". */
const AUDIO_FRESH_MS = 5 * 60_000;

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

/** Everything that reads or writes the project's memory, in one place. */
const MEMORY_TOOLS = new Set([
  'memory_recall',
  'memory_note',
  'map_query',
  'map_update',
  'archive_search',
  'archive_read',
]);

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

  /**
   * The spec ACTUALLY running this session. During delegation that is the
   * specialist Vodo handed the turn to, not the session's stored agent —
   * reading `meta.agentId` there returned Vodo, whose `mcpServers` is unset,
   * which the MCP layer reads as "every connected server". A delegated
   * specialist therefore silently received every tool in the app instead of
   * the subset it was given, and the permission prompt named the wrong agent.
   */
  private agentSpecSafe(sessionId: string): AgentSpec | undefined {
    const live = this.sessions.get(sessionId)?.spec;
    if (live) return live;
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
    const projectDir = this.deps.projects.list().projects.find(
      (p) => p.id === meta.projectId,
    )?.dir;
    if (projectDir) return projectDir;
    // Floor of the cascade: the app's generic scratch folder. Every chat can
    // always write SOMETHING (a file, an image, temp work) — ws_write never
    // dead-ends again. Real projects still need their own folder.
    return this.deps.config.get().genericDir || undefined;
  }

  /**
   * Smart context for this session's project. ON BY DEFAULT — the memory bank
   * is the whole point: the window carries a briefing plus recent turns, and
   * everything older stays one archive_search away. `assemble: false` is an
   * explicit opt-OUT back to full replay; unset means on.
   */
  private assembleEnabled(sessionId: string): string | null {
    if (!this.deps.bank) return null;
    const meta = this.deps.projects.meta(sessionId);
    if (!meta) return null;
    const project = this.deps.projects.list().projects.find((p) => p.id === meta.projectId);
    if (!project) return null;
    return project.assemble === false ? null : project.id;
  }

  /**
   * Does this session's agent carry the project between jobs?
   *
   * Deliberately separate from assembleEnabled, which governs the WINDOW. That
   * one gate controls both the briefing and the history trimming, so hanging
   * "no memory" off it would drop the briefing AND put the agent back to
   * replaying its whole history every turn — more context, not less, which is
   * the opposite of the point.
   *
   * Reads the LIVE spec: during delegation the running agent is the specialist
   * Vodo handed the turn to, not the session's stored agent.
   */
  private agentCarriesMemory(sessionId: string): boolean {
    return this.agentSpecSafe(sessionId)?.memory !== false;
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

  /** Agents available to share work with — below two there is no group. */
  private teamSize(): number {
    return this.deps.config.get().agents.length;
  }

  /**
   * The roster: each agent's model, how strong it is, what its model can do,
   * and which MCP servers it holds. Without this the coordinator was splitting
   * work blind — it knew NAMES and hints but not that one agent runs a 27B and
   * another a 4B, nor that only one of them can see an image or reach GitHub.
   * So the hardest part landed wherever the keyword match fell, and a part
   * needing a tool went to someone who does not have it.
   */
  private rosterNote(): string {
    const agents = this.deps.config.get().agents.filter((a) => a.enabled !== false);
    if (agents.length < 2) return '';
    const band = (q: number | undefined): string =>
      q === undefined ? 'unrated' : q >= 9 ? 'top' : q >= 7 ? 'strong' : q >= 5 ? 'mid' : 'small';
    const onMission = this.deps.busyAgents?.() ?? new Map<string, string>();
    const lines = agents.map((a) => {
      const p = this.deps.agentProfile?.(a) ?? {};
      const can: string[] = [];
      if (p.vision) can.push('sees images');
      if (p.image) can.push('makes images');
      // Only ever stated when the catalog is SURE: silence means unknown, and
      // "no tools" is the one claim that would wrongly bench a working agent.
      if (p.tools === false) can.push('NO tool use — cannot build, only write text');
      if (a.thinking?.enabled) can.push('extended thinking');
      const mcp = (a.mcpServers ?? []).filter(Boolean);
      const hints = a.routingHints?.trim();
      const busy = onMission.get(a.id);
      return (
        `- ${a.name} — ${a.model ?? '(app default)'} [${band(p.quality)}]` +
        (can.length ? ` · ${can.join(', ')}` : '') +
        (mcp.length ? ` · MCP: ${mcp.join(', ')}` : ' · no MCP servers') +
        (hints ? ` · good at: ${hints}` : '') +
        (a.memory === false ? ' · NO project memory' : '') +
        (busy ? ` · BUSY — on the mission "${busy}", do not give it work` : '')
      );
    });
    return (
      '\n\nYOUR TEAM:\n' +
      lines.join('\n') +
      '\nStrength is the model behind each agent, not its job title. Give the part that needs the ' +
      'most reasoning — architecture, scaffolding, anything intricate — to a strong agent, and ' +
      'keep the small ones for mechanical work. A "small" model given the hardest part will ' +
      'produce something that looks finished and is not.\n' +
      'MCP servers are the only outside reach an agent has: a part needing GitHub, a database or ' +
      'infrastructure must go to someone who holds that server, or it will improvise instead of ' +
      'doing it. Image work needs an agent whose model actually sees or makes images. Every agent ' +
      'has the file and web tools regardless.\n' +
      'An agent marked NO project memory carries nothing between jobs and cannot read the memory ' +
      'map: it sees only the code and what YOU write in its instructions. That is deliberate — it ' +
      'keeps a worker on its own part — but it means the background it needs has to go INTO the ' +
      'brief. Do not point such an agent at the map, at another agent, or at "what we decided ' +
      'earlier"; write the decision out. It will ask you when something is missing, and answering ' +
      'that is your job.\n' +
      'When the user names one of these agents while talking to YOU, that is an instruction to you ' +
      'about that agent — they did not hear it. Carry it out: brief them and start the work.'
    );
  }

  /** Window-as-buffer briefing, appended to the prompt when assembly is on. */
  private assemblyNote(sessionId: string): string {
    const projectId = this.assembleEnabled(sessionId);
    if (!projectId) return '';
    // Hired help: no briefing, but the note cannot simply vanish. The window is
    // still trimmed, and this prose is the ONLY thing telling the agent its
    // older turns are not replayed — without it the agent believes it can see a
    // conversation it cannot, and answers from a history it does not have.
    if (!this.agentCarriesMemory(sessionId)) {
      return (
        '\n\nYOUR WORKING CONTEXT IS BOUNDED: older turns of this conversation are NOT replayed, ' +
        'only the most recent ones. You also carry NO project briefing — that is deliberate, not ' +
        'an oversight. You are working on the part you were given, from the instructions you were ' +
        'given and the code in front of you. Do that part and nothing else. If something you need ' +
        'is missing — a decision, a convention, what another agent is doing — ask your coordinator ' +
        'rather than guessing or going looking: they hold the whole picture and you do not.'
      );
    }
    // No per-message query ranking: reshuffling the briefing every turn
    // breaks local models' prompt caching exactly like a timestamp does (the
    // box re-prefills the whole context each reply). Stable ordering — active
    // tasks first, then recency — changes only when the MAP changes; the
    // model reaches for map_query/archive_search when it needs relevance.
    const digest = this.deps.bank!.digest(projectId, 5_500);
    // A chat bound to its OWN folder shares the project's memory with every
    // older app built under the same project — and "active tasks first" read
    // as marching orders: a fresh folder's chat resumed the OLD app's tasks
    // in the old folder (seen live). The briefing itself must say whose
    // tasks these are.
    const ownFolder = !!this.deps.projects.meta(sessionId)?.dir;
    return (
      '\n\nSMART CONTEXT IS ON: older turns of this conversation are NOT replayed — your working ' +
      'context is this project briefing plus the most recent messages. Durable project knowledge ' +
      '(active tasks first — those are what you are in the middle of):\n' +
      (digest || '(the map is still filling in)') +
      (ownFolder
        ? '\nNOTE: this chat is bound to its OWN folder. Briefing tasks about OTHER folders or ' +
          'apps are background knowledge, NOT your assignment — your assignment is only what ' +
          'the user asks in THIS chat, in THIS folder.'
        : '') +
      '\nFor anything older or verbatim, use archive_search / archive_read / map_query — the full ' +
      'record always exists. When you form or finish a plan, record it with map_update as a "task" ' +
      'node so it survives the window moving on.'
    );
  }

  /** Folder-backed projects: tell the agent it has hands and where they work. */
  private projectized(spec: AgentSpec, sessionId: string): AgentSpec {
    const dir = this.projectDirFor(sessionId);
    // The folder's VO-CODER.md (when present) rides every prompt: its Rules
    // bind the work, its Map orients faster than ws_list. Re-read per send but
    // stable while the file is unchanged, so prompt caches survive; an edit
    // costs one reprefill, which is what an edit is for.
    // The user's own standing rules come first and apply with or without a
    // folder; the project's file is narrower and wins where they disagree.
    const projectNote = globalRulesNote() + (dir ? projectMdNote(dir) : '');
    // The skills card catalog: names + one-liners only; the body loads
    // through skill_read on demand. Stable ordering, so prompt caches hold.
    const skillsNote = this.deps.skillsCatalog?.() ?? '';
    // Worktrees mode: the user's answer to seven features landing on one
    // branch. A standing instruction rather than plumbing — git already does
    // this well, and the agents have a shell.
    const worktreeNote = this.deps.config.get().worktreeMode
      ? '\n\nWORKTREES MODE IS ON — parallel work does NOT share one checkout.\n' +
        '- Before a group starts, make sure the folder is a git repo with its work committed ' +
        '(git status), and note the branch you are starting from — that is where parts come back to.\n' +
        '- Give each member its OWN worktree and branch, created inside this folder so their ' +
        'tools can reach it: `git worktree add .vodo/trees/<agent> -b vodo/<agent>-<short-task>`. ' +
        'Add .vodo/ to .gitignore if it is not there. Name the worktree in that member\'s ' +
        'instruction and tell them to write ONLY inside it.\n' +
        '- A member is done when its part is built and VERIFIED in its own tree, then committed ' +
        'there. Merge the parts back one at a time (`git merge --no-ff vodo/<agent>-…`), building ' +
        'after each. If a merge conflicts, STOP on that one, say which files, and fix it before ' +
        'the next — never force it and never merge a part that has not been verified.\n' +
        '- When a part is merged, clean up after it: `git worktree remove .vodo/trees/<agent>` and ' +
        'delete the branch. Report at the end which parts merged and which are still open.'
      : '';
    // Seen live, verbatim: "he just totally forgott what i asked him and he
    // just kept on working in the other app i told him we could use as base".
    // A chat bound to a fresh folder inherits the project's memory of OLDER
    // apps — and ws_run's shell can reach any path — so the discipline has to
    // be stated exactly where the folder is stated. Same session produced
    // five release-* variant folders in one project root.
    const disciplineNote =
      '\nWORKSPACE DISCIPLINE:\n' +
      '- THIS folder is your ONLY workspace. Other folders — earlier apps, anything the user ' +
      'says to use "as a base", anything the project memory mentions — are REFERENCE ONLY: ' +
      'read them when the user points you there, but NEVER write into them and never resume ' +
      'their old tasks. "Build something like X" means build it HERE, fresh, bringing over ' +
      'only what the user explicitly names.\n' +
      '- Do EXACTLY what was asked — nothing extra, nothing assumed. No bonus refactors, no ' +
      'renames, no "while I was at it". If the request is ambiguous, ask ONE short question ' +
      'instead of guessing.\n' +
      '- BUILDS ARE VERSIONED: bump the version (package.json or equivalent — 0.1.1 becomes ' +
      '0.1.2) BEFORE every installer/package build, and name that version when you report. ' +
      'Never two builds under one version.\n' +
      '- ONE build-output folder, reused for every build (release/, dist/ — whatever this ' +
      'project already uses). NEVER invent side folders like release-fix or build-2: versions ' +
      'tell builds apart, folder names do not. Stray build folders are clutter — offer to ' +
      'delete them.\n' +
      '- TEAM PAPERWORK lives under .vodo/team/ — blueprints, block files, and any notes, ' +
      'reports or checklists written for other agents or for review go there, NEVER into the ' +
      'project root or docs/. Seen live: a project grew 330 coordination files. Your report ' +
      'to the USER is your chat reply, not another file; the durable trail is the memory map.\n' +
      '- WHAT YOU START, YOU STOP. Launching the app or a dev server to check something is ' +
      'fine — leaving it running is not. Call ws_stop as soon as you have seen what you ' +
      'needed, and never launch a second copy of something already up (ws_stop with no ' +
      'arguments lists what is running). Seen live: an unattended run left NINETEEN copies of ' +
      'the same app open. The only exception is a server the USER asked you to leave running ' +
      'for them — say so in your reply when you do.';
    // DATE only, never time-of-day: this string sits at the top of the system
    // prompt, and anything that changes per turn breaks local models' prompt
    // caching — the box then re-reads the ENTIRE context before every reply
    // (measured live: ~6k tokens = 25-36s of "waiting for first token" per
    // turn on LM Studio). One stable prefix = one prefill per conversation.
    const builtinNote = this.deps.builtins
      ? `\n\nToday's date: ${new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })} (exact time via your tools when it matters).\n` +
        'You can always search the web (web_search, then web_fetch to read a result) and run ' +
        'background missions (mission_create / mission_list / mission_control) — use a mission for ' +
        'long or repeating work instead of doing it inline. ' +
        // Only describe the memory tools to an agent that HAS them. Telling
        // hired help about map_query is a false instruction, and a model that
        // is told to use a tool it cannot see tries, fails, and improvises.
        (this.agentCarriesMemory(sessionId)
          ? 'You also have cross-everything memory: ' +
            'memory_recall searches the timestamped journal of ALL activity (every chat in every ' +
            'project, missions, Telegram, file writes, commands) — use it for questions about what ' +
            'the user was doing at some time or in some project. memory_note pins a durable fact ' +
            'there. For what was actually SAID, archive_search full-text-searches the lossless ' +
            'verbatim archive of all conversations, and archive_read pulls the exact surrounding ' +
            "turns. map_query reads the project's memory map (durable decisions/components/tasks/" +
            'facts with links); map_update corrects it. '
          : '') +
        'image_generate renders images with the configured image ' +
        "model into the project's designs/ folder — use it for mockups, icons, art; the result " +
        'appears in the chat by itself, so never open Preview to show a picture you just made. ' +
        // Seen live: asked to speak, an agent went looking for the user's Groq
        // key in the shell environment. Keys belong to the app.
        "The app holds the user's API keys and hands them to the right service itself — never go " +
        'hunting for keys in the shell, the environment, or config files, and never ask the user ' +
        'to paste one into a chat.'
      : '';
    // Without this, "speak to me" reads as "go synthesize audio": the model has
    // no idea the harness is already reading its replies aloud, so it shells
    // out looking for a TTS endpoint instead of just answering.
    const voiceNote =
      this.deps.builtins && this.deps.config.get().voice.tts !== 'none'
        ? '\n\nVOICE OUTPUT IS ON: the app reads your replies aloud in the voice the user chose, ' +
          'and Live mode is a microphone loop around this same chat. You have no audio tools and ' +
          'cannot make sound yourself — when asked to speak, just reply in plain sentences. Short ' +
          'ones sound better aloud; skip code blocks and tables unless they were asked for.'
        : '';
    // Coordinating is the default agent's job, not a specialist's: a member
    // already inside a group must get on with its own part rather than
    // splitting it again. The judgement is deliberately left to the model —
    // whether a job has genuinely independent parts is reasoning about the
    // work, not something a keyword rule can decide.
    const teamNote =
      this.deps.builtins && spec.id === 'default' && this.teamSize() >= 2
        ? '\n\nYOU HAVE A TEAM. Before starting anything substantial, work out whether the job ' +
          'has parts that can be done AT THE SAME TIME — different files, different components, ' +
          'research alongside implementation, tests alongside the feature. Research usually ' +
          'splits by subtopic, source or period; building splits by file or layer; writing ' +
          'splits into gathering material alongside drafting structure. A part that will ' +
          'eventually use another part’s output still counts, provided it can START now.\n' +
          'PLAN OUT LOUD FIRST: say what each part is, which agent takes it and why. THEN call ' +
          'group_start with those parts — never before you have said the plan, because that call ' +
          'opens a chat per part and the user should see what they are getting. Afterwards, say ' +
          'who is doing what and let them work: do not redo their parts yourself.\n' +
          'If the work is genuinely sequential (each step needs the one before it) or small, ' +
          'just do it — and say briefly why you are not splitting it.\n' +
          'ONE BIG DELIVERABLE splits too: ws_write a BLUEPRINT at .vodo/team/BLUEPRINT.md ' +
          '(skeleton, contracts, numbered block list), make each part one block with its exact ' +
          'file path (.vodo/team/blocks/01_…, .vodo/team/blocks/02_…), and when the blocks ' +
          'land merge them with one ws_assemble call in blueprint order, into the real ' +
          'deliverable path. Blocks that depend on other blocks still parallelise — the ' +
          'blueprint contract is what decouples them.' +
          this.rosterNote()
        : '';
    const assembly = this.assemblyNote(sessionId);
    // The boss's own chat while his group runs. Routing rightly pins the
    // user's messages to Vodo here — and then nothing told him a mid-run
    // request is an ASSIGNMENT. Seen live: three members idle, the user asked
    // for an addition, and Vodo built it himself while the team sat waiting.
    // Recomputed per send, so it appears when a group starts and leaves when
    // it ends (one reprefill each — the coordinator seat is a cloud model).
    const bossNote =
      this.deps.builtins &&
      this.deps.projects.groups().some((g) => !g.endedAt && g.coordinatorId === sessionId)
        ? '\n\nA GROUP YOU COORDINATE IS RUNNING. Anything the user asks for mid-run is work ' +
          'to DELEGATE, not work to do: group_status to see who is idle, then group_send the ' +
          'request to the best-fitting member with the complete instruction. Members cannot ' +
          'see this chat — only group_send reaches them. Pick up the tools yourself ONLY when ' +
          'no member has them, a member has failed the step twice, or THE USER TELLS YOU TO. ' +
          'That last one is not a judgement call: "you do it", "stop using the agents", "not ' +
          'the agents" IS the instruction, and handing it to a member anyway is disobeying it. ' +
          'Do that job with your own tools and say plainly that you took it. Your seat is ' +
          'oversight: watch, review, dispatch. Idle members are spare capacity — when follow-ups, fixes, ' +
          'checks or queued parts exist, spread them across whoever is idle rather than letting ' +
          'the team sit while one member (or you) carries everything; even a trivial job ' +
          'lightens the load.'
        : '';
    const planNote =
      this.deps.config.get().approvalMode === 'plan'
        ? '\n\nPLAN MODE IS ON: make NO changes — mutating tools (ws_write, ws_run, mission ' +
          'creation, MCP actions) are disabled and will not execute. Explore with read-only ' +
          'tools if needed, then answer with a concrete numbered plan: what files change, what ' +
          'commands run, what the risks are. The user flips to Auto or Manual to execute it.'
        : '';
    if (!dir) {
      return builtinNote || skillsNote || worktreeNote || voiceNote || teamNote || bossNote || assembly || planNote
        ? {
            ...spec,
            systemPrompt: `${spec.systemPrompt ?? ''}${builtinNote}${skillsNote}${worktreeNote}${voiceNote}${teamNote}${bossNote}${projectNote}${assembly}${planNote}`,
          }
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
          `${disciplineNote}` +
          `${builtinNote}${skillsNote}${worktreeNote}${voiceNote}${teamNote}${bossNote}${projectNote}${assembly}${planNote}`,
      };
    }
    // The generic scratch folder: a floor, not a home. Loose deliverables
    // land here; anything project-shaped should get a real folder attached.
    if (dir === this.deps.config.get().genericDir) {
      return {
        ...spec,
        systemPrompt:
          `${spec.systemPrompt ?? ''}\n\n` +
          `This chat has no project folder, so it works in the app's GENERIC folder "${dir}" — ` +
          `a scratch space for loose deliverables: a single file, an image, a quick script, temp ` +
          `work. ws_list / ws_read / ws_write / ws_run and look_at_image operate there, so DO ` +
          `the work yourself with the tools. It is NOT a project home: if the work grows into ` +
          `multiple files, a build, or a group project, ask the user to attach a real project ` +
          `folder (the folder button next to the composer) instead of building it in the ` +
          `generic folder.` +
          `${builtinNote}${skillsNote}${worktreeNote}${voiceNote}${teamNote}${bossNote}${projectNote}${assembly}${planNote}`,
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
        `${disciplineNote}` +
        `${builtinNote}${skillsNote}${worktreeNote}${voiceNote}${teamNote}${bossNote}${projectNote}${assembly}${planNote}`,
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
          // Hired help gets no memory tools: fewer places to look, and nothing
          // it reads can be another agent's half-formed plan. Everything it
          // needs comes from its brief, the code, and asking the coordinator.
          const builtins = (this.deps.builtins?.specs() ?? []).filter(
            (t) => this.agentCarriesMemory(sessionId) || !MEMORY_TOOLS.has(t.name),
          );
          return [
            ...(dir ? [...workspaceToolSpecs(dir), ...lookToolSpecs()] : []),
            ...builtins,
            ...this.deps.mcp.toolsFor(this.agentSpecSafe(sessionId)?.mcpServers),
          ];
        },
        execute: (name, args, signal) =>
          this.withMedia(sessionId, args, this.runTool(sessionId, name, args, signal)),
      },
      permission: (req) => this.requestPermission(sessionId, req.name, req.args),
    });
    session.history.push(...this.deps.projects.loadTranscript(sessionId));
    this.sessions.set(sessionId, session);
    return session;
  }

  private runTool(
    sessionId: string,
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<{
    content: string;
    isError?: boolean;
    imagePath?: string;
    videoPath?: string;
    audioPath?: string;
  }> {
    // Plan mode: read-only tools work; anything mutating is blocked
    // with feedback the model can plan around instead of a bare denial.
    if (this.deps.config.get().approvalMode === 'plan' && !AUTO_ALLOWED_TOOLS.has(name)) {
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
        name.startsWith('video_') ||
        name.startsWith('look_') ||
        name.startsWith('file_') ||
        name.startsWith('group_') ||
        name.startsWith('ask_') ||
        name.startsWith('preview_'))
    ) {
      // The session knows its own project — tools default to it instead
      // of making the model guess a name. dir carries the chat's folder
      // (attached or project) for look_at_image / image saves. sessionId
      // makes THIS chat the coordinator when a group is started here.
      return this.deps.builtins.execute(name, args, {
        projectId: this.deps.projects.meta(sessionId)?.projectId,
        dir: this.projectDirFor(sessionId),
        sessionId,
        // video_generate polls for minutes — Stop has to reach it.
        ...(signal ? { signal } : {}),
      });
    }
    return this.deps.mcp.call(name, args);
  }

  /** Same rule as an image: the newest playable file wins, once per turn. */
  private audioShown = new Set<string>();

  /**
   * Play what the agents make, where they make it.
   *
   * A generated audio file is the deliverable — narration, a voice line, a
   * rendered mix — and a line of text saying it was written is not something
   * you can listen to. So after any tool runs, an audio file it named and
   * actually produced rides back on the same UI side-channel a generated image
   * or video uses: the PATH reaches the chat, the bytes never touch the token
   * stream. The check is "did this call put a playable file on disk", which is
   * why it covers ws_run rendering an mp3 as well as any future speech tool.
   */
  private async withMedia<
    T extends { content: string; isError?: boolean; imagePath?: string; videoPath?: string; audioPath?: string },
  >(sessionId: string, args: unknown, running: Promise<T>): Promise<T> {
    const result = await running;
    if (result.isError || result.audioPath) return result;
    const hit = this.audioMadeBy(
      [JSON.stringify(args ?? {}), result.content].join('\n'),
      this.projectDirFor(sessionId),
    );
    return hit ? { ...result, audioPath: hit } : result;
  }

  /**
   * The audio file this call produced, if any. Paths are taken from what the
   * tool was ASKED to do and what it REPORTED, then confirmed against the disk
   * — a filename in a plan or an error message is not a file, and the player
   * would show a broken clip for it. Each path plays once: a run that mentions
   * the same mp3 in three lines of output is still one recording.
   */
  private audioMadeBy(text: string, dir: string | undefined): string | undefined {
    const seen = new Set<string>();
    for (const raw of text.match(/[^\s"'`,;:<>|*?()[\]{}]+\.[A-Za-z0-9]{2,5}/g) ?? []) {
      const cleaned = raw.replace(/[.,;:)\]}]+$/, '');
      if (!isAudioPath(cleaned)) continue;
      const abs = isAbsolute(cleaned) ? cleaned : dir ? resolve(dir, cleaned) : null;
      if (!abs || seen.has(abs)) continue;
      seen.add(abs);
      // FRESH, not merely present. A script that names its output file, or a
      // read of last week's mix, would otherwise open a player for something
      // this call had nothing to do with.
      let age = Infinity;
      try {
        age = Date.now() - statSync(abs).mtimeMs;
      } catch {
        continue; // named but not on disk
      }
      if (age > AUDIO_FRESH_MS) continue;
      if (this.audioShown.has(abs)) continue;
      this.audioShown.add(abs);
      // Bounded: this only has to outlive the turn that made the file.
      if (this.audioShown.size > 100) {
        this.audioShown.delete(this.audioShown.values().next().value!);
      }
      return abs;
    }
    return undefined;
  }

  historyOf(sessionId: string): HarnessMessage[] {
    return this.sessions.get(sessionId)?.history ?? this.deps.projects.loadTranscript(sessionId);
  }

  /** A session that was never loaded is idle by definition. */
  statusOf(sessionId: string): ReturnType<AgentSession['getStatus']> {
    return this.sessions.get(sessionId)?.getStatus() ?? 'idle';
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
        return { ok: false, error: 'Nothing worth consolidating yet.' };
      }

      // Consolidate = make sure the map is current. It is NOT a summarise-and-
      // destroy step any more: with smart context on, every request is already
      // a bounded render (briefing + recent turns), so there is no window
      // filling up to rescue. The old path called a model, threw the live
      // history away AND overwrote the on-disk transcript with two synthetic
      // messages — losing the verbatim record to save a window that no longer
      // grows. Nothing is destroyed here; the archive keeps everything and
      // archive_read can still reach it.
      const projectId = this.assembleEnabled(sessionId);
      if (!projectId) {
        return {
          ok: false,
          error:
            'Smart context is off for this project, so the whole conversation is replayed every ' +
            'turn and there is no map to consolidate into. Turn it on in Memory.',
        };
      }
      this.persist(sessionId); // archives any turns not yet recorded
      await this.deps.distill?.(projectId, sessionId);
      const nodes = this.deps.bank!.digest(projectId, 1_200);
      return {
        ok: true,
        summary: nodes
          ? `Memory is up to date. The window already carries this briefing plus recent turns:\n\n${nodes}`
          : 'Memory is up to date — nothing durable to record yet.',
      };
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

  /**
   * Group members work pre-approved, like missions: the user approved the
   * PLAN (the group_start permission prompt in Manual mode shows the exact
   * parts), and the plan is meaningless if the team then stalls on a modal
   * per file. Watched live: three members each raised ws_write prompts, the
   * five-minute timeout denied them, and the group ended idle asking the user
   * to "fix the permission setting". Scope is deliberately narrow — the
   * project-folder workspace tools plus map_update, the coordination
   * bookkeeping the brief instructs them to do. MCP calls, web_fetch and
   * everything else still gate normally.
   */
  private static readonly GROUP_MEMBER_TOOLS = new Set([
    'ws_write',
    'ws_run',
    'ws_assemble',
    'map_update',
  ]);

  private isGroupMember(sessionId: string): boolean {
    const groups = this.deps.projects.groups();
    const groupId = this.deps.projects.meta(sessionId)?.groupId;
    if (groupId && groups.some((g) => g.id === groupId && !g.endedAt)) return true;
    // The coordinator holds the same working grant: the finishing brief has it
    // building missing parts and fixing the assembly — a run where every
    // member could write but the boss's ws_write timed out into a denial left
    // a group "done" with an EMPTY project folder.
    return groups.some((g) => !g.endedAt && g.coordinatorId === sessionId);
  }

  private requestPermission(
    sessionId: string,
    name: string,
    args: unknown,
  ): Promise<PermissionDecision> {
    if (AUTO_ALLOWED_TOOLS.has(name)) return Promise.resolve('allow');
    const mode = this.deps.config.get().approvalMode;
    // Spending is asked EVERY time, before any of the escapes below. Auto mode
    // is the user opting into autonomous work, not into autonomous purchases.
    const mustConfirm = ALWAYS_CONFIRM_TOOLS.has(name);
    // Auto: the user opted into autonomous agents. Plan: allow through so the
    // executor's plan-mode block answers instructively (no modal either way).
    // Destructive infra tools still enforce their own confirm tier downstream.
    if (!mustConfirm && (mode === 'auto' || mode === 'plan')) return Promise.resolve('allow');
    if (
      !mustConfirm &&
      SessionManager.GROUP_MEMBER_TOOLS.has(name) &&
      this.isGroupMember(sessionId)
    ) {
      return Promise.resolve('allow');
    }
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
