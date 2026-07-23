import type { AgentSpec } from '@vo-coder/providers';

/**
 * "The right man for the job": match a message to the user's own specialist
 * agents. Pure keyword heuristics — no tokens spent on the decision itself.
 * Scoring: routing hints are the strong signal (3 each), the agent's name
 * counts (2), and overlap with its system prompt adds up to 3. A match needs
 * score ≥ 3 so casual word collisions don't hijack the conversation — unless
 * `always` is set ("My agents only" mode), where the best-scoring agent wins
 * regardless so the turn always lands on one of the user's agents.
 */
export function matchAgentForMessage(
  text: string,
  agents: AgentSpec[],
  opts: { always?: boolean } = {},
): { agent: AgentSpec; matched: string[] } | null {
  const haystack = ` ${text.toLowerCase()} `;
  const minScore = opts.always ? 0 : 3;
  let best: { agent: AgentSpec; matched: string[]; score: number } | null = null;

  for (const agent of agents) {
    const matched: string[] = [];
    let score = 0;

    const hints = (agent.routingHints ?? '')
      .split(/[,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 1);
    for (const hint of hints) {
      if (haystack.includes(hint)) {
        matched.push(hint);
        score += 3;
      }
    }

    for (const word of agent.name.toLowerCase().split(/\s+/)) {
      if (word.length > 2 && haystack.includes(word)) {
        matched.push(agent.name);
        score += 2;
        break;
      }
    }

    const promptWords = new Set(
      (agent.systemPrompt ?? '').toLowerCase().match(/[a-z][a-z0-9-]{4,}/g) ?? [],
    );
    let promptHits = 0;
    for (const word of promptWords) {
      if (promptHits >= 3) break;
      if (haystack.includes(word)) promptHits++;
    }
    score += promptHits;
    if (promptHits > 0 && matched.length === 0) matched.push(`${promptHits} specialty terms`);

    if (score >= minScore && (!best || score > best.score)) {
      best = { agent, matched, score };
    }
  }

  if (!best) return null;
  return {
    agent: best.agent,
    matched: best.matched.length ? [...new Set(best.matched)] : ['best available'],
  };
}
