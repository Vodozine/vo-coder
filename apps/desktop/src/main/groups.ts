import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { assignTasks } from '@vo-coder/core';
import type { TaskRequest } from '@vo-coder/core';
import type { AgentSpec, ToolSpec } from '@vo-coder/providers';
import { HOMELAB_AGENT_ID, HOMELAB_AGENT_NAME } from '../shared/homelab';
import type { GroupMember, GroupRun } from '../shared/ipc-contract';

/** More than this and nobody can follow what is happening. */
export const MAX_GROUP_MEMBERS = 8;

/**
 * Mr Homelab is NOT a group resource. He owns his own tab and his own estate
 * knowledge, and every heuristic that tried to let him in "when the part is
 * genuinely infrastructure" leaked: hint scoring conscripted him into website
 * groups, and the deliberate door let a coordinator do the same by name. When
 * a group needs another pair of hands it HIRES one (see auto-agents) — an
 * unlimited, disposable resource — instead of borrowing the specialist.
 */
export const HOMELAB_NOT_FOR_GROUPS =
  `${HOMELAB_AGENT_NAME} does not join group projects — he has his own tab and his own estate ` +
  'memory. Hire a helper instead (group_add with any name; one is created if the roster is ' +
  'short), or ask the user to take it to his tab if it is genuinely infrastructure work.';

export interface GroupDeps {
  agents: () => AgentSpec[];
  /**
   * Agents a running mission is holding, with the mission's title. They are
   * already absent from agents(), so this exists only to SAY WHY: a seat
   * refused with "no such agent" reads as a typo, and a named part quietly
   * rerouted reads as the coordinator's pick being ignored.
   */
  onMission?: () => Array<{ name: string; mission: string }>;
  /**
   * Resolve any agent by id, UNFILTERED — including agents a mission is holding
   * and Mr Homelab, who are absent from `agents()`. The brief a member opens
   * with is keyed on its card's memory flag; resolving that flag through the
   * filtered roster meant a lookup miss (mission-held member, or Homelab seated
   * by startGroup) silently briefed a memory-off agent as if it had the map.
   */
  agentById?: (id: string) => AgentSpec | undefined;
  /**
   * How capable an agent's model is (1–10, the catalog's own scale). Only a
   * tiebreak, but on a roster of general-purpose agents nearly every part ties
   * — and without it the hardest part went to whoever was least recently used.
   */
  qualityOf?: (agent: AgentSpec) => number | undefined;
  createSession: (
    projectId: string,
    agentId: string,
    title: string,
    groupId: string,
    dir?: string,
  ) => string;
  send: (sessionId: string, text: string) => void;
  addGroup: (group: GroupRun) => void;
  /** Live groups — group_send resolves its target member through this. */
  groups?: () => GroupRun[];
  /**
   * Record the group in the project's memory map. Groups used to be invisible
   * there: the members' task nodes existed but nothing said "these were one
   * project with one goal" — so the map could not answer what a group did.
   */
  record?: (group: GroupRun) => void;
  /**
   * Pre-load a member's model. A local model is read off disk on first use —
   * measured at 36-93s here — and without this a member paid that on its
   * FIRST group message while the others were already answering.
   */
  warm?: (provider: string, model: string) => void;
  /** Live run state of a session ('idle' | 'streaming' | …) for group_status. */
  statusOf?: (sessionId: string) => string;
  /** Tail of a member's last reply — what they actually said before going quiet. */
  lastSaid?: (sessionId: string) => string;
  /** Does the shared folder hold a VO-CODER.md the members must read first? */
  hasProjectMd?: (dir: string) => boolean;
  /** Persist a changed group (a member joined mid-run) and refresh the UI. */
  updateGroup?: (group: GroupRun) => void;
  /**
   * Hire one auto agent — a real, persisted agent named from the pioneer pool
   * and built from the user's auto-agent defaults. Returns undefined when the
   * pool is exhausted (the cap, or every name used). This is what makes "not
   * enough agents" a non-problem: the group hires instead of borrowing the
   * user's specialists.
   */
  hire?: () => AgentSpec | undefined;
  /** How many auto agents exist / are allowed — for the "pool full" message. */
  autoAgentCount?: () => number;
  autoAgentMax?: () => number;
}

/**
 * Vodo's own way to parallelise. The coordinator is already reasoning about
 * the job when it decides "these three pieces don't depend on each other" —
 * so it passes the split it has already made, and the code decides WHICH
 * agent gets each piece. A tool rather than an interceptor: it costs nothing
 * on messages that don't split, and the coordinator narrates the decision in
 * the thread instead of the user's message vanishing into a silent fan-out.
 */
export function groupToolSpecs(): ToolSpec[] {
  return [
    {
      name: 'group_start',
      description:
        'Run independent parts of a job at the same time, each on a different agent, instead of ' +
        'doing them one after another. Use it when a task genuinely splits — separate files, ' +
        'separate components, research plus implementation — and the parts do NOT depend on each ' +
        "other finishing first. Do not use it for sequential work or trivial edits. Each part's " +
        'agent gets its own chat and works in parallel; you keep coordinating and pull the ' +
        'results together. ' +
        'ONE BIG DELIVERABLE (one code file, one document) also splits: FIRST ws_write a ' +
        'BLUEPRINT file at .vodo/team/BLUEPRINT.md — the skeleton with its contracts ' +
        '(signatures, interfaces, section headers) and a numbered block list — then make each ' +
        'part one block, naming its EXACT block file (.vodo/team/blocks/01_deck.js, ' +
        '.vodo/team/blocks/02_scoring.js…). Two parts must never share a file. When the blocks ' +
        'land, ws_assemble merges them in order into the REAL deliverable path — blocks that ' +
        'depend on other blocks still parallelise, because the blueprint contract is what ' +
        'decouples them. ALL coordination files (blueprint, blocks, team notes, checklists) ' +
        'live under .vodo/team/ — the project root is for the product, never the paperwork.',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The shared goal, one sentence' },
          parts: {
            type: 'array',
            items: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    task: { type: 'string', description: 'The instruction for this part' },
                    agent: {
                      type: 'string',
                      description:
                        'Which agent should take it, by name. YOU know which part is hardest and ' +
                        'how capable each agent is — say so here. Leave it out to let the ' +
                        'keyword match decide.',
                    },
                  },
                  required: ['task'],
                },
              ],
            },
            description:
              '2-8 independent parts. Each is an instruction to the person doing it and must ' +
              'carry enough context to act on alone. Give the DEMANDING parts to your most ' +
              'capable agents — the roster above lists each one\'s model and how strong it is. ' +
              'A part may be plain text, or {"task": "...", "agent": "name"} to choose.',
          },
        },
        required: ['goal', 'parts'],
      },
    },
    {
      name: 'group_send',
      description:
        'THE ONLY WAY TO REACH A MEMBER. They cannot see your chat: naming assignments in your ' +
        'reply, or writing a table of who-does-what, delivers nothing and leaves everyone idle ' +
        'waiting for you. One call per member, every time you want work done. ' +
        'Hand work to ONE group member, in their own chat. You are the coordinator — delegate ' +
        'instead of doing member-level work yourself: send the assembly job to your most capable ' +
        'member, send a missing or broken part back to its owner, give follow-up instructions or ' +
        'a fix list. Non-blocking: it returns at once, and you are woken again when the whole ' +
        'group goes quiet. Only do a step yourself when no member can (wrong tools, failed at it ' +
        'twice) — or when the user has told you to take it, which overrides all of this.',
      inputSchema: {
        type: 'object',
        properties: {
          member: {
            type: 'string',
            description: 'Agent name of the member (as listed when the group started)',
          },
          message: {
            type: 'string',
            description:
              'The full instruction — which files to read, the exact deliverable, where to ' +
              'write it. They see none of your reasoning; the message must stand alone.',
          },
        },
        required: ['member', 'message'],
      },
    },
    {
      name: 'group_status',
      description:
        'Who on your team is actually working right now, and what each of them last said. Call ' +
        'this before you claim the group is busy or wait for anyone: "they are still working" is ' +
        'a guess, and a wrong guess leaves the job parked with nobody running. Idle members are ' +
        'waiting for YOU — send them work with group_send or finish the job.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'group_add',
      description:
        'Seat ONE more agent from the roster into the RUNNING group and hand them their first ' +
        'task. Use it when the job outgrew the team: queued parts are piling up, a specialty is ' +
        'missing, or the user asks for more hands / the whole team. The new member gets their ' +
        'own chat, the shared folder and the same rules as everyone else — afterwards reach ' +
        'them with group_send like any member. Seats are capped; prefer re-tasking an idle ' +
        'member when the roster is exhausted.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            description: 'Roster agent name to bring in (must not already be a member)',
          },
          task: {
            type: 'string',
            description:
              'Their first assignment — complete and standalone: exact files, exact ' +
              'deliverable, where to write it. They see nothing else of this chat.',
          },
        },
        required: ['agent', 'task'],
      },
    },
    {
      name: 'team_clean',
      description:
        'Throw away the scratch the team wrote to coordinate — everything under .vodo/team/ ' +
        '(blueprints, block files, member reports, checklists). Call it as the LAST step of a ' +
        'finished group, after the durable points are in the memory map (map_update) and after ' +
        'you have summarised the work in your reply. Those files are notes between agents, not ' +
        'deliverables: left behind they pile up until nobody can find the actual product. Never ' +
        'touches anything outside .vodo/team/, so the deliverable itself is never at risk. With ' +
        'list:true it only shows what is there.',
      inputSchema: {
        type: 'object',
        properties: {
          list: { type: 'boolean', description: 'Only list the scratch, delete nothing.' },
        },
      },
    },
  ];
}

/** Everything under .vodo/team, relative to the folder — the team's scratch. */
function teamScratch(dir: string): string[] {
  const root = join(dir, '.vodo', 'team');
  const out: string[] = [];
  const walk = (p: string, rel: string, depth: number): void => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(join(p, e.name), `${rel}${e.name}/`, depth + 1);
      else if (e.isFile()) out.push(`${rel}${e.name}`);
    }
  };
  walk(root, '', 0);
  return out.sort();
}

export async function executeGroupTool(
  name: string,
  args: unknown,
  deps: GroupDeps,
  projectId?: string,
  /** The chat the call came from — the group's panes render there, and only there. */
  coordinatorId?: string,
  /**
   * The coordinator's working folder (chat-attached or project). Members are
   * born with it: a group whose goal is files was once spawned dir-less in a
   * folder-less project, so every member's ws_write had no workspace — the
   * boss kept ordering the assembly and the workers had no hands.
   */
  dir?: string,
): Promise<{ content: string; isError?: boolean }> {
  if (name === 'team_clean') {
    if (!dir) return { content: 'This chat has no folder, so there is no team scratch.', isError: true };
    const files = teamScratch(dir);
    if (!files.length) return { content: 'Nothing under .vodo/team/ — already clean.' };
    const shown = files.slice(0, 20).map((f) => `  ${f}`).join('\n');
    const more = files.length > 20 ? `\n  …and ${files.length - 20} more` : '';
    if ((args as { list?: unknown })?.list === true) {
      return { content: `Team scratch (${files.length} file(s)):\n${shown}${more}` };
    }
    try {
      // The whole point of the confinement: only ever this one subtree.
      rmSync(join(dir, '.vodo', 'team'), { recursive: true, force: true });
    } catch (err) {
      return {
        content: `Could not clear .vodo/team/: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
    return {
      content:
        `Cleared .vodo/team/ — ${files.length} scratch file(s) removed:\n${shown}${more}\n` +
        'The deliverable and everything else in the folder is untouched.',
    };
  }
  if (name === 'group_status') {
    const group = deps.groups?.().find((g) => !g.endedAt && g.coordinatorId === coordinatorId);
    if (!group) {
      return {
        content: 'No live group is coordinated from this chat.',
        isError: true,
      };
    }
    const lines = group.members.map((m) => {
      const status = deps.statusOf?.(m.sessionId) ?? 'unknown';
      const said = deps.lastSaid?.(m.sessionId) ?? '';
      return (
        `- ${m.agentName} — ${status === 'idle' ? 'IDLE (waiting for you)' : status.toUpperCase()}` +
        `\n    task: ${m.task.slice(0, 110)}` +
        (said ? `\n    last said: ${said.replace(/\s+/g, ' ').slice(0, 180)}` : '')
      );
    });
    const working = group.members.filter(
      (m) => (deps.statusOf?.(m.sessionId) ?? 'idle') !== 'idle',
    ).length;
    return {
      content:
        `${group.members.length} member(s), ${working} working, ${group.members.length - working} idle.\n` +
        `${lines.join('\n')}\n\n` +
        (working === 0
          ? 'NOBODY IS RUNNING. No one will come back to you on their own — either group_send ' +
            'the remaining work to a named member now, or finish the last step yourself and report.'
          : 'Some members are still working; you will be woken when the group goes quiet.'),
    };
  }
  if (name === 'group_send') {
    const a = (args ?? {}) as { member?: unknown; message?: unknown };
    const memberName = typeof a.member === 'string' ? a.member.trim() : '';
    const message = typeof a.message === 'string' ? a.message.trim() : '';
    if (!memberName || !message) {
      return { content: 'group_send needs member (agent name) and message.', isError: true };
    }
    const group = deps.groups?.().find((g) => !g.endedAt && g.coordinatorId === coordinatorId);
    if (!group) {
      return {
        content: 'No live group is coordinated from this chat — group_send only works there.',
        isError: true,
      };
    }
    const norm = (s: string) => s.toLowerCase();
    const member =
      group.members.find((m) => norm(m.agentName) === norm(memberName)) ??
      group.members.find(
        (m) => norm(m.agentName).includes(norm(memberName)) || norm(m.task).includes(norm(memberName)),
      );
    if (!member) {
      return {
        content:
          `No member matches "${memberName}". Members: ` +
          group.members.map((m) => m.agentName).join(', ') +
          '. A roster agent who is not a member yet joins with group_add.',
        isError: true,
      };
    }
    // Their model may have been evicted while they sat idle — start the load
    // now so the instruction begins at prefill, not at reading weights. Resolve
    // through agentById (unfiltered): a member whose agent a mission later
    // claimed is gone from agents(), and the memory-flag miss would flip the
    // instruction to the map variant for an agent that has no map.
    const agent = deps.agentById?.(member.agentId) ?? deps.agents().find((ag) => ag.id === member.agentId);
    if (agent?.provider && agent.model) deps.warm?.(agent.provider, agent.model);
    deps.send(
      member.sessionId,
      `FROM VODO (your coordinator) — new instruction:\n\n${message}\n\n` +
        (agent?.memory === false
          ? 'Do this now, report back what you did, and stop when it is done.'
          : 'Do this now, record progress with map_update, and stop when it is done.'),
    );
    return {
      content:
        `Sent to ${member.agentName}. You will be woken when the group goes quiet — review ` +
        'their output then, before anything else.',
    };
  }
  if (name === 'group_add') {
    const a = (args ?? {}) as { agent?: unknown; task?: unknown };
    const agentName = typeof a.agent === 'string' ? a.agent.trim() : '';
    const task = typeof a.task === 'string' ? a.task.trim() : '';
    if (!agentName || !task) {
      return { content: 'group_add needs agent (roster name) and task.', isError: true };
    }
    const group = deps.groups?.().find((g) => !g.endedAt && g.coordinatorId === coordinatorId);
    if (!group) {
      return {
        content: 'No live group is coordinated from this chat — group_add only works there.',
        isError: true,
      };
    }
    if (group.members.length >= MAX_GROUP_MEMBERS) {
      return {
        content:
          `The group is full (${MAX_GROUP_MEMBERS} seats). Hand the work to an idle member ` +
          'with group_send instead.',
        isError: true,
      };
    }
    const norm = (s: string) => s.toLowerCase();
    // Off-duty agents stay off duty, and Mr Homelab is never seatable — the
    // group's answer to "we need another pair of hands" is to HIRE one.
    const roster = deps
      .agents()
      .filter((ag) => ag.enabled !== false && ag.id !== HOMELAB_AGENT_ID);
    // An agent on a mission is off the roster for the duration — one model on
    // one GPU, already working. Named outright, it is refused by NAME and by
    // reason: the exact-name case skips the roster lookup so a partial match on
    // someone else cannot quietly stand in for the person actually asked for.
    const onMission = deps.onMission?.() ?? [];
    const heldExact = onMission.find((h) => norm(h.name) === norm(agentName));
    let agent = heldExact
      ? undefined
      : (roster.find((ag) => norm(ag.name) === norm(agentName)) ??
        roster.find((ag) => norm(ag.name).includes(norm(agentName))));
    // Asked for by NAME, not resolved by id: he is already off the roster, so
    // without this the request would fall through to hiring and quietly seat a
    // stranger under the coordinator's nose.
    if (!agent && norm(agentName).includes('homelab')) {
      return { content: HOMELAB_NOT_FOR_GROUPS, isError: true };
    }
    let hiredNote = '';
    if (!agent) {
      const held = heldExact ?? onMission.find((h) => norm(h.name).includes(norm(agentName)));
      if (held) {
        return {
          content:
            `${held.name} is on the mission "${held.mission}" and cannot take a seat until it ` +
            'finishes — that is one model already working, and handing it a second job halves ' +
            'both. Seat someone else, or give the task to an idle member with group_send.',
          isError: true,
        };
      }
      // Nobody by that name — hire one rather than refuse. Running short of
      // hands is not a reason to stop working.
      const hire = deps.hire?.();
      if (!hire) {
        return {
          content:
            `No enabled agent matches "${agentName}", and the hire pool is full ` +
            `(${deps.autoAgentCount?.() ?? 0} of ${deps.autoAgentMax?.() ?? 0} helpers already ` +
            'exist). Re-task an idle member with group_send, or raise the limit in ' +
            'Settings → Auto agents.',
          isError: true,
        };
      }
      agent = hire;
      hiredNote = ` (hired — the roster had no "${agentName}")`;
    }
    if (group.members.some((m) => m.agentId === agent.id)) {
      return {
        content: `${agent.name} is already in the group — reach them with group_send.`,
        isError: true,
      };
    }
    const member: GroupMember = {
      sessionId: deps.createSession(group.projectId, agent.id, task.slice(0, 48), group.id, dir),
      agentId: agent.id,
      agentName: agent.name,
      task,
      matched: [],
    };
    const updated: GroupRun = { ...group, members: [...group.members, member] };
    deps.updateGroup?.(updated);
    // Re-record so the map's GROUP PROJECT node lists the new member too.
    deps.record?.(updated);
    if (agent.provider && agent.model) deps.warm?.(agent.provider, agent.model);
    deps.send(
      member.sessionId,
      memberBrief(
        updated.goal,
        member,
        updated.members,
        !!dir,
        !!(dir && deps.hasProjectMd?.(dir)),
        agent.memory !== false,
      ),
    );
    return {
      content:
        `${agent.name} joined the group${hiredNote} ` +
        `(${updated.members.length}/${MAX_GROUP_MEMBERS} seats) and received the task. They work ` +
        'in their own chat now — reach them again with group_send; you will be woken when the ' +
        'group goes quiet.',
    };
  }
  const a = (args ?? {}) as { goal?: unknown; parts?: unknown };
  const goal = typeof a.goal === 'string' ? a.goal.trim() : '';
  // A part is either a bare string or {task, agent}. Models mix the two forms
  // in one array, so both are accepted per item rather than per call.
  const parts: TaskRequest[] = (Array.isArray(a.parts) ? a.parts : []).flatMap((p) => {
    if (typeof p === 'string') return p.trim() ? [{ task: p.trim() }] : [];
    if (p && typeof p === 'object') {
      const o = p as { task?: unknown; agent?: unknown };
      if (typeof o.task === 'string' && o.task.trim()) {
        return [
          {
            task: o.task.trim(),
            ...(typeof o.agent === 'string' && o.agent.trim() ? { agent: o.agent.trim() } : {}),
          },
        ];
      }
    }
    return [];
  });
  if (!projectId) {
    return { content: 'A group needs a project — this chat has none.', isError: true };
  }
  if (!goal || parts.length < 2) {
    return {
      content:
        'group_start needs a goal and at least 2 independent parts. If the work is sequential, ' +
        'just do it yourself.',
      isError: true,
    };
  }
  const result = await startGroup(deps, projectId, coordinatorId ?? '', goal, parts, dir);
  if (!result.ok) return { content: result.error, isError: true };
  return {
    content:
      `Started ${result.group.members.length} agents in parallel:\n` +
      result.group.members.map((m) => `- ${m.agentName}: ${m.task}`).join('\n') +
      (result.queued.length
        ? `\nQUEUED — ${result.queued.length} part(s) had no free member and were NOT started:\n` +
          result.queued.map((q) => `- ${q}`).join('\n') +
          '\nDispatch each with group_send the moment a member goes idle — they are YOUR ' +
          'backlog now, and forgetting them ships an incomplete job.'
        : '') +
      (result.held.length
        ? `\nNOT AVAILABLE — ${result.held.join('; ')}. Tell the user who actually took it ` +
          'instead of reporting the agent you named.'
        : '') +
      '\nThey are working in their own chats now — the split view shows them. Tell the user who ' +
      'is doing what, then wait for their results rather than doing the work yourself. Mid-run ' +
      'you can hand any of them follow-up work with group_send — and if the job needs more ' +
      'hands than the seats filled, group_add seats another roster agent.',
  };
}

/**
 * The brief each member opens with. It states the shared goal, this member's
 * part, and who else is working — then points at the map, which is how they
 * actually stay in step: the digest is project-scoped and leads with active
 * task nodes, so each member sees the others' current plans without anyone
 * passing messages.
 */
export function memberBrief(
  goal: string,
  member: GroupMember,
  all: GroupMember[],
  sharedFolder = false,
  projectMd = false,
  /**
   * Does this member carry project memory? A member without it has no map
   * tools and no briefing, so the paragraphs telling it to record progress in
   * the map, to read the others' nodes, and to check its briefing for lessons
   * would all name things it does not have. A false instruction is worse than
   * a missing one: the model tries, fails, and improvises around the failure.
   */
  hasMemory = true,
): string {
  const others = all
    .filter((m) => m.sessionId !== member.sessionId)
    .map((m) => `- ${m.agentName}: ${m.task}`)
    .join('\n');
  return (
    `GROUP PROJECT — shared goal: ${goal}\n\n` +
    `YOUR PART: ${member.task}\n\n` +
    (others ? `Working alongside you, right now:\n${others}\n\n` : '') +
    (sharedFolder
      ? 'You all share ONE project folder — ws_list / ws_read / ws_write work there. Do NOT ' +
        'carve out a folder of your own to work in: one shared checkout is the point, and a ' +
        'per-agent folder means the parts never meet. (Worktrees mode is the one exception, ' +
        'and then your own worktree path is named in your instruction.) ' +
        'Deliverables are FILES in that folder, not chat text: write yours with ws_write. ' +
        'Long files: write them in several pieces (first call normal, the rest with ' +
        'append:true) — one giant write can stall your whole turn.\n\n' +
        'REPORT IN YOUR REPLY, NOT IN A FILE. When your part is done, say what you built, what ' +
        'you ran and what it printed, and anything the coordinator needs to know — in your ' +
        'chat answer. Vodo reads that and writes ONE summary for the user. Do NOT write a ' +
        'REPORT.md or an assessment file for him to open unless the DELIVERABLE itself is a ' +
        'document the user asked for.\n\n' +
        'TEAM PAPERWORK GOES IN .vodo/team/ — any notes, checklists or scratch files the team ' +
        'genuinely needs on disk (a blueprint, block files) go under .vodo/team/, NEVER into ' +
        'the project root. The root holds the product the user asked for, nothing else. Treat ' +
        'that folder as TEMPORARY: it is thrown away when the group finishes, so anything worth ' +
        'keeping belongs in your map_update notes, not in a file there.\n\n' +
        'IF YOUR PART NAMES A BLOCK FILE (e.g. .vodo/team/blocks/03_scoring.js): read the ' +
        'BLUEPRINT at .vodo/team/BLUEPRINT.md first and honour its contracts exactly — the ' +
        'signatures and interfaces there are what let everyone build at once. Write ONLY your ' +
        'own block file: never the final assembled file, never the blueprint, never another ' +
        'member’s block — the merge is done later with ws_assemble, in blueprint order. Title ' +
        'your map task node with your block name ("block 03 — scoring") so the team can see ' +
        'exactly which blocks are active and done.\n\n'
      : '') +
    (projectMd
      ? 'The folder has a VO-CODER.md: ws_read it FIRST — its Map section orients you without ' +
        'exploring, and its "## Rules" section binds everyone’s work here, yours included. ' +
        'Never edit the Rules section; only the user changes rules.\n\n'
      : '') +
    'WHAT YOU START, YOU STOP: launching the app or a dev server to check your part is fine, ' +
    'but call ws_stop the moment you have seen what you needed, and never start a second copy ' +
    'of something already running (ws_stop with no arguments lists it). A whole team each ' +
    'leaving one instance open is how nineteen copies of the same app ended up running.\n\n' +
    'Do your part only — the others have theirs, and duplicating their work wastes everyone. ' +
    (hasMemory
      ? 'Record your plan and progress with map_update as a "task" node (status active, then ' +
        'done): that is what the others see of you, and it is what survives if this conversation ' +
        'is summarised. Use map_query to see where they have got to before you assume anything ' +
        'about their part, and say so plainly if your part turns out to depend on theirs.\n\n'
      : // Hired help: no map, no briefing, no reading the other members. It
        // reports to the coordinator and asks the coordinator. That is the
        // whole point — one place to look, and nothing another agent wrote
        // half-finished can steer it.
        'When your part is done, say so plainly in your reply and describe what you changed — ' +
        'that report IS how your coordinator knows where you got to. Do not go looking for what ' +
        'the others are doing: you have been given your part, and the coordinator holds the ' +
        'whole picture. If your part turns out to depend on somebody else, say so and stop ' +
        'rather than guessing at their half.\n\n') +
    'STUCK? Call ask_vodo and describe exactly what you tried and what happened — Vodo (a ' +
    'stronger model) will do that one step or teach you the way' +
    (hasMemory
      ? ', and a LESSON is saved to the project memory. Check your briefing for lessons with ' +
        'your name before asking the same thing twice. '
      : '. Anything you need and were not given — a decision, a convention, how something here ' +
        'is meant to work — ask for the same way, rather than inventing it. ') +
    'Vodo also reviews your work: when a VODO REVIEW message arrives, fix what it lists ' +
    'before continuing. Mid-project, a message starting "FROM VODO" is your coordinator handing ' +
    'you follow-up work — do it the same way: work, update the map, stop when done.\n\n' +
    'IMPORTANT: the user is NOT in this chat — never end your turn by asking them anything ' +
    '("should I continue?", "anything else?"). Your boss is Vodo: need a decision, call ' +
    'ask_vodo; part finished, mark it done in the map, say DONE, and stop.'
  );
}

/**
 * Start a group: plan the split, open a session per member, and send each its
 * brief. Members are ordinary chat sessions — they archive, distil, and can be
 * reopened alone later. Sending is fire-and-forget so all members start
 * together instead of queueing behind each other.
 */
export async function startGroup(
  deps: GroupDeps,
  projectId: string,
  coordinatorId: string,
  goal: string,
  /**
   * The split, always made by Vodo. There is deliberately no fallback
   * splitter: dividing a job across a team is the most consequential
   * reasoning in the whole feature, and it used to be handed to the CHEAPEST
   * model in the fleet, with no project folder, no memory map and no tools —
   * which is exactly how a four-agent team ended up with one member.
   */
  rawParts: Array<string | TaskRequest>,
  /** Shared working folder — every member gets it as their chat's dir. */
  dir?: string,
): Promise<
  | {
      ok: true;
      group: GroupRun;
      /** Parts with no free member — NOT started; the boss dispatches them later. */
      queued: string[];
      /** Parts whose CHOSEN agent is on a mission, and who took them instead. */
      held: string[];
    }
  | { ok: false; error: string }
> {
  // A part is either bare text or text plus the agent the coordinator picked.
  // Everything below works on the normalized form so the "who does this" answer
  // has exactly one shape.
  const parts: TaskRequest[] = rawParts.map((p) => (typeof p === 'string' ? { task: p } : p));
  // An agent taken off duty is not on the team for this run, and Mr Homelab is
  // never on it at all (see HOMELAB_NOT_FOR_GROUPS) — a group short of hands
  // HIRES rather than borrowing the user's specialist.
  const roster = deps
    .agents()
    .filter((a) => a.enabled !== false && a.id !== HOMELAB_AGENT_ID);
  if (!goal.trim()) return { ok: false, error: 'Give the group a goal.' };
  // Too few agents for the work is not a dead end and not a reason to double up:
  // hire until there is one pair of hands per part (up to the seat limit and the
  // user's auto-agent cap). Each hire is a REAL agent — pioneer name, the user's
  // auto-agent defaults — whose role arrives in the part it is given.
  const wanted = Math.min(MAX_GROUP_MEMBERS, parts.length);
  const hired: AgentSpec[] = [];
  while (roster.length + hired.length < wanted) {
    const h = deps.hire?.();
    if (!h) break;
    hired.push(h);
  }
  const pool = [...roster, ...hired];
  // Last resort — hiring is off AND the user has no agents: Vodo clones HIMSELF
  // for the run. The 'default' id resolves to his own spec, so each helper is
  // another instance of him with its own chat and its own part. Nothing is
  // written to the agent list; these exist for this group only.
  const temps: AgentSpec[] = pool.length
    ? []
    : parts.slice(0, MAX_GROUP_MEMBERS).map((_, i) => ({ id: 'default', name: `Vodo ${i + 1}` }));
  const agents = pool.length ? pool : temps;
  if (!agents.length) {
    return {
      ok: false,
      error:
        'A group needs at least two parts to share out — name the pieces that can run at the ' +
        'same time.',
    };
  }

  // Never more parts than people: a second task for the same agent runs in a
  // second session, which is not parallelism — and on a local box it is two
  // requests fighting over one GPU.
  const seats = Math.min(MAX_GROUP_MEMBERS, agents.length);
  // Stand-ins are paired to parts positionally: they share the 'default' id
  // (that is what makes each one Vodo), and assignTasks dedupes by id — it
  // would hand every part to the same stand-in. There is nothing to rank
  // anyway, since none of them has routing hints.
  const plan = temps.length
    ? parts.slice(0, seats).map((p, i) => ({
        task: p.task,
        agent: temps[i]!,
        matched: ['Vodo stand-in'],
      }))
    : assignTasks(parts.slice(0, seats), agents, { qualityOf: deps.qualityOf });
  // Parts beyond the seats used to be dropped SILENTLY — six blocks on three
  // agents lost three blocks and nobody was told. They queue instead: the
  // result names them, and the boss group_sends each as members go idle.
  const queued = parts.slice(seats).map((p) => p.task);
  // A part addressed to an agent a mission is holding: the name simply does not
  // resolve (they are not in the pool), so assignTasks falls back to ranking and
  // the part lands elsewhere. That is the right outcome and the wrong silence —
  // the coordinator asked for a specific model and must be told it got another.
  const onMission = deps.onMission?.() ?? [];
  const held: string[] = [];
  if (onMission.length) {
    const lower = (s: string) => s.trim().toLowerCase();
    for (const p of parts) {
      if (!p.agent) continue;
      const h = onMission.find((x) => lower(x.name) === lower(p.agent!));
      if (!h) continue;
      const took = plan.find((q) => q.task === p.task)?.agent.name;
      held.push(
        `${h.name} is on the mission "${h.mission}" — their part ` +
          (took ? `went to ${took}` : 'is queued'),
      );
    }
  }
  // A one-member "group" is a normal chat with extra ceremony — and it hides
  // the fact that nothing was parallelised behind a panel that says otherwise.
  if (plan.length < 2) {
    return {
      ok: false,
      error:
        'That did not split into parts that can run at the same time — it reads as one piece of ' +
        'work, or each step needs the one before it. Ask for it in the chat normally, or name the ' +
        'parts yourself (e.g. "research the population data AND draft the article structure").',
    };
  }

  const groupId = `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const members: GroupMember[] = plan.map((p) => ({
    sessionId: deps.createSession(projectId, p.agent.id, p.task.slice(0, 48), groupId, dir),
    agentId: p.agent.id,
    agentName: p.agent.name,
    task: p.task,
    matched: p.matched,
  }));

  const group: GroupRun = {
    id: groupId,
    projectId,
    goal: goal.trim(),
    coordinatorId,
    createdAt: Date.now(),
    members,
  };
  deps.addGroup(group);
  deps.record?.(group);
  for (const member of members) {
    // Loading starts NOW, in parallel across boxes, so a local member's first
    // turn begins at prefill instead of at reading gigabytes off disk. Resolve
    // through agentById first: `agents` is the SEATABLE roster and excludes Mr
    // Homelab, so his brief was read off `undefined` and defaulted to the
    // memory-on variant — instructing map_update on an agent that has no map.
    // Vodo stand-ins (id 'default') are not in the config, so fall back to the
    // local pool for them.
    const agent = deps.agentById?.(member.agentId) ?? agents.find((a) => a.id === member.agentId);
    if (agent?.provider && agent.model) deps.warm?.(agent.provider, agent.model);
    deps.send(
      member.sessionId,
      memberBrief(
        group.goal,
        member,
        members,
        !!dir,
        !!(dir && deps.hasProjectMd?.(dir)),
        agent?.memory !== false,
      ),
    );
  }
  return { ok: true, group, queued, held };
}
