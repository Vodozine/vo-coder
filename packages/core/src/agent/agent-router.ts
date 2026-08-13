import type { AgentSpec } from '@vo-coder/providers';

/**
 * "The right man for the job": match a message to the user's own specialist
 * agents. Pure keyword heuristics — no tokens spent on the decision itself.
 * Scoring: routing hints are the strong signal (3 each), being ADDRESSED by
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
   * the cards" must not summon a vision agent. Addressing the agent by name
   * still works; that's the user calling it directly.
   */
  hasImage?: boolean;
  /**
   * Agents that have run recently in this conversation, oldest first. Used
   * only to break SCORE TIES — a real keyword or name match still decides, so
   * a specialist keeps its own subject. Without this, "agents only" (whose
   * threshold is 0) hands every unmatched message to whichever agent was
   * created first, forever.
   */
  recent?: string[];
  /**
   * How capable this agent's model is, 1–10 — the same scale Auto routing uses
   * (capability-registry's quality). Supplied by the caller so this stays a
   * pure function with no catalog dependency.
   *
   * Keyword evidence still decides: this only settles TIES, which on a roster
   * of general-purpose agents is nearly every part. Without it the tie fell to
   * "who worked least recently", and a coin flip handed the hardest part of a
   * build to a 4B model while a 27B sat idle.
   */
  qualityOf?: (agent: AgentSpec) => number | undefined;
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

/** Greetings that can open a message and still leave the next word the addressee. */
const OPENING_FILLER =
  /^\s*(?:(?:hey|hei|hi|hello|halló|hallo|hæ|hae|yo|ok|okay|sæll|sæl)[\s,]+)*/i;

/**
 * Did the user ADDRESS this agent, or merely mention it?
 *
 * A name anywhere in the text used to score as being addressed, which meant
 * telling the coordinator ABOUT an agent handed him the message instead:
 * "so tarantonio should have exactly what is in v1 … start working on his
 * side" went straight to Tarantonio, who then read an order written for
 * somebody else while the coordinator never heard it at all.
 *
 * Address is either explicit — `@name`, the way every chat app spells it — or
 * vocative: the message opens with the name. Anything else is the third
 * person, and the third person belongs to the coordinator, who has a delegate
 * tool and a roster and can pass the job on himself.
 */
function nameForms(agent: AgentSpec): string[] {
  return [
    agent.name.toLowerCase().trim(),
    ...agent.name
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2 && !NAME_STOPWORDS.has(w)),
  ].filter(Boolean);
}

/** Does this agent's name appear at all — addressed or merely talked about? */
export function mentionsName(text: string, agent: AgentSpec): boolean {
  const haystack = ` ${text.toLowerCase()} `;
  return nameForms(agent).some((name) => haystack.includes(name));
}

export function addressedByName(text: string, agent: AgentSpec): boolean {
  const lower = text.toLowerCase();
  const opening = lower.replace(OPENING_FILLER, '');
  return nameForms(agent).some((name) => {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return (
      new RegExp(`(?:^|[^\\w@])@${esc}\\b`).test(lower) || new RegExp(`^${esc}\\b`).test(opening)
    );
  });
}

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

    // Being ADDRESSED is strong enough to match on its own. Being MENTIONED is
    // not evidence of anything — see addressedByName.
    if (addressedByName(text, agent)) {
      matched.push(agent.name);
      score += 3;
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
  // Ties used to fall to creation order FOREVER, which is why one agent
  // appeared to own every project: in "agents only" the threshold is 0, so
  // any message without a hint hit ties everybody at zero and the first agent
  // in the list won every time. Break ties by who worked least recently
  // instead — a real signal still decides, but a coin-flip rotates.
  const recency = (id: string) => {
    const i = opts.recent?.indexOf(id) ?? -1;
    return i === -1 ? -1 : opts.recent!.length - i; // higher = more recent
  };
  // Capability outranks recency as a tiebreak: when nothing in the text picks a
  // specialist, the stronger model is a better answer than the least-recent one.
  // Unrated models sort as mid (5) rather than last, so an agent on a model the
  // catalog has never heard of is not permanently benched behind a known weak one.
  const quality = (agent: AgentSpec) => (opts.qualityOf ? (opts.qualityOf(agent) ?? 5) : 0);
  return ranked.sort(
    (a, b) =>
      b.score - a.score ||
      quality(b.agent) - quality(a.agent) ||
      recency(a.agent.id) - recency(b.agent.id),
  );
}

/** A part, optionally with the agent the coordinator wants on it. */
export interface TaskRequest {
  task: string;
  /** Agent id or name. Unknown names fall through to the ranking. */
  agent?: string;
}

/**
 * Assign a slate of tasks across DIFFERENT agents — the group-project split.
 *
 * Greedy by best fit, but each agent is taken at most once until everyone has
 * a task: the point of a group is that several specialists work, and the
 * single-winner ranking would otherwise hand every task to whoever scores
 * broadest. A task nobody matches still gets the best free agent rather than
 * being dropped — an unassigned task is worse than an imperfect assignee.
 *
 * A part may NAME its agent. The coordinator has read the whole job and knows
 * which part is hardest, which no keyword score can tell — so an explicit
 * choice is honoured first, and the ranking is what decides the rest.
 */
export function assignTasks(
  tasks: Array<string | TaskRequest>,
  agents: AgentSpec[],
  opts: RankOpts = {},
): Array<{ task: string; agent: AgentSpec; matched: string[] }> {
  if (!agents.length) return [];
  const entries = tasks.map((t) => (typeof t === 'string' ? { task: t } : t));
  const out: Array<{ task: string; agent: AgentSpec; matched: string[] } | undefined> = new Array(
    entries.length,
  );
  const used = new Set<string>();
  const wanted = (name: string): AgentSpec | undefined => {
    const key = name.trim().toLowerCase();
    return agents.find((a) => a.id.toLowerCase() === key || a.name.toLowerCase() === key);
  };

  // Named parts are reserved FIRST, whatever their position. Order-of-arrival
  // would otherwise beat the coordinator's judgement: the hardest part is
  // usually listed last, and by then a greedy pass has already spent the agent
  // it was promised to.
  entries.forEach((e, i) => {
    const chosen = e.agent ? wanted(e.agent) : undefined;
    // Two parts on one agent is not parallel work — the later one is ranked.
    if (chosen && !used.has(chosen.id)) {
      used.add(chosen.id);
      out[i] = { task: e.task, agent: chosen, matched: ['chosen for this part'] };
    }
  });

  entries.forEach((e, i) => {
    if (out[i]) return;
    // Everyone has one? Start a second round rather than refusing work.
    if (used.size >= agents.length) used.clear();
    const ranked = rankAgents(e.task, agents, opts);
    const pick = ranked.find((r) => !used.has(r.agent.id)) ?? ranked[0];
    if (!pick) return;
    used.add(pick.agent.id);
    out[i] = {
      task: e.task,
      agent: pick.agent,
      matched: pick.matched.length ? pick.matched : ['best available'],
    };
  });

  return out.filter((r): r is { task: string; agent: AgentSpec; matched: string[] } => !!r);
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
