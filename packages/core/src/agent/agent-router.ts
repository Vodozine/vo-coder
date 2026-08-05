import type { AgentSpec } from '@vo-coder/providers';

/**
 * "The right man for the job": match a message to the user's own specialist
 * agents. Pure keyword heuristics — no tokens spent on the decision itself.
 * Scoring: routing hints are the strong signal (3 each), being addressed by
 * name counts (3), and overlap with its system prompt adds up to 3. A match needs
 * score ≥ 3 so casual word collisions don't hijack the conversation — unless
 * `always` is set ("My agents only" mode), where the best-scoring agent wins
 * regardless so the turn always lands on one of the user's agents.
 */
export interface AgentRank {
  agent: AgentSpec;
  matched: string[];
  score: number;
}

export interface RankOpts {
  /**
   * Whether the turn actually involves an image (current parts or recent
   * history). Without one, vision-flavored words score NOTHING — "i can't SEE
   * the cards" must not summon a vision agent. Typing the agent's name still
   * works; that's the user calling it directly.
   */
  hasImage?: boolean;
}

/** Words that only signal a vision job when a photo is actually on the table. */
const VISION_WORDS = new Set([
  'see', 'sees', 'seen', 'look', 'looks', 'looking', 'watch', 'view', 'views',
  'eye', 'eyes', 'vision', 'visual', 'visuals', 'image', 'images', 'img',
  'photo', 'photos', 'photograph', 'photographs', 'picture', 'pictures',
  'pic', 'pics', 'screenshot', 'screenshots', 'camera',
]);

/** Filler that must never count as "the user said this agent's name". */
const NAME_STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'you', 'your', 'our']);

/** Beyond this many hint hits, more keywords stop buying more score. */
const MAX_HINT_HITS = 3;

/** Score every agent against the message; sorted best-first, stable on ties. */
export function rankAgents(text: string, agents: AgentSpec[], opts: RankOpts = {}): AgentRank[] {
  const haystack = ` ${text.toLowerCase()} `;
  const visionGated = (word: string) => !opts.hasImage && VISION_WORDS.has(word);
  const ranked: AgentRank[] = agents.map((agent) => {
    const matched: string[] = [];
    let score = 0;

    const hints = (agent.routingHints ?? '')
      .split(/[,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 1);
    // Hints are capped. Uncapped, an agent with ten hints scored 30 against a
    // focused agent's 3 and simply owned every project — breadth of keywords
    // is not evidence of being the right specialist.
    let hintHits = 0;
    for (const hint of hints) {
      // A hint made purely of vision words needs an actual image to fire.
      if (hint.split(/\s+/).every(visionGated)) continue;
      if (haystack.includes(hint)) {
        matched.push(hint);
        if (hintHits < MAX_HINT_HITS) score += 3;
        hintHits++;
      }
    }

    // Stopwords filtered, a name hit means the user addressed this agent —
    // strong enough to match on its own.
    for (const word of agent.name.toLowerCase().split(/\s+/)) {
      if (word.length > 2 && !NAME_STOPWORDS.has(word) && haystack.includes(word)) {
        matched.push(agent.name);
        score += 3;
        break;
      }
    }

    const promptWords = new Set(
      (agent.systemPrompt ?? '').toLowerCase().match(/[a-z][a-z0-9-]{4,}/g) ?? [],
    );
    let promptHits = 0;
    for (const word of promptWords) {
      if (promptHits >= 3) break;
      if (visionGated(word)) continue;
      if (haystack.includes(word)) promptHits++;
    }
    score += promptHits;
    if (promptHits > 0 && matched.length === 0) matched.push(`${promptHits} specialty terms`);

    return { agent, matched: [...new Set(matched)], score };
  });
  // Stable sort keeps creation order on ties — the user's first agent is the
  // implicit generalist.
  return ranked.sort((a, b) => b.score - a.score);
}

/**
 * Assign a slate of tasks across DIFFERENT agents — the group-project split.
 *
 * Greedy by best fit, but each agent is taken at most once until everyone has
 * a task: the point of a group is that several specialists work, and the
 * single-winner ranking would otherwise hand every task to whoever scores
 * broadest. A task nobody matches still gets the best free agent rather than
 * being dropped — an unassigned task is worse than an imperfect assignee.
 */
export function assignTasks(
  tasks: string[],
  agents: AgentSpec[],
  opts: RankOpts = {},
): Array<{ task: string; agent: AgentSpec; matched: string[] }> {
  if (!agents.length) return [];
  const out: Array<{ task: string; agent: AgentSpec; matched: string[] }> = [];
  const used = new Set<string>();
  for (const task of tasks) {
    const ranked = rankAgents(task, agents, opts);
    // Everyone has one? Start a second round rather than refusing work.
    if (used.size >= agents.length) used.clear();
    const pick = ranked.find((r) => !used.has(r.agent.id)) ?? ranked[0];
    if (!pick) continue;
    used.add(pick.agent.id);
    out.push({
      task,
      agent: pick.agent,
      matched: pick.matched.length ? pick.matched : ['best available'],
    });
  }
  return out;
}

export function matchAgentForMessage(
  text: string,
  agents: AgentSpec[],
  opts: { always?: boolean } & RankOpts = {},
): { agent: AgentSpec; matched: string[] } | null {
  const minScore = opts.always ? 0 : 3;
  const best = rankAgents(text, agents, opts).find((r) => r.score >= minScore);
  if (!best) return null;
  return {
    agent: best.agent,
    matched: best.matched.length ? best.matched : ['best available'],
  };
}
