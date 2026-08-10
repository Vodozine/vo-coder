import { assignTasks } from '@vo-coder/core';
import type { TaskRequest } from '@vo-coder/core';
import type { AgentSpec, ToolSpec } from '@vo-coder/providers';
import { HOMELAB_AGENT_ID } from '../shared/homelab';
import type { GroupMember, GroupRun } from '../shared/ipc-contract';

/** More than this and nobody can follow what is happening. */
export const MAX_GROUP_MEMBERS = 8;

/**
 * Does this task read as INFRASTRUCTURE work, measured by Mr Homelab's own
 * routing hints? Whole words only, and callers require TWO independent
 * signals (INFRA_SIGNALS_MIN): his hints contain everyday dev words
 * ("server", "network"), and a single substring hit inside ordinary copy
 * kept conscripting him — seen live: the infra specialist spent a whole
 * group run generating website images because a part said "preview server".
 */
export function infraSignals(routingHints: string | undefined, task: string): number {
  const hints = (routingHints ?? '')
    .split(/[,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 1);
  const hay = task.toLowerCase();
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return hints.filter((h) => new RegExp(`(^|\\W)${esc(h)}(\\W|$)`).test(hay)).length;
}

/** Seats and group_add both demand this many distinct hint matches. */
export const INFRA_SIGNALS_MIN = 2;

export interface GroupDeps {
  agents: () => AgentSpec[];
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
  ];
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
    // now so the instruction begins at prefill, not at reading weights.
    const agent = deps.agents().find((ag) => ag.id === member.agentId);
    if (agent?.provider && agent.model) deps.warm?.(agent.provider, agent.model);
    deps.send(
      member.sessionId,
      `FROM VODO (your coordinator) — new instruction:\n\n${message}\n\n` +
        'Do this now, record progress with map_update, and stop when it is done.',
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
    // Off-duty agents stay off duty — but Mr Homelab CAN be seated here: an
    // explicit named request from the coordinator is a deliberate choice, not
    // the accidental auto-seating the group_start filter guards against.
    const roster = deps.agents().filter((ag) => ag.enabled !== false);
    const agent =
      roster.find((ag) => norm(ag.name) === norm(agentName)) ??
      roster.find((ag) => norm(ag.name).includes(norm(agentName)));
    if (!agent) {
      return {
        content:
          `No enabled agent matches "${agentName}". Roster: ` +
          `${roster.map((ag) => ag.name).join(', ') || '(empty)'}.`,
        isError: true,
      };
    }
    if (group.members.some((m) => m.agentId === agent.id)) {
      return {
        content: `${agent.name} is already in the group — reach them with group_send.`,
        isError: true,
      };
    }
    // The deliberate door gets the same test as the automatic seat: Mr
    // Homelab takes INFRASTRUCTURE work only. Seen live: he was summoned by
    // name into a website group and spent the run generating images.
    if (agent.id === HOMELAB_AGENT_ID && infraSignals(agent.routingHints, task) < INFRA_SIGNALS_MIN) {
      return {
        content:
          'Mr Homelab only takes INFRASTRUCTURE work — VMs, containers, networking, backups ' +
          '(the task must match his routing hints at least twice, whole words). This task does ' +
          'not read as infra: hand it to another member, or restate it with the actual infra ' +
          'terms if it truly is.',
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
      memberBrief(updated.goal, member, updated.members, !!dir, !!(dir && deps.hasProjectMd?.(dir))),
    );
    return {
      content:
        `${agent.name} joined the group (${updated.members.length}/${MAX_GROUP_MEMBERS} seats) ` +
        'and received the task. They work in their own chat now — reach them again with ' +
        'group_send; you will be woken when the group goes quiet.',
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
      ? 'You all share ONE project folder — ws_list / ws_read / ws_write work there. ' +
        'Deliverables are FILES in that folder, not chat text: write yours with ws_write. ' +
        'Long files: write them in several pieces (first call normal, the rest with ' +
        'append:true) — one giant write can stall your whole turn.\n\n' +
        'TEAM PAPERWORK GOES IN .vodo/team/ — any notes, reports, checklists or scratch ' +
        'files meant for the team (or for Vodo) are written under .vodo/team/, NEVER into ' +
        'the project root. The root holds the product the user asked for, nothing else.\n\n' +
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
    'Record your plan and progress with map_update as a "task" node (status active, then done): ' +
    'that is what the others see of you, and it is what survives if this conversation is ' +
    'summarised. Use map_query to see where they have got to before you assume anything about ' +
    'their part, and say so plainly if your part turns out to depend on theirs.\n\n' +
    'STUCK? Call ask_vodo and describe exactly what you tried and what happened — Vodo (a ' +
    'stronger model) will do that one step or teach you the way, and a LESSON is saved to the ' +
    'project memory. Check your briefing for lessons with your name before asking the same thing ' +
    'twice. Vodo also reviews your work: when a VODO REVIEW message arrives, fix what it lists ' +
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
    }
  | { ok: false; error: string }
> {
  // Mr Homelab joins a group only when a part is GENUINELY about
  // infrastructure — he owns his own tab, and on a small roster he would
  // otherwise be handed "write the About page" just to fill a seat. The test
  // is his ROUTING HINTS with whole-word matching and a two-signal minimum:
  // his hints carry everyday dev words ("server", "network"), and one
  // substring hit in ordinary copy kept conscripting him anyway.
  // An agent taken off duty is not on the team for this run either.
  // A part is either bare text or text plus the agent the coordinator picked.
  // Everything below works on the normalized form so the "who does this" answer
  // has exactly one shape.
  const parts: TaskRequest[] = rawParts.map((p) => (typeof p === 'string' ? { task: p } : p));
  const allAgents = deps.agents().filter((a) => a.enabled !== false);
  const homelab = allAgents.find((a) => a.id === HOMELAB_AGENT_ID);
  const infraScore = (task: string): number => infraSignals(homelab?.routingHints, task);
  const roster = allAgents.filter((a) => a.id !== HOMELAB_AGENT_ID);
  if (!goal.trim()) return { ok: false, error: 'Give the group a goal.' };
  // An empty roster is not a dead end: Vodo clones HIMSELF for the run. The
  // 'default' id resolves to his own spec (the user's system prompt, the
  // default provider/model), so each helper is another instance of him with
  // its own chat and its own part — parallel work without making the user
  // invent specialists first. Nothing is written to the agent list; these
  // exist for this group only.
  const temps: AgentSpec[] = roster.length
    ? []
    : parts
        .slice(0, MAX_GROUP_MEMBERS - (homelab ? 1 : 0))
        .map((_, i) => ({ id: 'default', name: `Vodo ${i + 1}` }));
  const agents = roster.length ? roster : temps;
  if (!agents.length && !homelab) {
    return {
      ok: false,
      error:
        'A group needs at least two parts to share out — name the pieces that can run at the ' +
        'same time.',
    };
  }

  // Mr Homelab takes the most infrastructure-shaped part directly — his seat
  // is decided by his hints, not by a general ranking that can be swayed by
  // prose — and the rest are spread across the other agents.
  let homelabPart: TaskRequest | undefined;
  if (homelab) {
    let best = INFRA_SIGNALS_MIN - 1;
    for (const p of parts) {
      const s = infraScore(p.task);
      if (s > best) {
        best = s;
        homelabPart = p;
      }
    }
  }
  const rest = parts.filter((p) => p !== homelabPart);
  // Never more parts than people: a second task for the same agent runs in a
  // second session, which is not parallelism — and on a local box it is two
  // requests fighting over one GPU.
  const seats = Math.min(MAX_GROUP_MEMBERS - (homelabPart ? 1 : 0), agents.length);
  // Stand-ins are paired to parts positionally: they share the 'default' id
  // (that is what makes each one Vodo), and assignTasks dedupes by id — it
  // would hand every part to the same stand-in. There is nothing to rank
  // anyway, since none of them has routing hints.
  const plan = temps.length
    ? rest.slice(0, seats).map((p, i) => ({
        task: p.task,
        agent: temps[i]!,
        matched: ['Vodo stand-in'],
      }))
    : agents.length
      ? assignTasks(rest.slice(0, seats), agents, { qualityOf: deps.qualityOf })
      : [];
  // Parts beyond the seats used to be dropped SILENTLY — six blocks on three
  // agents lost three blocks and nobody was told. They queue instead: the
  // result names them, and the boss group_sends each as members go idle.
  const queued = rest.slice(seats).map((p) => p.task);
  if (homelabPart && homelab) {
    plan.push({ task: homelabPart.task, agent: homelab, matched: ['infrastructure'] });
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
    // turn begins at prefill instead of at reading gigabytes off disk.
    const agent = agents.find((a) => a.id === member.agentId);
    if (agent?.provider && agent.model) deps.warm?.(agent.provider, agent.model);
    deps.send(
      member.sessionId,
      memberBrief(group.goal, member, members, !!dir, !!(dir && deps.hasProjectMd?.(dir))),
    );
  }
  return { ok: true, group, queued };
}
