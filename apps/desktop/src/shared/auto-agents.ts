import type { AgentSpec } from '@vo-coder/providers';

/**
 * Auto agents — the hands Vodo hires on demand, so a group is never blocked by
 * "you have not built enough specialists yet". He does not invent names or
 * settings: the NAME comes from the pool below, the SETTINGS come from the
 * user's auto-agent defaults, and the ROLE arrives in the task he writes. That
 * split is what makes hiring one a single cheap decision.
 *
 * Named after the people the field is built on, so a group reads as a team of
 * engineers rather than "Agent 3".
 */
export const AUTO_AGENT_NAMES = [
  'Turing',
  'Lovelace',
  'Hopper',
  'Shannon',
  'Babbage',
  'Dijkstra',
  'Knuth',
  'Ritchie',
  'Thompson',
  'Minsky',
  'McCarthy',
  'Hinton',
  'Engelbart',
  'Kay',
  'Backus',
  'Cerf',
  'Hamming',
  'Liskov',
  'Zuse',
  'Sutherland',
  'Wilkes',
  'Karp',
  'Sutton',
  'LeCun',
];

/** Ceiling on how many agents Vodo may hire. Never more than the pool. */
export const AUTO_AGENT_MAX_CAP = AUTO_AGENT_NAMES.length;

export const DEFAULT_AUTO_AGENT_PROMPT =
  'You are a working engineer on a team. Your ROLE for this job is in the assignment you are ' +
  'given — read it as your job description and stay inside it.\n' +
  '- Do the part you were handed, completely, and write the files it asks for. Finishing beats ' +
  'commentary: a reply that describes work nobody can open is not done.\n' +
  '- You cannot see the coordinator\'s chat or the other members\' work. If the brief is missing ' +
  'something you need, say exactly what is missing in your reply — the coordinator reads it.\n' +
  '- Never touch a file another part owns; that is how parallel work corrupts itself.\n' +
  '- Say plainly when something failed and why. A quiet half-finished part is worse than a ' +
  'reported one.';

/** The user's defaults for every agent Vodo hires. */
export interface AutoAgentDefaults {
  /** How many auto agents may exist at once (1…AUTO_AGENT_MAX_CAP). */
  max: number;
  /** Empty = inherit whatever the harness would pick (routing / default model). */
  provider: string;
  model: string;
  systemPrompt: string;
  /** Carry the project between jobs. Workers default OFF — they work from the brief. */
  memory: boolean;
  /** MCP servers each hire may drive. */
  mcpServers: string[];
}

export const DEFAULT_AUTO_AGENTS: AutoAgentDefaults = {
  max: 16,
  provider: '',
  model: '',
  systemPrompt: DEFAULT_AUTO_AGENT_PROMPT,
  memory: false,
  mcpServers: [],
};

/** Ids are stable and recognisable: auto:turing. */
export function autoAgentId(name: string): string {
  return `auto:${name.toLowerCase()}`;
}

export function isAutoAgent(spec: { id: string }): boolean {
  return spec.id.startsWith('auto:');
}

/**
 * The next unused pioneer name, or undefined when the pool is exhausted.
 * `taken` is matched case-insensitively so a hand-made "Turing" is not cloned.
 */
export function nextAutoAgentName(taken: Iterable<string>): string | undefined {
  const used = new Set([...taken].map((n) => n.trim().toLowerCase()));
  return AUTO_AGENT_NAMES.find((n) => !used.has(n.toLowerCase()));
}

/** Build one hire from the user's defaults. */
export function makeAutoAgent(name: string, defaults: AutoAgentDefaults): AgentSpec {
  return {
    id: autoAgentId(name),
    name,
    systemPrompt: defaults.systemPrompt || DEFAULT_AUTO_AGENT_PROMPT,
    ...(defaults.provider ? { provider: defaults.provider as AgentSpec['provider'] } : {}),
    ...(defaults.model ? { model: defaults.model } : {}),
    ...(defaults.mcpServers.length ? { mcpServers: [...defaults.mcpServers] } : {}),
    memory: defaults.memory,
    auto: true,
  };
}
