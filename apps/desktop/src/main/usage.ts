import { readFileSync, writeFileSync } from 'node:fs';
import { IPC, type UsageData, type UsageTotals } from '../shared/ipc-contract';

const zero = (): UsageTotals => ({ inputTokens: 0, outputTokens: 0, cost: 0 });

/**
 * Token/cost accounting — the harness's whole thesis made visible. Totals are
 * kept per project (across all its chats) plus an all-time grand total that
 * survives project deletion. Persisted under userData.
 */
export class UsageTracker {
  private cache: UsageData | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private path: string,
    private send: (channel: string, payload: unknown) => void,
  ) {}

  get(): UsageData {
    if (!this.cache) {
      try {
        const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<UsageData>;
        this.cache = {
          allTime: { ...zero(), ...raw.allTime },
          perProject: raw.perProject ?? {},
        };
      } catch {
        this.cache = { allTime: zero(), perProject: {} };
      }
    }
    return this.cache;
  }

  record(projectId: string, inputTokens: number, outputTokens: number, cost: number): void {
    const data = this.get();
    const add = (t: UsageTotals) => {
      t.inputTokens += inputTokens;
      t.outputTokens += outputTokens;
      t.cost += cost;
    };
    add(data.allTime);
    add((data.perProject[projectId] ??= zero()));
    this.send(IPC.usageChanged, data);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 800);
  }

  /**
   * Write immediately. The 800ms debounce means a quit right after an expensive
   * run would otherwise lose that turn's tokens and cost — the all-time grand
   * total is supposed to survive everything, so the shutdown path calls this.
   */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.cache) return;
    try {
      writeFileSync(this.path, JSON.stringify(this.cache), 'utf8');
    } catch {
      /* best effort */
    }
  }
}
