/**
 * MCP awareness: watch what the user is actually working on and, when a topic
 * keeps coming up that a known MCP server family covers, suggest wiring one in
 * (or building a custom one when nothing fits). Pure heuristics, no tokens
 * spent — the trigger is repetition, not a model call.
 */

export interface McpTopicRule {
  topic: string;
  pattern: RegExp;
  /** Registry search query that finds candidate servers. */
  query: string;
  reason: string;
  /** Connected server names that already cover this topic (suppress suggestion). */
  coveredBy?: RegExp;
}

export const DEFAULT_TOPIC_RULES: McpTopicRule[] = [
  {
    topic: 'github',
    pattern: /\bgit ?hub\b|\bpull request\b|\bmerge request\b|\bmy repo\b|\brepositor(y|ies)\b/i,
    query: 'github',
    reason: "You keep mentioning GitHub — an MCP server can give this agent real repo/PR/issue access.",
    coveredBy: /github/i,
  },
  {
    topic: 'database',
    pattern: /\bpostgres(ql)?\b|\bmysql\b|\bsqlite\b|\bdatabase schema\b|\bsql quer/i,
    query: 'database sql',
    reason: 'Sounds like database work — an MCP server can let this agent query it directly.',
    coveredBy: /postgres|mysql|sqlite|db/i,
  },
  {
    topic: 'web-browsing',
    pattern: /\bscrape\b|\bfetch (the |a )?(web)?page\b|\bbrowse the web\b|\bweb search\b|\bsearch the web\b/i,
    query: 'browser fetch web',
    reason: 'You want live web content — an MCP server can fetch or browse pages for the agent.',
    coveredBy: /fetch|browser|playwright|puppeteer|search/i,
  },
  {
    topic: 'filesystem',
    pattern: /\bmy files\b|\bread the file\b|\bproject folder\b|\blist (the )?files\b|\bopen the file\b/i,
    query: 'filesystem',
    reason: 'The agent keeps needing your files — the filesystem MCP server grants scoped access.',
    coveredBy: /^fs$|file/i,
  },
  {
    topic: 'slack',
    pattern: /\bslack\b/i,
    query: 'slack',
    reason: 'Slack keeps coming up — an MCP server can read and post for you.',
    coveredBy: /slack/i,
  },
  {
    topic: 'kubernetes',
    pattern: /\bkubernetes\b|\bkubectl\b|\bk8s\b/i,
    query: 'kubernetes',
    reason: 'Kubernetes work spotted — an MCP server can inspect and manage the cluster.',
    coveredBy: /k8s|kube/i,
  },
  {
    topic: 'docker',
    pattern: /\bdocker (container|image|compose)\b|\bcontainer logs\b/i,
    query: 'docker',
    reason: 'Container work spotted — an MCP server can manage Docker for the agent.',
    coveredBy: /docker/i,
  },
];

export interface McpSuggestion {
  topic: string;
  reason: string;
  query: string;
}

export interface AdvisorOptions {
  /** Mentions of a topic before suggesting. Default 2. */
  mentionThreshold?: number;
  rules?: McpTopicRule[];
}

export class McpAdvisor {
  private counts = new Map<string, number>();
  private suggested = new Set<string>();
  private threshold: number;
  private rules: McpTopicRule[];

  constructor(opts: AdvisorOptions = {}) {
    this.threshold = opts.mentionThreshold ?? 2;
    this.rules = opts.rules ?? DEFAULT_TOPIC_RULES;
  }

  /** Feed each user message; returns at most one new suggestion. */
  observe(text: string, connectedServers: string[]): McpSuggestion | null {
    for (const rule of this.rules) {
      if (!rule.pattern.test(text)) continue;
      if (rule.coveredBy && connectedServers.some((s) => rule.coveredBy!.test(s))) continue;
      const count = (this.counts.get(rule.topic) ?? 0) + 1;
      this.counts.set(rule.topic, count);
      if (count >= this.threshold && !this.suggested.has(rule.topic)) {
        this.suggested.add(rule.topic);
        return { topic: rule.topic, reason: rule.reason, query: rule.query };
      }
    }
    return null;
  }

  /** "Not now" — don't re-suggest this topic. */
  dismiss(topic: string): void {
    this.suggested.add(topic);
  }
}
