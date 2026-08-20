import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { app } from 'electron';
import { HOMELAB_PROJECT_ID } from '../shared/homelab';
import type { HarnessMessage } from '@vo-coder/providers';
import type {
  ChatSessionMeta,
  GroupRun,
  ProjectInfo,
  ProjectsData,
} from '../shared/ipc-contract';

export { HOMELAB_PROJECT_ID };


/** Stable id for the default generic home — its chats run folder-less. */
export const GENERAL_PROJECT_ID = 'general';

/**
 * The Pro edition's Design home. It does not exist HERE — but profiles carried
 * over from the pre-split app still hold its record, and that fossil must
 * never own a folder (see the ensureDefault heal).
 */
const DESIGN_LIBRARY_FOSSIL_ID = 'design_library';

/**
 * Projects group chat sessions; both persist under userData so threads survive
 * restarts. projects.json holds the structure; each session's full message
 * history lives in chats/<sessionId>.json.
 */
export class ProjectStore {
  private chatsDir = join(app.getPath('userData'), 'chats');
  private file = join(app.getPath('userData'), 'projects.json');
  private cache: ProjectsData | null = null;

  private load(): ProjectsData {
    if (!this.cache) {
      try {
        this.cache = JSON.parse(readFileSync(this.file, 'utf8')) as ProjectsData;
      } catch {
        // A torn/corrupt file must never silently vanish — keep the evidence
        // next to the fresh start so the structure can be reconstructed.
        if (existsSync(this.file)) {
          try {
            copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`);
            console.error('[projects] projects.json was unreadable — backed up and starting fresh');
          } catch {
            /* backup is best-effort */
          }
        }
        this.cache = { projects: [], sessions: [] };
      }
    }
    return this.cache;
  }

  /** Write-temp-then-rename: a kill mid-write can never tear the real file. */
  private persist(): void {
    mkdirSync(this.chatsDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.load(), null, 2), 'utf8');
    renameSync(tmp, this.file);
  }

  setDir(id: string, dir: string): boolean {
    const project = this.load().projects.find((p) => p.id === id);
    if (!project) return false;
    // General is the generic home: its chats run folder-less unless the user
    // points an individual chat at a folder (sessionSetDir). A project-level dir
    // here would arm every new generic chat with a workspace it was never given.
    if (project.id === GENERAL_PROJECT_ID) return false;
    project.dir = dir;
    this.persist();
    return true;
  }

  setAssemble(id: string, enabled: boolean): boolean {
    const project = this.load().projects.find((p) => p.id === id);
    if (!project) return false;
    project.assemble = enabled;
    this.persist();
    return true;
  }

  ensureDefault(): void {
    const data = this.load();
    if (data.projects.length === 0) {
      data.projects.push({ id: GENERAL_PROJECT_ID, name: 'General', createdAt: Date.now() });
      this.persist();
    }
    // Heal profiles written before General was fenced: a project-level dir here
    // made every new generic chat scan and use that folder.
    const general = data.projects.find((p) => p.id === GENERAL_PROJECT_ID);
    if (general?.dir) {
      delete general.dir;
      this.persist();
      console.log('[projects] removed project folder from General — generic chats run folder-less');
    }
    // Heal profiles carried over from the pre-split app: its Design library
    // stored an ABSOLUTE folder under the old app's Roaming profile
    // (…\@vo-coder\desktop\design-library). This edition has no Design suite,
    // so such records must never steer a chat's workspace — seen live: the
    // welcome card showed the fossil path while the user's generic folder was
    // correctly set, because a project's own dir always outranks it.
    // The design_library record itself may hold ANY dir (fossil profiles let
    // it grab real folders) — and then it silently OWNS that folder: binding
    // a chat there rehomes nothing, groups nest into the hidden fossil, and
    // the sidebar never shows the project the user expects. Seen live with a
    // demo folder. In this edition that record never keeps a folder, period.
    let fossils = 0;
    const isFossilDir = (dir: string) => /[\\/]@vo-coder[\\/]/.test(dir);
    for (const p of data.projects) {
      if (p.dir && (p.id === DESIGN_LIBRARY_FOSSIL_ID || isFossilDir(p.dir))) {
        delete p.dir;
        fossils++;
      }
    }
    for (const s of data.sessions) {
      if (s.dir && isFossilDir(s.dir)) {
        delete s.dir;
        fossils++;
      }
    }
    if (fossils > 0) {
      this.persist();
      console.log(
        `[projects] removed ${fossils} pre-split folder pointer(s) — chats fall back to the generic folder`,
      );
    }
  }

  /**
   * Mr Homelab's own project: his chats belong to him, not to General's chat
   * list. Hidden from the sidebar (his tab is the only way in) but an ordinary
   * project underneath — so the memory bank, archive and journal work exactly
   * as they do for every other chat. No folder of its own: the cascade falls
   * through to the generic folder, which is where his scripts and inventories
   * should live.
   */
  ensureHomelab(): ProjectInfo {
    const data = this.load();
    let project = data.projects.find((p) => p.id === HOMELAB_PROJECT_ID);
    if (!project) {
      project = {
        id: HOMELAB_PROJECT_ID,
        name: 'Mr Homelab',
        createdAt: Date.now(),
        assemble: true,
      };
      data.projects.push(project);
      this.persist();
    }
    return { ...project };
  }

  list(): ProjectsData {
    const data = this.load();
    return {
      projects: [...data.projects],
      sessions: [...data.sessions].sort((a, b) => b.updatedAt - a.updatedAt),
      // Groups ride EVERY broadcast. They used to be a separate on-demand
      // fetch, so a group started after app launch was unknown to the
      // sidebar and its member chats scattered as loose top-level rows
      // (seen live) until a restart happened to refetch.
      groups: [...(data.groups ?? [])],
    };
  }

  createProject(name: string, dir?: string): ProjectInfo {
    const project: ProjectInfo = {
      id: `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      name: name.trim() || 'Untitled project',
      ...(dir ? { dir } : {}),
      createdAt: Date.now(),
    };
    this.load().projects.push(project);
    this.persist();
    return project;
  }

  deleteProject(id: string): string[] {
    const data = this.load();
    const removed = data.sessions.filter((s) => s.projectId === id).map((s) => s.id);
    data.projects = data.projects.filter((p) => p.id !== id);
    data.sessions = data.sessions.filter((s) => s.projectId !== id);
    // Drop the project's group runs too — they carry the now-deleted projectId
    // and member sessionIds, and list() broadcasts them unfiltered, so leaving
    // them behind strands a dead GroupRun in projects.json on every event.
    if (data.groups) data.groups = data.groups.filter((g) => g.projectId !== id);
    for (const sessionId of removed) {
      rmSync(this.transcriptPath(sessionId), { force: true });
    }
    this.persist();
    this.ensureDefault();
    return removed;
  }

  createSession(
    projectId: string,
    /**
     * Coalesced rather than defaulted. A default parameter only fires on
     * undefined, and this is reachable from the remote wire, where JSON turns
     * an omitted trailing argument into an explicit null — which would sail
     * past a default and store a session with no agent at all. The failure
     * surfaces later and elsewhere, as "Unknown agent null" on the first
     * message, which points at the wrong thing entirely.
     */
    agentIdOrNull?: string | null,
    title?: string,
    groupId?: string,
    /** Attach a working folder at birth — group members inherit the coordinator's. */
    dir?: string,
  ): ChatSessionMeta {
    const agentId = agentIdOrNull || 'default';
    const meta: ChatSessionMeta = {
      id: `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      projectId,
      agentId,
      title: title?.trim() || 'New chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(groupId ? { groupId } : {}),
      ...(dir ? { dir } : {}),
    };
    this.load().sessions.push(meta);
    this.persist();
    return meta;
  }

  // ---- group runs: several agents, one goal, one project ----

  groups(): GroupRun[] {
    return [...(this.load().groups ?? [])];
  }

  addGroup(group: GroupRun): void {
    const data = this.load();
    data.groups = [...(data.groups ?? []), group];
    this.persist();
  }

  /** Replace a stored group by id — how a live group grows a member. */
  updateGroup(group: GroupRun): void {
    const data = this.load();
    data.groups = (data.groups ?? []).map((g) => (g.id === group.id ? group : g));
    this.persist();
  }

  /**
   * End a run without touching its sessions — the transcripts are ordinary
   * chats and stay where they are, so the work survives the group that
   * organised it.
   */
  endGroup(groupId: string): void {
    const data = this.load();
    const group = (data.groups ?? []).find((g) => g.id === groupId);
    if (!group || group.endedAt) return;
    group.endedAt = Date.now();
    this.persist();
  }

  deleteSession(id: string): void {
    const data = this.load();
    data.sessions = data.sessions.filter((s) => s.id !== id);
    rmSync(this.transcriptPath(id), { force: true });
    this.persist();
  }

  renameSession(id: string, title: string): void {
    const meta = this.meta(id);
    const next = title.trim();
    if (meta && next) {
      // A manual name is never overwritten: touch() only auto-titles 'New chat'.
      meta.title = next.length > 60 ? `${next.slice(0, 60)}…` : next;
      this.persist();
    }
  }

  /** Remove the group record itself — its sessions are deleted separately. */
  removeGroup(groupId: string): void {
    const data = this.load();
    data.groups = (data.groups ?? []).filter((g) => g.id !== groupId);
    this.persist();
  }

  meta(id: string): ChatSessionMeta | undefined {
    return this.load().sessions.find((s) => s.id === id);
  }

  setAgent(id: string, agentId: string): void {
    const meta = this.meta(id);
    if (meta) {
      meta.agentId = agentId;
      this.persist();
    }
  }

  setSessionDir(id: string, dir: string | null): void {
    const meta = this.meta(id);
    if (meta) {
      if (dir) meta.dir = dir;
      else delete meta.dir;
      this.persist();
    }
  }

  /** The chat's conversation id inside an external CLI agent (Claude Code
   *  --resume). Null clears it — a reset chat must not resume the old talk. */
  setCliSessionId(id: string, cliId: string | null): void {
    const meta = this.meta(id);
    if (meta && (meta.cliSessionId ?? null) !== cliId) {
      if (cliId) meta.cliSessionId = cliId;
      else delete meta.cliSessionId;
      this.persist();
    }
  }

  /**
   * One folder ↔ one project: the project that owns this dir, created from
   * the folder's name when nobody does yet. Path compare is case-blind —
   * Windows hands out the same folder in mixed casings.
   */
  projectForDir(dir: string): ProjectInfo {
    const key = resolve(dir).toLowerCase();
    const owner = this.load().projects.find(
      (p) => p.dir && resolve(p.dir).toLowerCase() === key,
    );
    if (owner) return owner;
    return this.createProject(basename(resolve(dir)) || dir, dir);
  }

  /**
   * The project that owns `dir`, or a new one named `name`. ONE FOLDER ↔ ONE
   * PROJECT: project_create used to push a fresh row every time, so working on
   * the same folder twice — which is exactly what happens when each Telegram
   * task is dispatched separately — left the sidebar full of duplicate
   * projects with the same name and one chat each.
   */
  createOrAdopt(name: string, dir: string): { project: ProjectInfo; adopted: boolean } {
    const key = resolve(dir).toLowerCase();
    const owner = this.load().projects.find(
      (p) => p.dir && resolve(p.dir).toLowerCase() === key,
    );
    if (owner) return { project: owner, adopted: true };
    return { project: this.createProject(name, dir), adopted: false };
  }

  /**
   * Heal the one-folder-one-project invariant for rows made before it existed.
   * Same-folder duplicates are merged into the OLDEST row: every chat and group
   * is re-parented, then the empty duplicate is dropped. Nothing is deleted —
   * a chat only changes which project lists it — and a backup of projects.json
   * is written the first time it runs.
   *
   * Returns what moved so the caller can migrate the memory bank too.
   */
  mergeDuplicateDirs(): Array<{
    keptId: string;
    keptName: string;
    merged: string[];
    sessionIds: string[];
  }> {
    const data = this.load();
    const byDir = new Map<string, ProjectInfo[]>();
    for (const p of data.projects) {
      if (!p.dir) continue;
      const key = resolve(p.dir).toLowerCase();
      const list = byDir.get(key);
      if (list) list.push(p);
      else byDir.set(key, [p]);
    }
    const out: Array<{ keptId: string; keptName: string; merged: string[]; sessionIds: string[] }> =
      [];
    for (const group of byDir.values()) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
      const kept = sorted[0]!;
      const gone = sorted.slice(1);
      const goneIds = new Set(gone.map((p) => p.id));
      const sessionIds = data.sessions.filter((s) => goneIds.has(s.projectId)).map((s) => s.id);
      if (!out.length) this.backup();
      for (const s of data.sessions) if (goneIds.has(s.projectId)) s.projectId = kept.id;
      for (const g of data.groups ?? []) if (goneIds.has(g.projectId)) g.projectId = kept.id;
      data.projects = data.projects.filter((p) => !goneIds.has(p.id));
      out.push({
        keptId: kept.id,
        keptName: kept.name,
        merged: gone.map((p) => p.name),
        sessionIds,
      });
    }
    if (out.length) this.persist();
    return out;
  }

  /** One-shot copy of projects.json beside itself, before a migration edits it. */
  private backup(): void {
    try {
      copyFileSync(this.file, `${this.file}.before-merge`);
    } catch {
      /* best-effort — the merge itself is non-destructive */
    }
  }

  /** Find a project by name (case-blind, then loose) — how a dispatched brief
   *  names where its work belongs. */
  findByName(name: string): ProjectInfo | undefined {
    const want = name.trim().toLowerCase();
    if (!want) return undefined;
    const list = this.load().projects;
    return (
      list.find((p) => p.name.trim().toLowerCase() === want) ??
      list.find((p) => p.name.trim().toLowerCase().includes(want)) ??
      list.find((p) => want.includes(p.name.trim().toLowerCase()))
    );
  }

  /**
   * Rehome a chat to another project. Only the parent changes — the history
   * file, groupId and dir all stay; the caller migrates the memory bank.
   */
  moveSession(sessionId: string, projectId: string): boolean {
    const data = this.load();
    const meta = data.sessions.find((s) => s.id === sessionId);
    if (!meta || meta.projectId === projectId) return false;
    if (!data.projects.some((p) => p.id === projectId)) return false;
    meta.projectId = projectId;
    meta.updatedAt = Date.now();
    this.persist();
    return true;
  }

  touch(id: string, autoTitle?: string): void {
    const meta = this.meta(id);
    if (!meta) return;
    meta.updatedAt = Date.now();
    if (autoTitle && meta.title === 'New chat') {
      meta.title = autoTitle.length > 48 ? `${autoTitle.slice(0, 48)}…` : autoTitle;
    }
    this.persist();
  }

  private transcriptPath(id: string): string {
    return join(this.chatsDir, `${id.replace(/[^a-z0-9_-]/gi, '')}.json`);
  }

  saveTranscript(id: string, history: HarnessMessage[]): void {
    mkdirSync(this.chatsDir, { recursive: true });
    const path = this.transcriptPath(id);
    writeFileSync(`${path}.tmp`, JSON.stringify(history), 'utf8');
    renameSync(`${path}.tmp`, path);
  }

  loadTranscript(id: string): HarnessMessage[] {
    try {
      if (!existsSync(this.transcriptPath(id))) return [];
      return JSON.parse(readFileSync(this.transcriptPath(id), 'utf8')) as HarnessMessage[];
    } catch {
      return [];
    }
  }
}
