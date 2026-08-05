import { AgentSession } from '@vo-coder/core';
import type { AgentSpec, BoundModel, ToolSpec } from '@vo-coder/providers';

/**
 * Vodo as the strong teammate: a weak (usually local) group member that gets
 * stuck asks, Vodo does that one operation with real tools, hands the result
 * back, and leaves a LESSON in the project's memory map so next time the
 * member can do it alone. The economics this enables: one strong cloud model
 * coordinating and backstopping a team of free local models.
 */

export interface HelperBackend {
  /** Vodo's spec, resolved on the user's default (strong) model — never cheap-routed. */
  vodoSpec(): AgentSpec;
  resolve(spec: AgentSpec): BoundModel;
  tools(dir?: string): ToolSpec[];
  execute(
    name: string,
    args: unknown,
    dir?: string,
    projectId?: string,
  ): Promise<{ content: string; isError?: boolean }>;
  onUsage(bound: BoundModel | undefined, usage: { inputTokens: number; outputTokens: number }, projectId?: string): void;
}

/** A help run is a favor, not a project — keep it tight. */
const HELP_MAX_TOOL_TURNS = 8;

export function helpToolSpecs(): ToolSpec[] {
  return [
    {
      name: 'ask_vodo',
      description:
        'Ask Vodo — a stronger model — for help when you are stuck. Describe what you are trying ' +
        'to do, what you tried, and the exact error or blocker. Vodo will either DO that one step ' +
        'with its own tools and give you the result, or explain exactly how to do it. Use it ' +
        'after a tool call fails twice, or when you genuinely do not know how to proceed — not ' +
        'as a substitute for doing your own part. A lesson from the help is saved to the project ' +
        'memory so you can do it yourself next time.',
      inputSchema: {
        type: 'object',
        properties: {
          problem: {
            type: 'string',
            description: 'What you are trying to do, what you tried, and what happened — be exact',
          },
        },
        required: ['problem'],
      },
    },
  ];
}

/**
 * Vodo steps in: a bounded headless run (missions pattern) on the STRONG
 * model, with the member's own workspace. Returns the answer for the member,
 * ending with a "LESSON:" line the caller persists to the map.
 */
export async function vodoStepIn(
  backend: HelperBackend,
  opts: {
    problem: string;
    agentName: string;
    task?: string;
    dir?: string;
    projectId?: string;
  },
): Promise<string> {
  const base = backend.vodoSpec();
  const spec: AgentSpec = {
    ...base,
    id: `help_${Date.now().toString(36)}`,
    name: 'Vodo (helping)',
    systemPrompt:
      `${base.systemPrompt ?? ''}\n\n` +
      `You are STEPPING IN for a weaker teammate ("${opts.agentName}") who is stuck` +
      (opts.task ? ` on their part: "${opts.task}"` : '') +
      '. Do the ONE thing they are stuck on — no more. If it needs a tool, use it and give them ' +
      'the concrete result (file written, command output, exact content). If it is a knowledge ' +
      'gap, give the exact steps or the exact call to make. Be brief: they need the unblock, not ' +
      'an essay. End with one line starting exactly "LESSON:" — a single sentence the teammate ' +
      'should remember to handle this alone next time.',
  };

  let text = '';
  let errMsg: string | undefined;
  let bound: BoundModel | undefined;
  const done = new Promise<void>((resolveDone) => {
    const session = new AgentSession({
      id: spec.id,
      spec,
      maxToolTurns: HELP_MAX_TOOL_TURNS,
      resolve: (s) => {
        bound = backend.resolve(s);
        return bound;
      },
      emit: (_sid, event) => {
        if (event.type === 'text_delta') text += event.text;
        else if (event.type === 'error') errMsg = event.error.message;
        else if (event.type === 'usage') backend.onUsage(bound, event, opts.projectId);
        else if (event.type === 'status' && event.status === 'idle') resolveDone();
      },
      toolExecutor: {
        tools: () => backend.tools(opts.dir),
        execute: (name, args) => backend.execute(name, args, opts.dir, opts.projectId),
      },
      // Vodo acts inside the member's own pre-approved scope (the group grant
      // covers project-folder work) — a modal here would just recreate the
      // stall the member escalated to escape.
      permission: async () => 'allow',
    });
    session.send([{ type: 'text', text: opts.problem }]);
  });
  await done;

  if (!text.trim()) {
    return `Vodo could not help this time${errMsg ? ` (${errMsg})` : ''} — try rephrasing the problem, or flag it in your final summary.`;
  }
  return text.trim();
}

/** The trailing "LESSON: …" line of a help answer, if the model provided one. */
export function extractLesson(answer: string): string | null {
  const lines = answer.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^LESSON:\s*(.+)$/i.exec(lines[i]!.trim());
    if (m?.[1]) return m[1].trim();
  }
  return null;
}
