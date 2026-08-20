import { DatabaseSync } from 'node:sqlite';
import type { HarnessMessage, ToolSpec } from '@vo-coder/providers';
import type { LifeBatchDto, LifeNoteDto, MapNodeDto, MemGraphDto } from '../shared/ipc-contract';
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

/**
 * Life notes: USER-level memory distilled from imported chat archives
 * (ChatGPT/Claude/Gemini exports). Project-less by design — they describe the
 * person, not a codebase — and every note carries the source dump it came
 * from, because the conversations it refers to never happened in this app and
 * the model must be able to say so.
 */
const LIFE_KINDS = new Set(['identity', 'preference', 'project', 'skill', 'fact', 'era']);
const LIFE_STATUS = new Set(['active', 'superseded']);
const MAX_LIVE_LIFE_NOTES = 500;
const LIFE_INDEX_MAX_CHARS = 3_000;

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

/** An op against the imported life memory (no links — it is a flat shelf). */
export interface LifeOp {
  op: 'upsert' | 'status';
  kind?: string;
  title?: string;
  body?: string;
  period?: string;
  tags?: string;
  status?: string;
}

export class MemoryBank {
  private db: DatabaseSync;
  private distilling = new Set<string>();
  /** Bumped on every node write; keys the digest cache below. */
  private mapVersion = new Map<string, number>();
  /** Last rendered digest per (project|maxChars|query), valid while version holds. */
  private digestCache = new Map<string, { v: number; note: string }>();
  /** Same memoization for the life digest — it rides every send too. */
  private lifeVersion = 0;
  private lifeDigestCache: { v: number; note: string } | null = null;

  /** A node changed — invalidate this project's cached digests. */
  private touchMap(projectId: string): void {
    this.mapVersion.set(projectId, (this.mapVersion.get(projectId) ?? 0) + 1);
  }

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

      -- Archive position per session, independent of the live history's
      -- length. See syncSession: history shrinks, the record must not.
      CREATE TABLE IF NOT EXISTS sync_state (
        session_id TEXT PRIMARY KEY,
        synced INTEGER NOT NULL,
        last_len INTEGER NOT NULL
      );

      -- Imported life memory: user-level notes distilled from exported chat
      -- archives. The conversations they refer to are NOT in the archive
      -- table above — they happened in another assistant's world — and the
      -- source column is what lets the model know that.
      CREATE TABLE IF NOT EXISTS life_notes (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        period TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        source TEXT NOT NULL,
        batch_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_life_key ON life_notes(kind, lower(title));
      CREATE VIRTUAL TABLE IF NOT EXISTS life_fts USING fts5(
        title, body, tags, content='life_notes', content_rowid='id'
      );
      CREATE TRIGGER IF NOT EXISTS life_ai AFTER INSERT ON life_notes BEGIN
        INSERT INTO life_fts(rowid, title, body, tags)
        VALUES (new.id, new.title, new.body, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS life_ad AFTER DELETE ON life_notes BEGIN
        INSERT INTO life_fts(life_fts, rowid, title, body, tags)
        VALUES ('delete', old.id, old.title, old.body, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS life_au AFTER UPDATE ON life_notes BEGIN
        INSERT INTO life_fts(life_fts, rowid, title, body, tags)
        VALUES ('delete', old.id, old.title, old.body, old.tags);
        INSERT INTO life_fts(rowid, title, body, tags)
        VALUES (new.id, new.title, new.body, new.tags);
      END;

      -- One row per import run; canceled/errored runs keep their cursor so
      -- they resume instead of re-reading (and re-paying) the whole dump.
      CREATE TABLE IF NOT EXISTS life_batches (
        id INTEGER PRIMARY KEY,
        source TEXT NOT NULL,
        file TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        depth TEXT NOT NULL DEFAULT 'deep',
        chats_total INTEGER NOT NULL DEFAULT 0,
        cursor INTEGER NOT NULL DEFAULT 0,
        notes INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'running',
        summary TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      );
    `);
    // An app killed mid-import leaves 'running' rows nothing owns — make them
    // resumable instead of forever-stuck.
    try {
      this.db
        .prepare("UPDATE life_batches SET status = 'canceled' WHERE status = 'running'")
        .run();
    } catch {
      // fresh DB — nothing to sweep
    }
  }

  /**
   * Append any turns of `history` the archive hasn't seen yet.
   *
   * The cursor is MONOTONIC and stored per session, deliberately decoupled
   * from `history.length`. History shrinks — compaction and reset replace it
   * outright — and a length-based watermark then reads as "already archived",
   * so every later turn is skipped and the archive goes silent for the rest of
   * the session. Turn numbers keep climbing instead, so a shrunk history
   * simply continues past the old high-water mark and nothing collides.
   */
  syncSession(projectId: string, sessionId: string, history: HarnessMessage[]): void {
    try {
      const state = this.db
        .prepare('SELECT synced, last_len FROM sync_state WHERE session_id = ?')
        .get(sessionId) as { synced: number; last_len: number } | undefined;
      // Pre-cursor sessions: adopt the old length-derived position once.
      const legacy = this.db
        .prepare('SELECT COALESCE(MAX(turn) + 1, 0) AS next FROM archive WHERE session_id = ?')
        .get(sessionId) as { next: number };
      let cursor = state?.synced ?? legacy.next;
      const lastLen = state?.last_len ?? legacy.next;
      // History got shorter (or was replaced): everything in it is new to us
      // from here on, but the cursor must never move backwards.
      const from = history.length < lastLen ? 0 : Math.min(lastLen, history.length);

      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO archive (project_id, session_id, turn, role, content, at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      const now = Date.now();
      for (let i = from; i < history.length; i++) {
        const content = flatten(history[i]!);
        if (content) insert.run(projectId, sessionId, cursor, history[i]!.role, content, now);
        cursor++;
      }
      this.db
        .prepare(
          `INSERT INTO sync_state (session_id, synced, last_len) VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET synced = excluded.synced, last_len = excluded.last_len`,
        )
        .run(sessionId, cursor, history.length);
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

  /**
   * A chat moved to another project (folder binding realigned it): its whole
   * archive follows, and so do the map nodes it authored — a task distilled
   * from "build the new app" must not keep haunting the OLD project's
   * briefings. The sync/distill watermarks are session-keyed, so they carry
   * over untouched: no re-copy, no duplication, later turns land in the new
   * project. OR IGNORE on nodes: a same-titled node already in the target
   * wins, and the loser stays behind rather than violating the
   * (project, type, title) identity.
   */
  moveSession(sessionId: string, toProjectId: string): void {
    try {
      this.db
        .prepare('UPDATE archive SET project_id = ? WHERE session_id = ?')
        .run(toProjectId, sessionId);
      this.db
        .prepare('UPDATE OR IGNORE nodes SET project_id = ? WHERE src_session = ?')
        .run(toProjectId, sessionId);
    } catch (err) {
      console.error('[membank] session move failed:', err);
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
    // The cap governs LIVE knowledge — what can still reach a digest. Retired
    // rows keep their place in the map and the archive; they just stop
    // competing. Refusing new facts because the project learned 800 things
    // first is the wrong way round.
    const live = this.db
      .prepare("SELECT COUNT(*) AS n FROM nodes WHERE project_id = ? AND status IN ('active','done')")
      .get(projectId) as { n: number };
    if (live.n >= MAX_NODES_PER_PROJECT) {
      const retired = this.db
        .prepare(
          `UPDATE nodes SET status = 'superseded', updated_at = ?
             WHERE id IN (
               SELECT id FROM nodes WHERE project_id = ? AND status IN ('active','done')
               ORDER BY updated_at ASC LIMIT ?
             )`,
        )
        .run(now, projectId, Math.ceil(MAX_NODES_PER_PROJECT * 0.1));
      if (!retired.changes) {
        console.warn('[membank] node cap reached and nothing left to retire', projectId);
        return undefined;
      }
      this.pruneRetired(projectId);
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

  /**
   * Keep retired rows from growing without end. They stay long past the point
   * of usefulness on purpose — a superseded decision explains a later one —
   * but not forever. The verbatim record they came from lives in the archive
   * regardless, so this loses a signpost, never the ground truth.
   */
  private pruneRetired(projectId: string): void {
    const KEEP_RETIRED = MAX_NODES_PER_PROJECT * 2;
    const doomed = this.db
      .prepare(
        `SELECT id FROM nodes WHERE project_id = ? AND status IN ('superseded','dropped')
           ORDER BY updated_at DESC LIMIT -1 OFFSET ?`,
      )
      .all(projectId, KEEP_RETIRED) as Array<{ id: number }>;
    for (const { id } of doomed) {
      this.db.prepare('DELETE FROM links WHERE from_id = ? OR to_id = ?').run(id, id);
      this.db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
    }
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
    if (applied > 0) this.touchMap(projectId);
    return applied;
  }

  /**
   * The digest: a bounded briefing rendered from the map, appended to the
   * system prompt when window-as-buffer assembly is on. This is what makes
   * dropping old turns safe — the durable knowledge rides along every turn.
   */
  /**
   * The digest rides every send, but it only changes when the MAP changes — so
   * serve it from a version-keyed cache instead of re-running ~50 synchronous
   * SQLite queries per send (multiplied across every member of a group). The
   * version bumps on any node write; a query-ranked digest keys on the query
   * too. Rendering is unchanged — this is a pure memoization in front of it.
   */
  digest(projectId: string, maxChars = 5_500, query?: string): string {
    const version = this.mapVersion.get(projectId) ?? 0;
    const key = `${projectId}|${maxChars}|${query ?? ''}`;
    const hit = this.digestCache.get(key);
    if (hit && hit.v === version) return hit.note;
    const note = this.renderDigest(projectId, maxChars, query);
    this.digestCache.set(key, { v: version, note });
    return note;
  }

  private renderDigest(projectId: string, maxChars = 5_500, query?: string): string {
    try {
      type Row = { id: number; type: string; title: string; body: string; status: string; tags: string };
      // Active tasks come FIRST and unconditionally: they are what the model
      // is in the middle of. A plan must never lose its place to a keyword
      // match, and losing it mid-scaffold is exactly how a model gets
      // confused when the window moves under it.
      // 12, not 6: an eight-member group writes a block-status node each, and
      // with six slots the team could not all see each other — mutual
      // awareness is the whole reason the digest leads with active tasks.
      // The maxChars budget still bounds the rendered size.
      const working = this.db
        .prepare(
          `SELECT id, type, title, body, status, tags FROM nodes
           WHERE project_id = ? AND type = 'task' AND status = 'active'
           ORDER BY updated_at DESC LIMIT 12`,
        )
        .all(projectId) as Row[];

      // Then the rest, ranked against the CURRENT message where there is one.
      // Recency alone answers "what happened lately", not "what matters to
      // what was just asked" — and the whole point of a small window is that
      // what it carries has to be the relevant part.
      let ranked: Row[] = [];
      const terms = (query ?? '')
        .toLowerCase()
        .split(/[^a-z0-9_.-]+/i)
        .filter((t) => t.length > 2)
        .slice(0, 12);
      if (terms.length) {
        try {
          ranked = this.db
            .prepare(
              `SELECT nodes.id, nodes.type, nodes.title, nodes.body, nodes.status, nodes.tags
                 FROM nodes_fts JOIN nodes ON nodes.id = nodes_fts.rowid
                WHERE nodes_fts MATCH ? AND nodes.project_id = ?
                  AND nodes.status IN ('active','done')
                ORDER BY rank LIMIT 40`,
            )
            .all(terms.map((t) => `"${t}"`).join(' OR '), projectId) as Row[];
        } catch {
          ranked = []; // malformed FTS query — fall through to recency
        }
      }
      const recent = this.db
        .prepare(
          `SELECT id, type, title, body, status, tags FROM nodes
           WHERE project_id = ? AND status IN ('active', 'done')
           ORDER BY updated_at DESC LIMIT 40`,
        )
        .all(projectId) as Row[];
      // Relevance first, recency to fill — a fresh fact the query did not
      // mention is still worth carrying if there is room.
      const rows: Row[] = [];
      const taken = new Set<number>();
      for (const r of [...working, ...ranked, ...recent]) {
        if (taken.has(r.id)) continue;
        taken.add(r.id);
        rows.push(r);
      }
      if (rows.length === 0) return '';
      const linkStmt = this.db.prepare(
        `SELECT links.rel, n2.title AS t FROM links
         JOIN nodes n2 ON n2.id = links.to_id WHERE links.from_id = ? LIMIT 4`,
      );
      let out = '';
      for (const r of rows) {
        const links = (linkStmt.all(r.id) as Array<{ rel: string; t: string }>)
          .map((l) => `${l.rel}→${l.t}`)
          .join(', ');
        const line =
          `• ${r.type}: ${r.title}${r.status === 'done' ? ' [done]' : ''}` +
          (r.body ? ` — ${r.body}` : '') +
          (links ? ` (${links})` : '') +
          '\n';
        if (out.length + line.length > maxChars) break;
        out += line;
      }
      return out.trim();
    } catch {
      return '';
    }
  }

  /** Structured node listing for the Memory view. */
  listNodes(
    projectId: string,
    opts: { query?: string; type?: string; includeInactive?: boolean } = {},
  ): MapNodeDto[] {
    const typeFilter = opts.type && NODE_TYPES.has(opts.type) ? opts.type : undefined;
    let rows: Array<{ id: number; type: string; title: string; body: string; status: string; tags: string; src_session: string | null; src_turn: number | null; updated_at: number }>;
    const byRecency = (): typeof rows =>
      this.db
        .prepare(
          `SELECT * FROM nodes WHERE project_id = ?
           ${typeFilter ? 'AND type = ?' : ''} ORDER BY updated_at DESC LIMIT 200`,
        )
        .all(...(typeFilter ? [projectId, typeFilter] : [projectId])) as typeof rows;
    if (opts.query?.trim()) {
      const safe = opts.query
        .trim()
        .split(/\s+/)
        .map((t) => `"${t.replace(/"/g, '')}"`)
        .join(' ');
      try {
        rows = this.db
          .prepare(
            `SELECT nodes.* FROM nodes_fts JOIN nodes ON nodes.id = nodes_fts.rowid
             WHERE nodes_fts MATCH ? AND nodes.project_id = ?
             ${typeFilter ? 'AND nodes.type = ?' : ''} ORDER BY rank LIMIT 100`,
          )
          .all(...(typeFilter ? [safe, projectId, typeFilter] : [safe, projectId])) as typeof rows;
      } catch {
        // A term of only tokenizer-discarded characters collapses to an empty
        // phrase — an fts5 syntax error. digest() guards the same way; the
        // Memory-view path did not, so the node list threw instead of showing
        // "no matches". Fall back to recency.
        rows = byRecency();
      }
    } else {
      rows = byRecency();
    }
    if (!opts.includeInactive) {
      rows = rows.filter((r) => r.status === 'active' || r.status === 'done');
    }
    const linkStmt = this.db.prepare(
      `SELECT links.rel, n2.type AS ttype, n2.title AS ttitle
       FROM links JOIN nodes n2 ON n2.id = links.to_id WHERE links.from_id = ? LIMIT 8`,
    );
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      body: r.body,
      status: r.status,
      tags: r.tags,
      updatedAt: r.updated_at,
      srcSession: r.src_session ?? undefined,
      srcTurn: r.src_turn ?? undefined,
      links: (linkStmt.all(r.id) as Array<{ rel: string; ttype: string; ttitle: string }>).map(
        (l) => ({ rel: l.rel, type: l.ttype, title: l.ttitle }),
      ),
    }));
  }

  setNodeStatus(projectId: string, nodeId: number, status: string): boolean {
    if (!NODE_STATUS.has(status)) return false;
    this.db
      .prepare('UPDATE nodes SET status = ?, updated_at = ? WHERE id = ? AND project_id = ?')
      .run(status, Date.now(), nodeId, projectId);
    this.touchMap(projectId);
    return true;
  }

  deleteNode(projectId: string, nodeId: number): void {
    this.db.prepare('DELETE FROM links WHERE from_id = ? OR to_id = ?').run(nodeId, nodeId);
    this.db.prepare('DELETE FROM nodes WHERE id = ? AND project_id = ?').run(nodeId, projectId);
    this.touchMap(projectId);
  }

  stats(projectId: string): { nodes: number; archiveTurns: number } {
    const nodes = this.db
      .prepare('SELECT COUNT(*) AS n FROM nodes WHERE project_id = ?')
      .get(projectId) as { n: number };
    const turns = this.db
      .prepare('SELECT COUNT(*) AS n FROM archive WHERE project_id = ?')
      .get(projectId) as { n: number };
    return { nodes: nodes.n, archiveTurns: turns.n };
  }

  /**
   * The whole project as a node/edge graph for the Memory graph view. Unlike
   * listNodes (digest-shaped: outgoing-only, capped at 8, no target id), this
   * returns every node and every link with BOTH endpoint ids so the renderer
   * can lay out the real graph. Edges are joined to nodes on both ends, so a
   * link into a filtered-out (retired) node is dropped rather than dangling.
   */
  graph(projectId: string, opts: { includeInactive?: boolean } = {}): MemGraphDto {
    const live = "status IN ('active', 'done')";
    const nodeWhere = opts.includeInactive ? '' : ` AND ${live}`;
    const nodes = this.db
      .prepare(
        `SELECT id, type, title, body, status, tags, updated_at
         FROM nodes WHERE project_id = ?${nodeWhere}`,
      )
      .all(projectId) as Array<{
      id: number;
      type: string;
      title: string;
      body: string;
      status: string;
      tags: string;
      updated_at: number;
    }>;
    const edgeWhere = opts.includeInactive
      ? ''
      : ` AND n1.${live} AND n2.${live}`;
    const edgeRows = this.db
      .prepare(
        `SELECT l.from_id AS f, l.rel AS rel, l.to_id AS t
         FROM links l
         JOIN nodes n1 ON n1.id = l.from_id
         JOIN nodes n2 ON n2.id = l.to_id
         WHERE n1.project_id = ? AND n2.project_id = ?${edgeWhere}`,
      )
      .all(projectId, projectId) as Array<{ f: number; rel: string; t: number }>;
    return {
      nodes: nodes.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        body: r.body,
        status: r.status,
        tags: r.tags,
        updatedAt: r.updated_at,
      })),
      edges: edgeRows.map((e) => ({ from: e.f, rel: e.rel, to: e.t })),
    };
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
      // The minimum exists so a couple of lines don't cost a model call. It
      // must not strand a BACKLOG though: turns left behind by the char budget
      // below, or a long run that ended, would otherwise wait forever for six
      // more turns that never come.
      const pendingChars = rows.reduce((n, r) => n + r.content.length, 0);
      if (rows.length < DISTILL_MIN_TURNS && pendingChars < DISTILL_MAX_CHARS / 2) return;

      // Track what the model is actually SHOWN. The watermark may only advance
      // over these turns: advancing to the last row would silently skip
      // everything past the char cut, and those turns are never revisited.
      let transcript = '';
      let readThrough = rows[0]!.turn - 1;
      for (const r of rows) {
        const line = `${r.role.toUpperCase()}: ${r.content}\n`;
        if (transcript.length + line.length > DISTILL_MAX_CHARS) break;
        transcript += line;
        readThrough = r.turn;
      }
      // A single turn larger than the whole budget would otherwise wedge the
      // distiller forever — take it truncated and move on.
      if (!transcript) {
        transcript = `${rows[0]!.role.toUpperCase()}: ${rows[0]!.content.slice(0, DISTILL_MAX_CHARS)}\n`;
        readThrough = rows[0]!.turn;
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
      this.applyOps(projectId, ops, { session: sessionId, turn: readThrough });
      this.db
        .prepare(
          `INSERT INTO distill_state (session_id, turn) VALUES (?, ?)
           ON CONFLICT(session_id) DO UPDATE SET turn = excluded.turn`,
        )
        .run(sessionId, readThrough + 1);
    } catch (err) {
      console.error('[membank] distill failed (will retry next idle):', err);
    } finally {
      this.distilling.delete(sessionId);
    }
  }

  // ---- imported life memory: user-level, provenance-stamped ----

  /** Active life notes — zero means no archive was ever imported. */
  lifeCount(): number {
    try {
      const row = this.db
        .prepare("SELECT COUNT(*) AS n FROM life_notes WHERE status = 'active'")
        .get() as { n: number };
      return row.n;
    } catch {
      return 0;
    }
  }

  /**
   * Apply digester/agent ops to the life shelf. Returns ops applied. An
   * upsert of an existing (kind, title) evolves body/period/tags but KEEPS the
   * original provenance — the first archive that taught us a fact stays its
   * source.
   */
  lifeApplyOps(ops: LifeOp[], src: { source: string; batchId?: number }): number {
    let applied = 0;
    for (const op of ops.slice(0, 24)) {
      try {
        const kind = op.kind && LIFE_KINDS.has(op.kind) ? op.kind : undefined;
        const title = op.title?.trim();
        if (!kind || !title) continue;
        if (op.op === 'upsert') {
          const existing = this.db
            .prepare('SELECT id FROM life_notes WHERE kind = ? AND lower(title) = lower(?)')
            .get(kind, title) as { id: number } | undefined;
          const now = Date.now();
          if (existing) {
            this.db
              .prepare(
                `UPDATE life_notes SET
                   body = COALESCE(?, body), period = COALESCE(?, period),
                   tags = COALESCE(?, tags), status = 'active', updated_at = ?
                 WHERE id = ?`,
              )
              .run(
                typeof op.body === 'string' ? op.body.slice(0, 400) : null,
                typeof op.period === 'string' ? op.period.slice(0, 40) : null,
                typeof op.tags === 'string' ? op.tags.slice(0, 120) : null,
                now,
                existing.id,
              );
          } else {
            // Same live-cap discipline as the map: retire the stalest tenth
            // rather than refusing new knowledge.
            const live = this.db
              .prepare("SELECT COUNT(*) AS n FROM life_notes WHERE status = 'active'")
              .get() as { n: number };
            if (live.n >= MAX_LIVE_LIFE_NOTES) {
              this.db
                .prepare(
                  `UPDATE life_notes SET status = 'superseded', updated_at = ?
                     WHERE id IN (
                       SELECT id FROM life_notes WHERE status = 'active'
                       ORDER BY updated_at ASC LIMIT ?
                     )`,
                )
                .run(now, Math.ceil(MAX_LIVE_LIFE_NOTES * 0.1));
            }
            this.db
              .prepare(
                `INSERT INTO life_notes
                   (kind, title, body, period, tags, status, source, batch_id, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
              )
              .run(
                kind,
                title.slice(0, 120),
                (op.body ?? '').slice(0, 400),
                (op.period ?? '').slice(0, 40),
                (op.tags ?? '').slice(0, 120),
                src.source,
                src.batchId ?? null,
                now,
                now,
              );
          }
          applied++;
        } else if (op.op === 'status' && op.status && LIFE_STATUS.has(op.status)) {
          const res = this.db
            .prepare(
              'UPDATE life_notes SET status = ?, updated_at = ? WHERE kind = ? AND lower(title) = lower(?)',
            )
            .run(op.status, Date.now(), kind, title);
          if (res.changes) applied++;
        }
      } catch (err) {
        console.error('[membank] life op skipped:', err);
      }
    }
    if (applied > 0) {
      this.lifeVersion++;
      this.lifeDigestCache = null;
    }
    return applied;
  }

  /**
   * Compact listing the digester sees for dedup decisions (titles only). With
   * a batchId it is the fuller per-archive view the final pass reads, bodies
   * included.
   */
  lifeIndex(maxChars = LIFE_INDEX_MAX_CHARS, batchId?: number): string {
    try {
      type Row = {
        kind: string;
        title: string;
        body: string;
        period: string;
        status: string;
      };
      const rows = (
        batchId !== undefined
          ? this.db
              .prepare(
                `SELECT kind, title, body, period, status FROM life_notes
                 WHERE batch_id = ? ORDER BY kind, updated_at DESC LIMIT 400`,
              )
              .all(batchId)
          : this.db
              .prepare(
                `SELECT kind, title, body, period, status FROM life_notes
                 ORDER BY updated_at DESC LIMIT 400`,
              )
              .all()
      ) as Row[];
      let out = '';
      for (const r of rows) {
        const period = r.period ? ` [${r.period}]` : '';
        const line =
          batchId !== undefined
            ? `${r.kind}: ${r.title}${period}${r.body ? ` — ${r.body}` : ''}\n`
            : `${r.kind}: ${r.title}${period}${r.status !== 'active' ? ' [superseded]' : ''}\n`;
        if (out.length + line.length > maxChars) break;
        out += line;
      }
      return out;
    } catch {
      return '';
    }
  }

  /**
   * The bounded life-briefing block: identity and preferences first — they
   * shape how to talk to the user — then recency. The FRAMING (where these
   * came from, that their referents are not in this app) is added by prompt
   * assembly; this renders only the stamped notes.
   */
  lifeDigest(maxChars = 1_800): string {
    if (this.lifeDigestCache?.v === this.lifeVersion) return this.lifeDigestCache.note;
    let note = '';
    try {
      type Row = { kind: string; title: string; body: string; period: string; source: string };
      const rows = this.db
        .prepare(
          `SELECT kind, title, body, period, source FROM life_notes WHERE status = 'active'
           ORDER BY CASE kind WHEN 'identity' THEN 0 WHEN 'preference' THEN 1 ELSE 2 END,
                    updated_at DESC
           LIMIT 120`,
        )
        .all() as Row[];
      for (const r of rows) {
        const line =
          `• [${r.source}${r.period ? ` · ${r.period}` : ''}] ${r.kind}: ${r.title}` +
          (r.body ? ` — ${r.body}` : '') +
          '\n';
        if (note.length + line.length > maxChars) break;
        note += line;
      }
      note = note.trim();
    } catch {
      note = '';
    }
    this.lifeDigestCache = { v: this.lifeVersion, note };
    return note;
  }

  /** Life-note listing for the Memory → Archives view. */
  lifeNotes(
    opts: { query?: string; kind?: string; includeInactive?: boolean } = {},
  ): LifeNoteDto[] {
    type Row = {
      id: number;
      kind: string;
      title: string;
      body: string;
      period: string;
      tags: string;
      status: string;
      source: string;
      batch_id: number | null;
      updated_at: number;
    };
    const kindFilter = opts.kind && LIFE_KINDS.has(opts.kind) ? opts.kind : undefined;
    let rows: Row[];
    const byRecency = (): Row[] =>
      this.db
        .prepare(
          `SELECT * FROM life_notes ${kindFilter ? 'WHERE kind = ?' : ''}
           ORDER BY updated_at DESC LIMIT 300`,
        )
        .all(...(kindFilter ? [kindFilter] : [])) as Row[];
    if (opts.query?.trim()) {
      const safe = opts.query
        .trim()
        .split(/\s+/)
        .map((t) => `"${t.replace(/"/g, '')}"`)
        .join(' ');
      try {
        rows = this.db
          .prepare(
            `SELECT life_notes.* FROM life_fts JOIN life_notes ON life_notes.id = life_fts.rowid
             WHERE life_fts MATCH ? ${kindFilter ? 'AND life_notes.kind = ?' : ''}
             ORDER BY rank LIMIT 200`,
          )
          .all(...(kindFilter ? [safe, kindFilter] : [safe])) as Row[];
      } catch {
        rows = byRecency();
      }
    } else {
      rows = byRecency();
    }
    if (!opts.includeInactive) rows = rows.filter((r) => r.status === 'active');
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      period: r.period,
      tags: r.tags,
      status: r.status,
      source: r.source,
      batchId: r.batch_id ?? undefined,
      updatedAt: r.updated_at,
    }));
  }

  lifeSetStatus(id: number, status: string): boolean {
    if (!LIFE_STATUS.has(status)) return false;
    this.db
      .prepare('UPDATE life_notes SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, Date.now(), id);
    this.lifeVersion++;
    this.lifeDigestCache = null;
    return true;
  }

  lifeDeleteNote(id: number): void {
    this.db.prepare('DELETE FROM life_notes WHERE id = ?').run(id);
    this.lifeVersion++;
    this.lifeDigestCache = null;
  }

  lifeBatchCreate(input: {
    source: string;
    file: string;
    model: string;
    chatsTotal: number;
    depth: string;
  }): number {
    this.db
      .prepare(
        `INSERT INTO life_batches (source, file, model, depth, chats_total, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.source, input.file, input.model, input.depth, input.chatsTotal, Date.now());
    const row = this.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number };
    return row.id;
  }

  lifeBatchGet(id: number): LifeBatchDto | undefined {
    const r = this.db.prepare('SELECT * FROM life_batches WHERE id = ?').get(id) as
      | unknown as LifeBatchRow | undefined;
    return r ? lifeBatchDto(r) : undefined;
  }

  lifeBatchUpdate(
    id: number,
    patch: {
      cursor?: number;
      notes?: number;
      status?: string;
      summary?: string;
      error?: string;
      model?: string;
      finishedAt?: number;
    },
  ): void {
    try {
      const cols: Array<[value: string | number | undefined, col: string]> = [
        [patch.cursor, 'cursor'],
        [patch.notes, 'notes'],
        [patch.status, 'status'],
        [patch.summary, 'summary'],
        [patch.error, 'error'],
        [patch.model, 'model'],
        [patch.finishedAt, 'finished_at'],
      ];
      const sets = cols.filter(([v]) => v !== undefined);
      if (!sets.length) return;
      this.db
        .prepare(`UPDATE life_batches SET ${sets.map(([, c]) => `${c} = ?`).join(', ')} WHERE id = ?`)
        .run(...sets.map(([v]) => v!), id);
    } catch (err) {
      console.error('[membank] life batch update failed:', err);
    }
  }

  lifeBatches(): LifeBatchDto[] {
    try {
      const rows = this.db
        .prepare('SELECT * FROM life_batches ORDER BY started_at DESC LIMIT 50')
        .all() as unknown as LifeBatchRow[];
      return rows.map(lifeBatchDto);
    } catch {
      return [];
    }
  }

  /** Delete an import run AND the notes it created (merged notes from other
   *  batches keep their own provenance and survive). */
  lifeBatchDelete(id: number): void {
    this.db.prepare('DELETE FROM life_notes WHERE batch_id = ?').run(id);
    this.db.prepare('DELETE FROM life_batches WHERE id = ?').run(id);
    this.lifeVersion++;
    this.lifeDigestCache = null;
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
            // `items` is mandatory for some providers (Gemini 400s without it).
            ops: {
              type: 'array',
              description: 'Array of op objects (see description)',
              items: { type: 'object' },
            },
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
      {
        name: 'life_recall',
        description:
          "Search the user's imported LIFE MEMORY — durable notes distilled from chat archives " +
          'they exported from other assistants (ChatGPT, Claude, Gemini) and imported here. ' +
          'Every note names its source archive. The conversations and projects these notes ' +
          'mention happened OUTSIDE this app, before Vodo: they are NOT in the conversation ' +
          'archive, archive_search cannot find them, and there is nothing here to open. Omit the ' +
          'query for the most relevant notes overall.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search words; omit to list the top notes' },
            kind: {
              type: 'string',
              description: 'Filter: identity|preference|project|skill|fact|era',
            },
            includeInactive: { type: 'boolean', description: 'Include superseded notes' },
          },
        },
      },
      {
        name: 'life_update',
        description:
          'Correct or extend the imported life memory: ' +
          '{"op":"upsert","kind":"identity|preference|project|skill|fact|era","title":"…",' +
          '"body":"…","period":"…"} · ' +
          '{"op":"status","kind":"project","title":"…","status":"superseded"}. Use when the user ' +
          'corrects something from their archives or an imported note proves outdated — ' +
          'supersede rather than delete.',
        inputSchema: {
          type: 'object',
          properties: {
            // `items` is mandatory for some providers (Gemini 400s without it).
            ops: {
              type: 'array',
              description: 'Array of op objects (see description)',
              items: { type: 'object' },
            },
          },
          required: ['ops'],
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
        case 'life_recall': {
          const query = String(a.query ?? '').trim();
          const kind = a.kind && LIFE_KINDS.has(String(a.kind)) ? String(a.kind) : undefined;
          const notes = this.lifeNotes({
            ...(query ? { query } : {}),
            ...(kind ? { kind } : {}),
            includeInactive: a.includeInactive === true,
          }).slice(0, 24);
          if (notes.length === 0) {
            return {
              content:
                this.lifeCount() === 0
                  ? 'No imported life memory exists — the user has not imported any chat archives.'
                  : `No imported life notes match${query ? ` "${query}"` : ''}.`,
            };
          }
          const lines = notes.map(
            (n) =>
              `• [${n.source}${n.period ? ` · ${n.period}` : ''}] ${n.kind}: ${n.title}` +
              (n.body ? ` — ${n.body}` : '') +
              (n.status !== 'active' ? ' [superseded]' : ''),
          );
          return {
            content:
              'Imported life memory — distilled from chat archives the user exported from other ' +
              'assistants. The conversations and projects these mention happened OUTSIDE this ' +
              'app, before you: no transcript of them exists here and there is nothing to open. ' +
              'What you have lived in this app outranks these when they disagree.\n' +
              lines.join('\n'),
          };
        }
        case 'life_update': {
          if (!Array.isArray(a.ops)) return { content: 'ops must be an array.', isError: true };
          const applied = this.lifeApplyOps(a.ops as LifeOp[], { source: 'vodo' });
          return {
            content: `Applied ${applied} of ${(a.ops as unknown[]).length} ops to the life memory.`,
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

interface LifeBatchRow {
  id: number;
  source: string;
  file: string;
  model: string;
  depth: string;
  chats_total: number;
  cursor: number;
  notes: number;
  status: string;
  summary: string;
  error: string;
  started_at: number;
  finished_at: number | null;
}

function lifeBatchDto(r: LifeBatchRow): LifeBatchDto {
  return {
    id: r.id,
    source: r.source,
    file: r.file,
    model: r.model,
    depth: r.depth,
    chatsTotal: r.chats_total,
    cursor: r.cursor,
    notes: r.notes,
    status: r.status,
    summary: r.summary,
    error: r.error,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? undefined,
  };
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

/** Arguments are the difference between "it ran ws_write" and knowing what it wrote. */
const ARGS_MAX = 300;
/** Reasoning can run long; enough to carry a plan, not enough to bloat the archive. */
const THINKING_MAX = 2_000;

/**
 * Flatten one harness message into searchable text.
 *
 * Thinking is kept here even though providers never replay it: a plan the
 * model formed while reasoning exists in exactly ONE response, so if the
 * archive drops it, it cannot be recovered by re-reading — and that plan is
 * precisely what a mid-task compaction destroys. Tool-call arguments are kept
 * for the same reason: "[ran ws_write]" cannot tell anyone what was attempted.
 */
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
        if (p.type === 'thinking') return `[thinking] ${p.text.slice(0, THINKING_MAX)}`;
        if (p.type === 'tool_call') {
          const args = JSON.stringify(p.args ?? {}).slice(0, ARGS_MAX);
          return `[ran ${p.name} ${args}]`;
        }
        return '';
      })
      .join(' ')
      .trim();
  }
  return msg.content.trim();
}
