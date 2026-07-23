import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { HarnessMessage } from '@vo-coder/providers';
import type { ChatSessionMeta, ProjectInfo, ProjectsData } from '../shared/ipc-contract';

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
      data.projects.push({ id: 'general', name: 'General', createdAt: Date.now() });
      this.persist();
    }
  }

  list(): ProjectsData {
    const data = this.load();
    return {
      projects: [...data.projects],
      sessions: [...data.sessions].sort((a, b) => b.updatedAt - a.updatedAt),
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
    for (const sessionId of removed) {
      rmSync(this.transcriptPath(sessionId), { force: true });
    }
    this.persist();
    this.ensureDefault();
    return removed;
  }

  createSession(projectId: string, agentId = 'default'): ChatSessionMeta {
    const meta: ChatSessionMeta = {
      id: `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      projectId,
      agentId,
      title: 'New chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.load().sessions.push(meta);
    this.persist();
    return meta;
  }

  deleteSession(id: string): void {
    const data = this.load();
    data.sessions = data.sessions.filter((s) => s.id !== id);
    rmSync(this.transcriptPath(id), { force: true });
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
