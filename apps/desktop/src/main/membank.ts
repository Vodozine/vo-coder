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

/** The map is bounded by design: facts live here, events live in the archive. */
const NODE_TYPES = new Set([
  'file', 'component', 'decision', 'task', 'fact', 'issue', 'preference',
]);
const NODE_STATUS = new Set(['active', 'done', 'superseded', 'dropped']);
const LINK_RELS = new Set([
  'imports', 'depends-on', 'decided-because', 'blocks', 'relates-to', 'supersedes',
]);
const MAX_NODES_PER_PROJECT = 800;
const MAX_OPS_PER_DISTILL = 16;
const DISTILL_MIN_TURNS = 6;
const DISTILL_MAX_CHARS = 24_000;
const NODE_INDEX_MAX_CHARS = 5_000;

export interface MapOp {
  op: 'upsert' | 'link' | 'status';
  type?: string;
  title?: string;
  body?: string;
  tags?: string;
  status?: string;
  from?: { type: string; title: string };
  rel?: string;
  to?: { type: string; title: string };
}

export class MemoryBank {
  private db: DatabaseSync;
  private distilling = new Set<string>();

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

      CREATE TABLE IF NOT EXISTS nodes (
        id INTEGER PRIMARY KEY,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        tags TEXT NOT NULL DEFAULT '',
        src_session TEXT,
        src_turn INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_key ON nodes(project_id, type, lower(title));
      CREATE TABLE IF NOT EXISTS links (
        from_id INTEGER NOT NULL,
        rel TEXT NOT NULL,
        to_id INTEGER NOT NULL,
        PRIMARY KEY (from_id, rel, to_id)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
        title, body, tags, content='nodes', content_rowid='id'
      );
      CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
        INSERT INTO nodes_fts(rowid, title, body, tags)
        VALUES (new.id, new.title, new.body, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
        INSERT INTO nodes_fts(nodes_fts, rowid, title, body, tags)
        VALUES ('delete', old.id, old.title, old.body, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
        INSERT INTO nodes_fts(nodes_fts, rowid, title, body, tags)
        VALUES ('delete', old.id, old.title, old.body, old.tags);
        INSERT INTO nodes_fts(rowid, title, body, tags)
        VALUES (new.id, new.title, new.body, new.tags);
      END;

      CREATE TABLE IF NOT EXISTS distill_state (
        session_id TEXT PRIMARY KEY,
        turn INTEGER NOT NULL
      );
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

  /** Project deletion: archive, map, and distill state go; the epitaph remains. */
  purgeProject(projectId: string): void {
    try {
      this.db
        .prepare(
          `DELETE FROM distill_state WHERE session_id IN
           (SELECT DISTINCT session_id FROM archive WHERE project_id = ?)`,
        )
        .run(projectId);
      this.db
        .prepare(
          `DELETE FROM links WHERE from_id IN (SELECT id FROM nodes WHERE project_id = ?)
           OR to_id IN (SELECT id FROM nodes WHERE project_id = ?)`,
        )
        .run(projectId, projectId);
      this.db.prepare('DELETE FROM nodes WHERE project_id = ?').run(projectId);
      this.db.prepare('DELETE FROM archive WHERE project_id = ?').run(projectId);
    } catch (err) {
      console.error('[membank] purge failed:', err);
    }
  }

  // ---- the map: bounded, structured, superseded-not-duplicated ----

  private nodeId(projectId: string, type: string, title: string): number | undefined {
    const row = this.db
      .prepare('SELECT id FROM nodes WHERE project_id = ? AND type = ? AND lower(title) = lower(?)')
      .get(projectId, type, title) as { id: number } | undefined;
    return row?.id;
  }

  private upsertNode(
    projectId: string,
    type: string,
    title: string,
    patch: { body?: string; tags?: string; status?: string },
    src?: { session: string; turn: number },
  ): number | undefined {
    const existing = this.nodeId(projectId, type, title);
    const now = Date.now();
    if (existing !== undefined) {
      this.db
        .prepare(
          `UPDATE nodes SET
             body = COALESCE(?, body), tags = COALESCE(?, tags),
             status = COALESCE(?, status), updated_at = ? WHERE id = ?`,
        )
        .run(patch.body ?? null, patch.tags ?? null, patch.status ?? null, now, existing);
      return existing;
    }
    const count = this.db
      .prepare('SELECT COUNT(*) AS n FROM nodes WHERE project_id = ?')
      .get(projectId) as { n: number };
    if (count.n >= MAX_NODES_PER_PROJECT) {
      console.warn('[membank] node cap reached for project', projectId);
      return undefined;
    }
    this.db
      .prepare(
        `INSERT INTO nodes (project_id, type, title, body, status, tags, src_session, src_turn, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId, type, title.slice(0, 120), (patch.body ?? '').slice(0, 400),
        patch.status && NODE_STATUS.has(patch.status) ? patch.status : 'active',
        (patch.tags ?? '').slice(0, 120), src?.session ?? null, src?.turn ?? null, now, now,
      );
    return this.nodeId(projectId, type, title);
  }

  /** Apply validated distiller/agent ops. Returns how many were applied. */
  applyOps(projectId: string, ops: MapOp[], src?: { session: string; turn: number }): number {
    let applied = 0;
    for (const op of ops.slice(0, MAX_OPS_PER_DISTILL)) {
      try {
        if (op.op === 'upsert' && op.type && NODE_TYPES.has(op.type) && op.title?.trim()) {
          const patch: { body?: string; tags?: string; status?: string } = {};
          if (typeof op.body === 'string') patch.body = op.body.slice(0, 400);
          if (typeof op.tags === 'string') patch.tags = op.tags.slice(0, 120);
          if (op.status && NODE_STATUS.has(op.status)) patch.status = op.status;
          if (this.upsertNode(projectId, op.type, op.title.trim(), patch, src) !== undefined) {
            applied++;
          }
        } else if (
          op.op === 'link' &&
          op.rel && LINK_RELS.has(op.rel) &&
          op.from?.type && NODE_TYPES.has(op.from.type) && op.from.title?.trim() &&
          op.to?.type && NODE_TYPES.has(op.to.type) && op.to.title?.trim()
        ) {
          const fromId = this.upsertNode(projectId, op.from.type, op.from.title.trim(), {}, src);
          const toId = this.upsertNode(projectId, op.to.type, op.to.title.trim(), {}, src);
          if (fromId !== undefined && toId !== undefined) {
            this.db
              .prepare('INSERT OR IGNORE INTO links (from_id, rel, to_id) VALUES (?, ?, ?)')
              .run(fromId, op.rel, toId);
            applied++;
          }
        } else if (
          op.op === 'status' &&
          op.type && NODE_TYPES.has(op.type) && op.title?.trim() &&
          op.status && NODE_STATUS.has(op.status)
        ) {
          const id = this.nodeId(projectId, op.type, op.title.trim());
          if (id !== undefined) {
            this.db
              .prepare('UPDATE nodes SET status = ?, updated_at = ? WHERE id = ?')
              .run(op.status, Date.now(), id);
            applied++;
          }
        }
      } catch (err) {
        console.error('[membank] op skipped:', err);
      }
    }
    return applied;
  }

  /** Compact map listing the distiller sees for dedup/supersede decisions. */
  private nodeIndex(projectId: string): string {
    const rows = this.db
      .prepare(
        `SELECT type, title, status FROM nodes WHERE project_id = ?
         ORDER BY updated_at DESC LIMIT 200`,
      )
      .all(projectId) as Array<{ type: string; title: string; status: string }>;
    let out = '';
    for (const r of rows) {
      const line = `${r.type}: ${r.title}${r.status !== 'active' ? ` [${r.status}]` : ''}\n`;
      if (out.length + line.length > NODE_INDEX_MAX_CHARS) break;
      out += line;
    }
    return out || '(map is empty)';
  }

  /**
   * Distill new archive turns into map ops. Fire-and-forget from session
   * persist; one in-flight per session; the watermark only advances on
   * success, so failures retry on the next idle.
   */
  async distillPending(
    projectId: string,
    sessionId: string,
    complete: (prompt: string) => Promise<string>,
  ): Promise<void> {
    if (this.distilling.has(sessionId)) return;
    this.distilling.add(sessionId);
    try {
      const mark = (this.db
        .prepare('SELECT turn FROM distill_state WHERE session_id = ?')
        .get(sessionId) as { turn: number } | undefined) ?? { turn: 0 };
      const rows = this.db
        .prepare(
          'SELECT turn, role, content FROM archive WHERE session_id = ? AND turn >= ? ORDER BY turn',
        )
        .all(sessionId, mark.turn) as Array<{ turn: number; role: string; content: string }>;
      if (rows.length < DISTILL_MIN_TURNS) return;

      let transcript = '';
      for (const r of rows) {
        transcript += `${r.role.toUpperCase()}: ${r.content}\n`;
        if (transcript.length > DISTILL_MAX_CHARS) break;
      }
      const prompt =
        'You maintain a structured project memory map. From the NEW conversation turns, extract ' +
        'durable knowledge as JSON ops.\n' +
        `Node types: file, component, decision, task, fact, issue, preference.\n` +
        'Op shapes:\n' +
        '{"op":"upsert","type":"decision","title":"short name","body":"1-2 dense sentences","tags":"a,b","status":"active"}\n' +
        '{"op":"link","from":{"type":"file","title":"deck.js"},"rel":"depends-on","to":{"type":"component","title":"board"}}\n' +
        '{"op":"status","type":"task","title":"short name","status":"done"}\n' +
        `Link rels: ${[...LINK_RELS].join(', ')}. Statuses: ${[...NODE_STATUS].join(', ')}.\n` +
        'Rules: REUSE existing titles for the same thing; prefer a status op over a duplicate; ' +
        'record only durable knowledge (decisions, components, tasks, preferences, issues, key ' +
        `facts) — never chit-chat; at most ${MAX_OPS_PER_DISTILL} ops; {"ops":[]} if nothing durable. ` +
        'Output ONLY the JSON object.\n\n' +
        `EXISTING MAP:\n${this.nodeIndex(projectId)}\n\nNEW TURNS:\n${transcript}`;

      const raw = await complete(prompt);
      const ops = parseOps(raw);
      const lastTurn = rows[rows.length - 1]!.turn;
      this.applyOps(projectId, ops, { session: sessionId, turn: lastTurn });
      this.db
        .prepare(
          `INSERT INTO distill_state (session_id, turn) VALUES (?, ?)
           ON CONFLICT(session_id) DO UPDATE SET turn = excluded.turn`,
        )
        .run(sessionId, lastTurn + 1);
    } catch (err) {
      console.error('[membank] distill failed (will retry next idle):', err);
    } finally {
      this.distilling.delete(sessionId);
    }
  }

  toolSpecs(): ToolSpec[] {
    return [
      {
        name: 'map_query',
        description:
          "Query the project's memory map — the structured index of durable knowledge: files, " +
          'components, decisions, tasks, facts, issues, preferences, with links between them. ' +
          'Without a query, returns a project overview. Snippets reference the archive turns they ' +
          'came from.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search words; omit for an overview' },
            project: { type: 'string', description: "Project name (omit = this chat's project)" },
            type: { type: 'string', description: 'Filter: file|component|decision|task|fact|issue|preference' },
            includeInactive: { type: 'boolean', description: 'Include superseded/dropped nodes' },
          },
        },
      },
      {
        name: 'map_update',
        description:
          "Correct or extend the project's memory map with ops: " +
          '{"op":"upsert","type":"fact","title":"…","body":"…"} · ' +
          '{"op":"link","from":{"type":"file","title":"…"},"rel":"depends-on","to":{…}} · ' +
          '{"op":"status","type":"task","title":"…","status":"done"}. ' +
          'Use when you notice the map is wrong or missing something durable.',
        inputSchema: {
          type: 'object',
          properties: {
            ops: { type: 'array', description: 'Array of op objects (see description)' },
            project: { type: 'string', description: "Project name (omit = this chat's project)" },
          },
          required: ['ops'],
        },
      },
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
            project: { type: 'string', description: "Project name (omit = this chat's project)" },
            allProjects: { type: 'boolean', description: 'Search every project, not just this one' },
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
    projectNames: () => string,
    ctx?: { projectId?: string },
  ): Promise<{ content: string; isError?: boolean }> {
    const a = (args ?? {}) as Record<string, unknown>;
    // Models paraphrase or omit project names — resolve what they gave us,
    // fall back to the session's own project, and make misses self-correcting.
    const projectIdOf = (): { id?: string; err?: string } => {
      if (a.project) {
        const id = resolveProject(String(a.project));
        return id
          ? { id }
          : { err: `No project called "${a.project}". Projects: ${projectNames()}. Omit the project param to use this chat's project.` };
      }
      if (ctx?.projectId) return { id: ctx.projectId };
      return { err: `No project in scope — pass project: one of ${projectNames()}.` };
    };
    try {
      switch (name) {
        case 'map_query': {
          const scope = projectIdOf();
          if (!scope.id) return { content: scope.err!, isError: true };
          const projectId = scope.id;
          const includeInactive = a.includeInactive === true;
          const typeFilter =
            a.type && NODE_TYPES.has(String(a.type)) ? String(a.type) : undefined;
          const query = String(a.query ?? '').trim();

          let rows: Array<{ id: number; type: string; title: string; body: string; status: string; tags: string; src_session: string | null; src_turn: number | null }>;
          if (query) {
            const safe = query
              .split(/\s+/)
              .map((t) => `"${t.replace(/"/g, '')}"`)
              .join(' ');
            rows = this.db
              .prepare(
                `SELECT nodes.* FROM nodes_fts JOIN nodes ON nodes.id = nodes_fts.rowid
                 WHERE nodes_fts MATCH ? AND nodes.project_id = ?
                 ${typeFilter ? 'AND nodes.type = ?' : ''} ORDER BY rank LIMIT 24`,
              )
              .all(...(typeFilter ? [safe, projectId, typeFilter] : [safe, projectId])) as typeof rows;
          } else {
            rows = this.db
              .prepare(
                `SELECT * FROM nodes WHERE project_id = ?
                 ${typeFilter ? 'AND type = ?' : ''} ORDER BY updated_at DESC LIMIT 30`,
              )
              .all(...(typeFilter ? [projectId, typeFilter] : [projectId])) as typeof rows;
          }
          if (!includeInactive) {
            rows = rows.filter((r) => r.status === 'active' || r.status === 'done');
          }
          if (rows.length === 0) {
            return { content: query ? `No map nodes match "${query}".` : 'The map is empty so far — it fills as conversations distill.' };
          }
          const linkStmt = this.db.prepare(
            `SELECT links.rel, n2.type AS ttype, n2.title AS ttitle
             FROM links JOIN nodes n2 ON n2.id = links.to_id WHERE links.from_id = ? LIMIT 6`,
          );
          const lines = rows.map((r) => {
            const links = (linkStmt.all(r.id) as Array<{ rel: string; ttype: string; ttitle: string }>)
              .map((l) => `${l.rel}→${l.ttype}:${l.ttitle}`)
              .join(', ');
            const srcRef = r.src_session ? ` (src: session=${r.src_session} turn=${r.src_turn})` : '';
            return (
              `• ${r.type}: ${r.title}${r.status !== 'active' ? ` [${r.status}]` : ''}` +
              (r.body ? ` — ${r.body}` : '') +
              (r.tags ? ` #${r.tags}` : '') +
              (links ? `\n  links: ${links}` : '') +
              srcRef
            );
          });
          return { content: lines.join('\n') };
        }
        case 'map_update': {
          const scope = projectIdOf();
          if (!scope.id) return { content: scope.err!, isError: true };
          if (!Array.isArray(a.ops)) return { content: 'ops must be an array.', isError: true };
          const applied = this.applyOps(scope.id, a.ops as MapOp[]);
          return { content: `Applied ${applied} of ${(a.ops as unknown[]).length} ops to the map.` };
        }
        case 'archive_search': {
          const query = String(a.query ?? '').trim();
          if (!query) return { content: 'No query given.', isError: true };
          const limit = Math.min(Math.max(Number(a.limit) || 8, 1), SEARCH_MAX);
          let projectFilter = '';
          let projectId: string | undefined;
          if (a.allProjects !== true) {
            const scope = projectIdOf();
            if (a.project && !scope.id) return { content: scope.err!, isError: true };
            projectId = scope.id;
            if (projectId) projectFilter = 'AND archive.project_id = ?';
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

/** Strict parse of the distiller's JSON — throws on garbage so the watermark holds. */
export function parseOps(raw: string): MapOp[] {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('distiller returned no JSON object');
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { ops?: unknown };
  if (!Array.isArray(parsed.ops)) throw new Error('distiller JSON has no ops array');
  return parsed.ops.filter(
    (o): o is MapOp =>
      !!o && typeof o === 'object' && ['upsert', 'link', 'status'].includes((o as MapOp).op),
  );
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
