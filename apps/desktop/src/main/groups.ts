import { assignTasks } from '@vo-coder/core';
import type { AgentSpec, ToolSpec } from '@vo-coder/providers';
import { HOMELAB_AGENT_ID } from '../shared/homelab';
import type { GroupMember, GroupRun } from '../shared/ipc-contract';

/** More than this and nobody can follow what is happening. */
export const MAX_GROUP_MEMBERS = 8;

export interface GroupDeps {
  agents: () => AgentSpec[];
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
        'results together.',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The shared goal, one sentence' },
          parts: {
            type: 'array',
            items: { type: 'string' },
            description:
              '2-8 independent parts. Each is an instruction to the person doing it and must ' +
              'carry enough context to act on alone.',
          },
        },
        required: ['goal', 'parts'],
      },
    },
    {
      name: 'group_send',
      description:
        'Hand work to ONE group member, in their own chat. You are the coordinator — delegate ' +
        'instead of doing member-level work yourself: send the assembly job to your most capable ' +
        'member, send a missing or broken part back to its owner, give follow-up instructions or ' +
        'a fix list. Non-blocking: it returns at once, and you are woken again when the whole ' +
        'group goes quiet. Only do a step yourself when no member can (wrong tools, failed at it ' +
        'twice).',
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
          '.',
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
  const a = (args ?? {}) as { goal?: unknown; parts?: unknown };
  const goal = typeof a.goal === 'string' ? a.goal.trim() : '';
  const parts = Array.isArray(a.parts)
    ? a.parts.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    : [];
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
      '\nThey are working in their own chats now — the split view shows them. Tell the user who ' +
      'is doing what, then wait for their results rather than doing the work yourself. Mid-run ' +
      'you can hand any of them follow-up work with group_send.',
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
        'append:true) — one giant write can stall your whole turn.\n\n'
      : '') +
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
  parts: string[],
  /** Shared working folder — every member gets it as their chat's dir. */
  dir?: string,
): Promise<{ ok: true; group: GroupRun } | { ok: false; error: string }> {
  // Mr Homelab joins a group only when a part is actually about
  // infrastructure — he owns his own tab, and on a small roster he would
  // otherwise be handed "write the About page" just to fill a seat. The test
  // is his ROUTING HINTS only: general ranking also scores system-prompt
  // words, and his long prompt matches ordinary copy ("about", "network")
  // enough to sneak him into unrelated jobs.
  const allAgents = deps.agents();
  const homelab = allAgents.find((a) => a.id === HOMELAB_AGENT_ID);
  const infraHints = (homelab?.routingHints ?? '')
    .split(/[,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 1);
  const infraScore = (task: string): number => {
    const hay = ` ${task.toLowerCase()} `;
    return infraHints.filter((h) => hay.includes(h)).length;
  };
  const agents = allAgents.filter((a) => a.id !== HOMELAB_AGENT_ID);
  if (!agents.length && !homelab) {
    return {
      ok: false,
      error:
        'A group needs agents to share the work between — add a couple in Agents first, each ' +
        'with a specialty.',
    };
  }
  if (!goal.trim()) return { ok: false, error: 'Give the group a goal.' };

  // Mr Homelab takes the most infrastructure-shaped part directly — his seat
  // is decided by his hints, not by a general ranking that can be swayed by
  // prose — and the rest are spread across the other agents.
  let homelabPart: string | undefined;
  if (homelab) {
    let best = 0;
    for (const p of parts) {
      const s = infraScore(p);
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
  const plan = agents.length ? assignTasks(rest.slice(0, seats), agents) : [];
  if (homelabPart && homelab) {
    plan.push({ task: homelabPart, agent: homelab, matched: ['infrastructure'] });
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
    deps.send(member.sessionId, memberBrief(group.goal, member, members, !!dir));
  }
  return { ok: true, group };
}
