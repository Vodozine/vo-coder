/**
 * Routing self-heal: a model that keeps failing gets benched so the router
 * tries a different one instead of hammering the same broken pick forever
 * (deprecated model ids, dead endpoints, hard rate limits).
 *
 * Policy: MAX_STRIKES consecutive failed runs → benched for BENCH_MS. Any
 * successful run wipes the record. Strikes are in-memory only — a restart
 * starts clean, and the bench expires on its own so a provider that comes
 * back is picked up again.
 */

export const MAX_STRIKES = 2;
export const BENCH_MS = 30 * 60_000;

interface StrikeEntry {
  count: number;
  lastMessage?: string;
  benchedUntil?: number;
}

export class ModelStrikes {
  private entries = new Map<string, StrikeEntry>();

  constructor(private now: () => number = Date.now) {}

  private key(provider: string, model: string): string {
    return `${provider}:${model}`.toLowerCase();
  }

  /** Record a failed run. Returns true when this failure benched the model. */
  fail(provider: string, model: string, message?: string): boolean {
    const key = this.key(provider, model);
    const entry = this.entries.get(key) ?? { count: 0 };
    entry.count += 1;
    if (message) entry.lastMessage = message;
    if (entry.count >= MAX_STRIKES) entry.benchedUntil = this.now() + BENCH_MS;
    this.entries.set(key, entry);
    return entry.count === MAX_STRIKES;
  }

  /** A clean run clears the slate for that model. */
  ok(provider: string, model: string): void {
    this.entries.delete(this.key(provider, model));
  }

  /** Is this model currently benched? Expired benches self-clear. */
  benched(provider: string, model: string): boolean {
    const key = this.key(provider, model);
    const entry = this.entries.get(key);
    if (!entry?.benchedUntil) return false;
    if (entry.benchedUntil <= this.now()) {
      // Bench served — forget the strikes entirely so it gets a fresh 2 tries.
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  /** Model ids currently benched (for "avoiding …" routing notes). */
  benchedModels(): string[] {
    const out: string[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.benchedUntil && entry.benchedUntil > this.now()) {
        out.push(key.slice(key.indexOf(':') + 1));
      }
    }
    return out;
  }
}
