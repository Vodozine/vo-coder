import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Models a provider LISTS but permanently refuses to SERVE (NVIDIA's free
 * endpoint 404s "Function not found" for pulled models like nemotron-4-340b
 * while /v1/models still advertises them). One 404 marks the model dead and
 * it disappears from the pickers; a later successful run revives it. This is
 * separate from ModelStrikes — strikes are transient (30-min bench), dead is
 * "the endpoint says this model does not exist," which never heals on a timer.
 */
export class DeadModels {
  private data: Record<string, string[]> = {};

  constructor(private path: string) {
    try {
      this.data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string[]>;
    } catch {
      /* first run */
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.path, JSON.stringify(this.data, null, 2), 'utf8');
    } catch {
      /* best-effort */
    }
  }

  isDead(provider: string, model: string): boolean {
    return (this.data[provider] ?? []).includes(model);
  }

  markDead(provider: string, model: string): void {
    const list = this.data[provider] ?? [];
    if (list.includes(model)) return;
    this.data[provider] = [...list, model];
    this.persist();
  }

  /** The model answered after all — take it off the dead list. */
  revive(provider: string, model: string): void {
    const list = this.data[provider];
    if (!list?.includes(model)) return;
    this.data[provider] = list.filter((m) => m !== model);
    this.persist();
  }

  filter<T extends { id: string }>(provider: string, models: T[]): T[] {
    const dead = this.data[provider];
    if (!dead?.length) return models;
    return models.filter((m) => !dead.includes(m.id));
  }
}
