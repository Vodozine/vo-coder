import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ToolSpec } from '@vo-coder/providers';

/**
 * Vodo's cross-everything memory: an append-only activity journal covering all
 * chats in all projects, missions, Telegram, and tool activity. The
 * memory_recall tool searches it by time range + keyword, which is what powers
 * "what was I doing last Monday at 10pm?" from any surface. memory_note lets
 * Vodo (or the user, through Vodo) pin durable facts into the same timeline.
 */

export type JournalKind = 'chat' | 'tool' | 'mission' | 'project' | 'note';

export interface JournalEntry {
  at: number;
  kind: JournalKind;
  text: string;
  project?: string;
  surface?: 'app' | 'telegram' | 'mission';
}

const MAX_FILE_BYTES = 6 * 1024 * 1024;
const KEEP_BYTES = 4 * 1024 * 1024;
const MAX_RESULTS = 60;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function fmtStamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${WEEKDAYS[d.getDay()]} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "-3d" / "-12h" / "-45m" / "-2w" ago, or any ISO-8601/parsable date string. */
function parseWhen(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const rel = /^-?(\d+(?:\.\d+)?)([mhdw])$/.exec(raw.trim());
  if (rel) {
    const n = Number(rel[1]);
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[rel[2] as 'm'];
    return Date.now() - n * (unit ?? 60_000);
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export class Journal {
  constructor(private file: string) {}

  append(entry: Omit<JournalEntry, 'at'>): void {
    try {
      const text = entry.text.replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!text) return;
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify({ at: Date.now(), ...entry, text })}\n`, 'utf8');
      this.rotateIfNeeded();
    } catch (err) {
      console.error('[journal] append failed:', err);
    }
  }

  query(opts: { from?: string; to?: string; keyword?: string; limit?: number }): string {
    const now = Date.now();
    const from = parseWhen(opts.from, now - 48 * 3_600_000);
    const to = parseWhen(opts.to, now);
    const keyword = opts.keyword?.trim().toLowerCase();
    const limit = Math.min(Math.max(opts.limit ?? 40, 1), MAX_RESULTS);

    const entries = this.read().filter((e) => {
      if (e.at < from || e.at > to) return false;
      if (!keyword) return true;
      return (
        e.text.toLowerCase().includes(keyword) ||
        (e.project?.toLowerCase().includes(keyword) ?? false)
      );
    });

    const window = `${fmtStamp(from)} → ${fmtStamp(to)}`;
    if (entries.length === 0) {
      return `Now: ${fmtStamp(now)}\nNo journal entries in ${window}${keyword ? ` matching "${opts.keyword}"` : ''}. (The journal only records activity since this feature was installed.)`;
    }
    const shown = entries.slice(-limit);
    const lines = shown.map((e) => {
      const where = e.project ? ` (${e.project})` : '';
      const via = e.surface && e.surface !== 'app' ? ` [${e.surface}]` : '';
      return `[${fmtStamp(e.at)}]${where}${via} ${e.kind}: ${e.text}`;
    });
    const skipped = entries.length - shown.length;
    return (
      `Now: ${fmtStamp(now)}\n${entries.length} entries in ${window}${keyword ? ` matching "${opts.keyword}"` : ''}${skipped > 0 ? ` (showing last ${shown.length})` : ''}:\n` +
      lines.join('\n')
    );
  }

  toolSpecs(): ToolSpec[] {
    return [
      {
        name: 'memory_recall',
        description:
          'Search the cross-everything activity journal: every chat (all projects), mission run, ' +
          'Telegram message, file write, and command — timestamped. Use for questions like "what ' +
          'was I doing last Monday at 10pm?" or "which project was I on 4 days ago?". Times: ISO ' +
          'dates ("2026-07-20" or "2026-07-20T22:00") or relative-ago shorthand ("-4d", "-12h", ' +
          '"-2w"). Default window: last 48h. Every result starts with the current date-time.',
        inputSchema: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Range start (ISO or "-4d" style); default -48h' },
            to: { type: 'string', description: 'Range end (ISO or relative); default now' },
            keyword: { type: 'string', description: 'Filter by substring (text or project name)' },
            limit: { type: 'number', description: `Max entries (default 40, cap ${MAX_RESULTS})` },
          },
        },
      },
      {
        name: 'memory_note',
        description:
          'Save a durable fact to the shared journal so any future chat, agent, or mission can ' +
          'recall it (e.g. "user prefers Rust for CLI tools", "Proxmox node name is pve1").',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string', description: 'The fact to remember' } },
          required: ['text'],
        },
      },
    ];
  }

  async executeTool(name: string, args: unknown): Promise<{ content: string; isError?: boolean }> {
    const a = (args ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case 'memory_recall':
          return {
            content: this.query({
              from: a.from ? String(a.from) : undefined,
              to: a.to ? String(a.to) : undefined,
              keyword: a.keyword ? String(a.keyword) : undefined,
              limit: a.limit ? Number(a.limit) : undefined,
            }),
          };
        case 'memory_note': {
          const text = String(a.text ?? '').trim();
          if (!text) return { content: 'Nothing to remember.', isError: true };
          this.append({ kind: 'note', text });
          return { content: `Noted: ${text}` };
        }
        default:
          return { content: `Unknown memory tool "${name}".`, isError: true };
      }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  }

  private read(): JournalEntry[] {
    try {
      if (!existsSync(this.file)) return [];
      const out: JournalEntry[] = [];
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as JournalEntry);
        } catch {
          /* torn line from rotation */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private rotateIfNeeded(): void {
    try {
      if (statSync(this.file).size <= MAX_FILE_BYTES) return;
      const raw = readFileSync(this.file, 'utf8');
      const tail = raw.slice(-KEEP_BYTES);
      writeFileSync(this.file, tail.slice(tail.indexOf('\n') + 1), 'utf8');
    } catch {
      /* rotation is best-effort */
    }
  }
}
