import { assignTasks } from '@vo-coder/core';
import type { AgentSpec, ToolSpec } from '@vo-coder/providers';
import type { GroupMember, GroupRun } from '../shared/ipc-contract';

/** More than this and nobody can follow what is happening. */
export const MAX_GROUP_MEMBERS = 8;

export interface GroupDeps {
  agents: () => AgentSpec[];
  createSession: (projectId: string, agentId: string, title: string, groupId: string) => string;
  send: (sessionId: string, text: string) => void;
  addGroup: (group: GroupRun) => void;
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
  ];
}

export async function executeGroupTool(
  args: unknown,
  deps: GroupDeps,
  projectId?: string,
  /** The chat the call came from — the group's panes render there, and only there. */
  coordinatorId?: string,
): Promise<{ content: string; isError?: boolean }> {
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
  const result = await startGroup(deps, projectId, coordinatorId ?? '', goal, parts);
  if (!result.ok) return { content: result.error, isError: true };
  return {
    content:
      `Started ${result.group.members.length} agents in parallel:\n` +
      result.group.members.map((m) => `- ${m.agentName}: ${m.task}`).join('\n') +
      '\nThey are working in their own chats now — the split view shows them. Tell the user who ' +
      'is doing what, then wait for their results rather than doing the work yourself.',
  };
}

/**
 * The brief each member opens with. It states the shared goal, this member's
 * part, and who else is working — then points at the map, which is how they
 * actually stay in step: the digest is project-scoped and leads with active
 * task nodes, so each member sees the others' current plans without anyone
 * passing messages.
 */
export function memberBrief(goal: string, member: GroupMember, all: GroupMember[]): string {
  const others = all
    .filter((m) => m.sessionId !== member.sessionId)
    .map((m) => `- ${m.agentName}: ${m.task}`)
    .join('\n');
  return (
    `GROUP PROJECT — shared goal: ${goal}\n\n` +
    `YOUR PART: ${member.task}\n\n` +
    (others ? `Working alongside you, right now:\n${others}\n\n` : '') +
    'Do your part only — the others have theirs, and duplicating their work wastes everyone. ' +
    'Record your plan and progress with map_update as a "task" node (status active, then done): ' +
    'that is what the others see of you, and it is what survives if this conversation is ' +
    'summarised. Use map_query to see where they have got to before you assume anything about ' +
    'their part, and say so plainly if your part turns out to depend on theirs.'
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
): Promise<{ ok: true; group: GroupRun } | { ok: false; error: string }> {
  const agents = deps.agents();
  if (!agents.length) {
    return {
      ok: false,
      error:
        'A group needs agents to share the work between — add a couple in Agents first, each ' +
        'with a specialty.',
    };
  }
  if (!goal.trim()) return { ok: false, error: 'Give the group a goal.' };

  // Never more parts than people: a second task for the same agent runs in a
  // second session, which is not parallelism — and on a local box it is two
  // requests fighting over one GPU.
  const plan = assignTasks(parts.slice(0, Math.min(MAX_GROUP_MEMBERS, agents.length)), agents);
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
    sessionId: deps.createSession(projectId, p.agent.id, p.task.slice(0, 48), groupId),
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
  for (const member of members) {
    // Loading starts NOW, in parallel across boxes, so a local member's first
    // turn begins at prefill instead of at reading gigabytes off disk.
    const agent = agents.find((a) => a.id === member.agentId);
    if (agent?.provider && agent.model) deps.warm?.(agent.provider, agent.model);
    deps.send(member.sessionId, memberBrief(group.goal, member, members));
  }
  return { ok: true, group };
}
