import { DatabaseSync } from 'node:sqlite';
import type { HarnessMessage, ToolSpec } from '@vo-coder/providers';
import { fmtStamp } from './journal';

/**
 * The memory bank (1.1, step 1): a lossless, per-project archive of every
 * conversation turn in one SQLite file with FTS5 search. Nothing here is ever
 * summarized or replaced — this is the ground-truth layer the future index/map
 * sits on top of (see docs/memory-bank.md). Deleting a project purges its
 * rows; the journal keeps the epitaph.
 *
 * Uses node:sqlite (bundled with Electron's Node) — zero native deps, no
 * rebuild, aligned with the no-native-modules policy.
 */

const SNIPPET_MAX = 240;
const READ_MAX_TURNS = 24;
const SEARCH_MAX = 20;

export class MemoryBank {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS archive (
        id INTEGER PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_pos ON archive(session_id, turn);
      CREATE INDEX IF NOT EXISTS idx_archive_proj ON archive(project_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS archive_fts USING fts5(
        content, content='archive', content_rowid='id'
      );
      CREATE TRIGGER IF NOT EXISTS archive_ai AFTER INSERT ON archive BEGIN
        INSERT INTO archive_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS archive_ad AFTER DELETE ON archive BEGIN
        INSERT INTO archive_fts(archive_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
      END;
    `);
  }

  /** Append any turns of `history` the archive hasn't seen yet. */
  syncSession(projectId: string, sessionId: string, history: HarnessMessage[]): void {
    try {
      const row = this.db
        .prepare('SELECT COALESCE(MAX(turn) + 1, 0) AS next FROM archive WHERE session_id = ?')
        .get(sessionId) as { next: number };
      if (history.length <= row.next) return;
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO archive (project_id, session_id, turn, role, content, at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      const now = Date.now();
      for (let turn = row.next; turn < history.length; turn++) {
        const content = flatten(history[turn]!);
        if (content) insert.run(projectId, sessionId, turn, history[turn]!.role, content, now);
      }
    } catch (err) {
      console.error('[membank] sync failed:', err);
    }
  }

  /** Project deletion: the archive rows go; the journal epitaph remains. */
  purgeProject(projectId: string): void {
    try {
      this.db.prepare('DELETE FROM archive WHERE project_id = ?').run(projectId);
    } catch (err) {
      console.error('[membank] purge failed:', err);
    }
  }

  toolSpecs(): ToolSpec[] {
    return [
      {
        name: 'archive_search',
        description:
          'Full-text search the lossless conversation archive (every chat, verbatim, forever). ' +
          'Returns matching snippets with (session, turn) refs — use archive_read to pull the ' +
          'exact surrounding turns. Use when the journal summary is not enough and you need what ' +
          'was actually said.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'FTS query — words or "quoted phrases"' },
            project: { type: 'string', description: 'Limit to a project name (recommended)' },
            limit: { type: 'number', description: `Max results (default 8, cap ${SEARCH_MAX})` },
          },
          required: ['query'],
        },
      },
      {
        name: 'archive_read',
        description:
          'Read verbatim turns from the archive around a (session, turn) ref returned by ' +
          'archive_search.',
        inputSchema: {
          type: 'object',
          properties: {
            session: { type: 'string', description: 'Session id from a search result' },
            turn: { type: 'number', description: 'Center turn number' },
            radius: { type: 'number', description: `Turns of context each side (default 3, cap ${READ_MAX_TURNS / 2})` },
          },
          required: ['session', 'turn'],
        },
      },
    ];
  }

  async executeTool(
    name: string,
    args: unknown,
    resolveProject: (name: string) => string | undefined,
  ): Promise<{ content: string; isError?: boolean }> {
    const a = (args ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case 'archive_search': {
          const query = String(a.query ?? '').trim();
          if (!query) return { content: 'No query given.', isError: true };
          const limit = Math.min(Math.max(Number(a.limit) || 8, 1), SEARCH_MAX);
          let projectFilter = '';
          let projectId: string | undefined;
          if (a.project) {
            projectId = resolveProject(String(a.project));
            if (!projectId) return { content: `No project called "${a.project}".`, isError: true };
            projectFilter = 'AND archive.project_id = ?';
          }
          // FTS5 chokes on stray operators — quote each term defensively.
          const safe = query
            .split(/\s+/)
            .map((t) => `"${t.replace(/"/g, '')}"`)
            .join(' ');
          const rows = this.db
            .prepare(
              `SELECT archive.session_id AS s, archive.turn AS t, archive.role AS r,
                      archive.at AS at, snippet(archive_fts, 0, '[', ']', '…', 16) AS snip
               FROM archive_fts JOIN archive ON archive.id = archive_fts.rowid
               WHERE archive_fts MATCH ? ${projectFilter}
               ORDER BY rank LIMIT ?`,
            )
            .all(...(projectId ? [safe, projectId, limit] : [safe, limit])) as Array<{
            s: string;
            t: number;
            r: string;
            at: number;
            snip: string;
          }>;
          if (rows.length === 0) {
            return {
              content: `No archive matches for "${query}". (The archive records conversations from when the memory bank was installed onward.)`,
            };
          }
          return {
            content: rows
              .map(
                (row) =>
                  `[${fmtStamp(row.at)}] session=${row.s} turn=${row.t} (${row.r}): ${row.snip.slice(0, SNIPPET_MAX)}`,
              )
              .join('\n'),
          };
        }
        case 'archive_read': {
          const sessionId = String(a.session ?? '');
          const center = Number(a.turn);
          if (!sessionId || Number.isNaN(center)) {
            return { content: 'archive_read needs session and turn.', isError: true };
          }
          const radius = Math.min(Math.max(Number(a.radius) || 3, 0), READ_MAX_TURNS / 2);
          const rows = this.db
            .prepare(
              `SELECT turn, role, content, at FROM archive
               WHERE session_id = ? AND turn BETWEEN ? AND ?
               ORDER BY turn`,
            )
            .all(sessionId, center - radius, center + radius) as Array<{
            turn: number;
            role: string;
            content: string;
            at: number;
          }>;
          if (rows.length === 0) return { content: 'Nothing at that ref.', isError: true };
          return {
            content: rows
              .map((r) => `--- turn ${r.turn} · ${r.role} · ${fmtStamp(r.at)} ---\n${r.content}`)
              .join('\n'),
          };
        }
        default:
          return { content: `Unknown archive tool "${name}".`, isError: true };
      }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  }
}

/** Flatten one harness message into searchable text. */
function flatten(msg: HarnessMessage): string {
  if (msg.role === 'user') {
    return msg.content
      .map((p) => (p.type === 'text' ? p.text : `[${p.type}]`))
      .join(' ')
      .trim();
  }
  if (msg.role === 'assistant') {
    return msg.content
      .map((p) => {
        if (p.type === 'text') return p.text;
        if (p.type === 'tool_call') return `[ran ${p.name}]`;
        return '';
      })
      .join(' ')
      .trim();
  }
  return msg.content.trim();
}
