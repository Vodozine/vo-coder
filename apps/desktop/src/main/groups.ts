import { assignTasks } from '@vo-coder/core';
import type { AgentSpec } from '@vo-coder/providers';
import type { GroupMember, GroupRun } from '../shared/ipc-contract';

/** More than this and nobody can follow what is happening. */
export const MAX_GROUP_MEMBERS = 8;

export interface GroupDeps {
  agents: () => AgentSpec[];
  /** One-shot completion on the cheapest adequate model — no tools, no history. */
  complete: (prompt: string) => Promise<string>;
  createSession: (projectId: string, agentId: string, title: string, groupId: string) => string;
  send: (sessionId: string, text: string) => void;
  addGroup: (group: GroupRun) => void;
}

/**
 * Split a goal into parts that can genuinely run side by side.
 *
 * The model is asked for the split because "what are the separable parts of
 * this job" is a judgement call, not a parse. Everything after that is
 * deterministic: WHICH agent gets which part is decided by the same scorer
 * the single-agent router uses, so the assignment is inspectable and testable
 * rather than another thing the model can get creatively wrong.
 */
export async function planGroup(
  goal: string,
  agents: AgentSpec[],
  complete: (prompt: string) => Promise<string>,
  max = MAX_GROUP_MEMBERS,
): Promise<Array<{ task: string; agent: AgentSpec; matched: string[] }>> {
  const roster = agents
    .map((a) => `- ${a.name}${a.routingHints ? ` (specialty: ${a.routingHints})` : ''}`)
    .join('\n');
  const prompt =
    'Split this goal into independent parts that different people could work on AT THE SAME ' +
    'TIME. Parts must not depend on each other finishing first — if the work is inherently ' +
    'sequential, return ONE part.\n' +
    `At most ${max} parts. Each part is one sentence, written as an instruction to the person ` +
    'doing it, and must carry enough context to act on alone.\n' +
    `The team available:\n${roster}\n\n` +
    'Output ONLY a JSON array of strings.\n\n' +
    `GOAL: ${goal}`;

  let tasks: string[] = [];
  try {
    const raw = await complete(prompt);
    const json = raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1);
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) {
      tasks = parsed
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        .map((t) => t.trim())
        .slice(0, max);
    }
  } catch {
    /* a splitter that fails must not stop the work — fall through */
  }
  // No usable split: the whole goal is one task. A group of one still beats
  // an error, and the user can see it was not divisible.
  if (!tasks.length) tasks = [goal];
  return assignTasks(tasks, agents);
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

  const plan = await planGroup(goal, agents, deps.complete);
  if (!plan.length) return { ok: false, error: 'Could not split that into work.' };

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
    deps.send(member.sessionId, memberBrief(group.goal, member, members));
  }
  return { ok: true, group };
}
