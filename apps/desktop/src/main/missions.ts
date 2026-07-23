import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AgentSession, type PermissionDecision } from '@vo-coder/core';
import type { AgentSpec, BoundModel, ToolSpec, UserPart } from '@vo-coder/providers';
import type { Mission, MissionAction, MissionCreateInput } from '../shared/ipc-contract';
import { fmtStamp } from './journal';

/**
 * Missions: background objectives Vodo pursues on its own schedule. Each
 * mission owns a dedicated AgentSession — its own history, its own provider
 * stream — so any number of missions run concurrently with interactive chats
 * without touching them. Looping missions keep their session (and therefore
 * context) between runs while the app is open; the mission list itself
 * persists across restarts.
 */

const MIN_INTERVAL_MIN = 5;
const MAX_INTERVAL_MIN = 7 * 24 * 60;
const MAX_TURNS_PER_RUN = 24;
const HISTORY_TRIM_AT = 90;
const HISTORY_TRIM_KEEP = 50;
const RESULT_SNIPPET = 800;

export interface MissionAgentBackend {
  /** Vodo's current spec (fresh config each call). */
  vodoSpec(): AgentSpec;
  projectDir(projectId: string): string | undefined;
  resolveProject(nameOrId: string): string | undefined;
  resolve(spec: AgentSpec, override?: { provider?: string; model?: string }): BoundModel;
  route(
    text: string,
    builderMode: boolean,
  ): Promise<{ provider: string; model: string; rationale: string } | undefined>;
  tools(projectDir?: string): ToolSpec[];
  execute(
    name: string,
    args: unknown,
    projectDir?: string,
    projectId?: string,
  ): Promise<{ content: string; isError?: boolean }>;
  /** Fallback prompt when a mission is NOT auto-approved (e.g. Telegram buttons). */
  askPermission?: (
    missionTitle: string,
    tool: string,
    args: unknown,
  ) => Promise<PermissionDecision>;
  onUsage(
    bound: BoundModel | undefined,
    ev: { inputTokens: number; outputTokens: number },
    projectId?: string,
  ): void;
  /** Broadcast a mission event (Telegram + anything else). */
  notify(text: string): void;
  onChanged(missions: Mission[]): void;
  /** Activity journaling (projectId resolved to a name by the host). */
  log?(text: string, projectId?: string): void;
}

interface RunState {
  session: AgentSession;
  bound?: BoundModel;
  text: string;
  erred: boolean;
}

export class MissionManager {
  private missions: Mission[] = [];
  private live = new Map<string, RunState>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private seq = 0;

  constructor(
    private file: string,
    private backend: MissionAgentBackend,
  ) {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { missions?: Mission[] };
      this.missions = (raw.missions ?? []).map((m) => ({
        ...m,
        // A run can't survive a restart — settle interrupted states.
        status: m.status === 'running' ? 'idle' : m.status,
      }));
    } catch {
      /* first launch */
    }
    // Stagger resumed schedules so a restart doesn't fire everything at once.
    let stagger = 30_000;
    for (const m of this.missions) {
      if (m.intervalMinutes && m.status === 'idle') {
        this.armTimer(m.id, stagger);
        stagger += 15_000;
      }
    }
  }

  list(): Mission[] {
    return this.missions.map((m) => ({ ...m }));
  }

  create(input: MissionCreateInput): Mission {
    const title = input.title.trim() || 'Untitled mission';
    const objective = input.objective.trim();
    if (!objective) throw new Error('A mission needs an objective.');
    const interval = input.intervalMinutes
      ? Math.min(Math.max(Math.round(input.intervalMinutes), MIN_INTERVAL_MIN), MAX_INTERVAL_MIN)
      : undefined;
    const mission: Mission = {
      id: `mission_${Date.now()}_${++this.seq}`,
      title,
      objective,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(interval ? { intervalMinutes: interval } : {}),
      autoApprove: input.autoApprove ?? true,
      status: 'idle',
      createdAt: Date.now(),
      runCount: 0,
    };
    this.missions.push(mission);
    this.persist();
    if (input.runNow ?? true) void this.run(mission.id);
    else if (interval) this.armTimer(mission.id, interval * 60_000);
    return { ...mission };
  }

  control(id: string, action: MissionAction): void {
    const mission = this.byId(id);
    if (!mission) throw new Error(`Unknown mission "${id}".`);
    switch (action) {
      case 'run':
        void this.run(mission.id);
        return;
      case 'pause':
        // A running turn finishes (finishRun tolerates 'paused') but nothing
        // re-arms afterwards.
        mission.status = 'paused';
        this.disarmTimer(mission.id);
        break;
      case 'resume':
        if (mission.status === 'paused' || mission.status === 'done' || mission.status === 'failed') {
          mission.status = 'idle';
          if (mission.intervalMinutes) this.armTimer(mission.id, 5_000);
          else void this.run(mission.id);
        }
        break;
      case 'delete': {
        this.disarmTimer(mission.id);
        const state = this.live.get(mission.id);
        state?.session.stop();
        this.live.delete(mission.id);
        this.missions = this.missions.filter((m) => m.id !== mission.id);
        break;
      }
    }
    this.persist();
  }

  stopAll(): void {
    for (const [, t] of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const [, s] of this.live) s.session.stop();
  }

  /** Tools that let Vodo manage missions from ANY chat (in-app or Telegram). */
  toolSpecs(): ToolSpec[] {
    return [
      {
        name: 'mission_create',
        description:
          'Create a background mission — an objective pursued autonomously in its own agent instance, ' +
          'so it never blocks the current conversation. One-shot by default; pass intervalMinutes to loop ' +
          '(e.g. "check X every hour"). Runs are auto-approved. Use when the user asks for ongoing, ' +
          'scheduled, or long-running work.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short mission name' },
            objective: {
              type: 'string',
              description: 'Full instructions for the mission agent — it starts with no other context',
            },
            project: {
              type: 'string',
              description: 'Project name (or id) whose folder the mission may edit; omit for none',
            },
            intervalMinutes: {
              type: 'number',
              description: `Repeat every N minutes (min ${MIN_INTERVAL_MIN}); omit to run once`,
            },
          },
          required: ['title', 'objective'],
        },
      },
      {
        name: 'mission_list',
        description: 'List all missions with status, schedule, and last result.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'mission_control',
        description: 'Control a mission: run (now), pause, resume, or delete.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Mission id or exact title' },
            action: { type: 'string', enum: ['run', 'pause', 'resume', 'delete'] },
          },
          required: ['id', 'action'],
        },
      },
    ];
  }

  async executeTool(
    name: string,
    args: unknown,
    ctx?: { projectId?: string },
  ): Promise<{ content: string; isError?: boolean }> {
    const a = (args ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case 'mission_create': {
          const projectId = a.project
            ? this.backend.resolveProject(String(a.project))
            : ctx?.projectId;
          if (a.project && !projectId) {
            return { content: `No project called "${a.project}".`, isError: true };
          }
          const mission = this.create({
            title: String(a.title ?? ''),
            objective: String(a.objective ?? ''),
            ...(projectId ? { projectId } : {}),
            ...(a.intervalMinutes ? { intervalMinutes: Number(a.intervalMinutes) } : {}),
          });
          return {
            content:
              `Mission "${mission.title}" (${mission.id}) created and started.` +
              (mission.intervalMinutes ? ` Repeats every ${mission.intervalMinutes} min.` : ''),
          };
        }
        case 'mission_list':
          return { content: this.describeAll() };
        case 'mission_control': {
          const key = String(a.id ?? '');
          const mission = this.byId(key) ?? this.missions.find((m) => m.title === key);
          if (!mission) return { content: `Unknown mission "${key}".`, isError: true };
          this.control(mission.id, String(a.action) as MissionAction);
          return { content: `Mission "${mission.title}": ${a.action} ok.` };
        }
        default:
          return { content: `Unknown mission tool "${name}".`, isError: true };
      }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  }

  describeAll(): string {
    if (this.missions.length === 0) return 'No missions.';
    return this.missions
      .map((m) => {
        const schedule = m.intervalMinutes ? `every ${m.intervalMinutes}m` : 'one-shot';
        const last = m.lastRunAt ? new Date(m.lastRunAt).toLocaleString() : 'never';
        return (
          `• ${m.title} [${m.status}] (${schedule}, runs: ${m.runCount}, last: ${last})` +
          (m.lastResult ? `\n  ↳ ${m.lastResult.slice(0, 200)}` : '') +
          (m.lastError ? `\n  ⚠ ${m.lastError.slice(0, 200)}` : '')
        );
      })
      .join('\n');
  }

  private byId(id: string): Mission | undefined {
    return this.missions.find((m) => m.id === id);
  }

  private armTimer(id: string, delayMs: number): void {
    this.disarmTimer(id);
    this.timers.set(
      id,
      setTimeout(() => void this.run(id), delayMs),
    );
  }

  private disarmTimer(id: string): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }

  private sessionFor(mission: Mission): RunState {
    let state = this.live.get(mission.id);
    if (state) return state;

    const dir = mission.projectId ? this.backend.projectDir(mission.projectId) : undefined;
    const base = this.backend.vodoSpec();
    const spec: AgentSpec = {
      ...base,
      id: mission.id,
      name: `Vodo · ${mission.title}`,
      systemPrompt:
        `${base.systemPrompt ?? ''}\n\n` +
        `You are running an autonomous background MISSION titled "${mission.title}". ` +
        `Work independently — there is no user watching this session live, so never ask questions; ` +
        `make reasonable decisions and report what you did. Finish each run with a concise summary ` +
        `of findings/changes.` +
        (dir
          ? ` You have workspace tools scoped to the project folder "${dir}" — do the work yourself.`
          : ''),
    };

    const fresh: RunState = { text: '', erred: false, session: undefined as unknown as AgentSession };
    fresh.session = new AgentSession({
      id: mission.id,
      spec,
      maxToolTurns: MAX_TURNS_PER_RUN,
      resolve: (s) => {
        const bound = this.backend.resolve(s);
        fresh.bound = bound;
        return bound;
      },
      emit: (_sid, event) => {
        if (event.type === 'text_delta') fresh.text += event.text;
        else if (event.type === 'error') {
          fresh.erred = true;
          const current = this.byId(mission.id);
          if (current) current.lastError = event.error.message.slice(0, 300);
        } else if (event.type === 'usage') {
          this.backend.onUsage(fresh.bound, event, mission.projectId);
        } else if (event.type === 'status' && event.status === 'idle') {
          this.finishRun(mission.id);
        }
      },
      toolExecutor: {
        tools: () => this.backend.tools(dir),
        execute: (name, args) => this.backend.execute(name, args, dir, mission.projectId),
      },
      permission: async (req) => {
        const current = this.byId(mission.id);
        if (current?.autoApprove) return 'allow';
        if (this.backend.askPermission) {
          return this.backend.askPermission(mission.title, req.name, req.args);
        }
        return 'deny';
      },
    });
    state = fresh;
    this.live.set(mission.id, state);
    return state;
  }

  private async run(id: string): Promise<void> {
    const mission = this.byId(id);
    if (!mission || mission.status === 'running' || mission.status === 'paused') return;

    const state = this.sessionFor(mission);
    if (state.session.getStatus() !== 'idle') return;

    mission.status = 'running';
    mission.lastRunAt = Date.now();
    mission.runCount += 1;
    delete mission.lastError;
    this.changed();

    state.text = '';
    state.erred = false;

    const now = `Now (local): ${fmtStamp(Date.now())}.\n`;
    const prompt: string =
      mission.runCount === 1
        ? `${now}Mission objective:\n${mission.objective}`
        : `${now}Scheduled re-run #${mission.runCount} of your mission. Objective:\n${mission.objective}\n\n` +
          'You have your previous runs above. Continue where you left off, verify earlier work, and report what changed.';
    this.backend.log?.(`"${mission.title}" run #${mission.runCount} started`, mission.projectId);

    let override: { provider?: string; model?: string } | undefined;
    const dir = mission.projectId ? this.backend.projectDir(mission.projectId) : undefined;
    const pick = await this.backend.route(mission.objective, !!dir).catch(() => undefined);
    if (pick) override = { provider: pick.provider, model: pick.model };

    const parts: UserPart[] = [{ type: 'text', text: prompt }];
    const result = state.session.send(parts, override);
    if (!result.ok) {
      mission.status = 'failed';
      mission.lastError = result.error ?? 'Could not start the run.';
      this.scheduleNext(mission);
      this.changed();
    }
  }

  private finishRun(id: string): void {
    const mission = this.byId(id);
    const state = this.live.get(id);
    if (!mission || (mission.status !== 'running' && mission.status !== 'paused')) return;

    const summary = (state?.text ?? '').trim();
    mission.lastResult = summary.slice(-RESULT_SNIPPET) || undefined;
    if (mission.status === 'running') {
      mission.status = state?.erred
        ? 'failed'
        : mission.intervalMinutes
          ? 'idle'
          : 'done';
    }

    // Keep looping context bounded: preserve the opening objective + recent
    // turns. Cut only at a user-message boundary — slicing between a tool_call
    // and its tool result produces a history most providers reject.
    const history = state?.session.history;
    if (history && history.length > HISTORY_TRIM_AT) {
      let cut = history.length - HISTORY_TRIM_KEEP;
      while (cut < history.length && history[cut]?.role !== 'user') cut++;
      if (cut > 2 && cut < history.length) history.splice(2, cut - 2);
    }

    this.scheduleNext(mission);
    this.persist();
    this.backend.log?.(
      `"${mission.title}" run #${mission.runCount} ${state?.erred ? 'failed' : 'finished'}` +
        (summary ? `: ${summary.slice(0, 160)}` : ''),
      mission.projectId,
    );
    this.backend.notify(
      `${state?.erred ? '⚠' : '✅'} Mission "${mission.title}" run #${mission.runCount} ` +
        `${state?.erred ? 'hit an error' : 'finished'}` +
        (summary ? `:\n${summary.slice(0, 600)}` : '.') +
        (mission.intervalMinutes && mission.status === 'idle'
          ? `\n(next run in ${mission.intervalMinutes} min)`
          : ''),
    );
  }

  private scheduleNext(mission: Mission): void {
    if (mission.intervalMinutes && mission.status !== 'paused' && mission.status !== 'done') {
      this.armTimer(mission.id, mission.intervalMinutes * 60_000);
    }
  }

  private changed(): void {
    this.backend.onChanged(this.list());
  }

  private persist(): void {
    this.changed();
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ missions: this.missions }, null, 2), 'utf8');
    } catch (err) {
      console.error('[missions] persist failed:', err);
    }
  }
}
