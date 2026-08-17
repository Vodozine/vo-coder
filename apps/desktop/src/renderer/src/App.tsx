import { useEffect, useMemo, useState } from 'react';
import { Icon } from './components/Icon';
import { VodoMark } from './components/VodoMark';
import { useStore, type View } from './state/store';
import { HOMELAB_PROJECT_ID } from '../../shared/homelab';
import { Agents } from './views/Agents';
import { Chat, fmtCost, fmtTokens } from './views/Chat';
import { TerminalTabs } from './views/Console';
import { Memory } from './views/Memory';
import { Missions } from './views/Missions';
import { Preview } from './views/Preview';
import { Projects } from './views/Projects';
import { Pipelines } from './views/Pipelines';
import { Settings } from './views/Settings';

const NAV = [
  { id: 'chat', label: 'Chat', enabled: true },
  { id: 'agents', label: 'Agents', enabled: true },
  { id: 'missions', label: 'Missions', enabled: true },
  { id: 'pipelines', label: 'Pipelines', enabled: true },
  { id: 'memory', label: 'Memory', enabled: true },
  { id: 'scaffold', label: 'Projects', enabled: true },
  { id: 'preview', label: 'Preview', enabled: true },
  { id: 'console', label: 'Terminal', enabled: true },
  { id: 'settings', label: 'Settings', enabled: true },
] as const;

type DeleteTarget =
  | { kind: 'project'; id: string; name: string; chatCount: number }
  | { kind: 'group'; id: string; name: string; chatCount: number }
  | { kind: 'session'; id: string; title: string };

/**
 * Guard rail for destructive sidebar actions: projects must have their name
 * typed back (chats are gone for good; the folder on disk is never touched),
 * chats get a plain confirm instead of dying to a stray click.
 */
function DeleteGuard({ target, onClose }: { target: DeleteTarget; onClose: () => void }) {
  const removeSession = useStore((s) => s.removeSession);
  const removeProject = useStore((s) => s.removeProject);
  const removeGroup = useStore((s) => s.removeGroup);
  const [typed, setTyped] = useState('');
  const isProject = target.kind === 'project';
  const armed = !isProject || typed.trim().toLowerCase() === target.name.trim().toLowerCase();

  const confirm = async () => {
    if (!armed) return;
    if (target.kind === 'project') await removeProject(target.id);
    else if (target.kind === 'group') await removeGroup(target.id);
    else await removeSession(target.id);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          {isProject ? 'Delete project' : target.kind === 'group' ? 'Delete group project' : 'Delete chat'}
        </h3>
        {isProject ? (
          <>
            <p className="hint">
              This deletes <strong>{target.name}</strong> and its{' '}
              {target.chatCount === 1 ? '1 chat' : `${target.chatCount} chats`} from Vo-Coder —
              chat history is gone for good. The project folder on disk is <em>not</em> touched.
            </p>
            <div className="field-row">
              <input
                autoFocus
                className="grow"
                placeholder={`Type "${target.name}" to confirm`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void confirm();
                  if (e.key === 'Escape') onClose();
                }}
              />
            </div>
          </>
        ) : target.kind === 'group' ? (
          <p className="hint">
            This deletes the whole group project <strong>{target.name}</strong> — all{' '}
            {target.chatCount === 1 ? '1 of its chats' : `${target.chatCount} of its chats`}{' '}
            (coordinator and members) and their history, for good. Files on disk are{' '}
            <em>not</em> touched.
          </p>
        ) : (
          <p className="hint">
            Delete the chat <strong>{target.title}</strong>? Its history is gone for good.
          </p>
        )}
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="stop" disabled={!armed} onClick={() => void confirm()}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

/** Projects stack up in the sidebar; each expands into its chat sessions. */
function ProjectsPanel() {
  const projects = useStore((s) => s.projects);
  const sessionMetas = useStore((s) => s.sessionMetas);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const openSession = useStore((s) => s.openSession);
  const newSession = useStore((s) => s.newSession);
  const newProjectIn = useStore((s) => s.newProjectIn);
  const openExistingProject = useStore((s) => s.openExistingProject);
  const groups = useStore((s) => s.groups);
  const renameSession = useStore((s) => s.renameSession);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** Group bundles start FOLDED — that is the decluttering. */
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /** null | 'menu' | 'new' — sidebar create/open affordance. */
  const [projectMenu, setProjectMenu] = useState<null | 'menu' | 'new'>(null);
  const [name, setName] = useState('');
  const [parent, setParent] = useState(() => localStorage.getItem('vo-projects-parent') ?? '');
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleGroup = (id: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const commitRename = async (id: string) => {
    const next = draft.trim();
    setEditingId(null);
    if (next) await renameSession(id, next);
  };

  const pickParent = async () => {
    const dir = await window.vo.scaffoldPickDir();
    if (dir) {
      setParent(dir);
      localStorage.setItem('vo-projects-parent', dir);
    }
  };

  const createProject = async () => {
    if (!name.trim() || !parent) return;
    setCreateError(null);
    const error = await newProjectIn(name.trim(), parent);
    if (error) {
      setCreateError(error);
      return;
    }
    setName('');
    setProjectMenu(null);
  };

  const continueExisting = async () => {
    setCreateError(null);
    const error = await openExistingProject();
    if (error) {
      setCreateError(error);
      setProjectMenu('menu');
      return;
    }
    setProjectMenu(null);
  };

  return (
    <div className="projects-panel">
      <div className="projects-head">
        <span>Projects</span>
        <button
          className="chip-x"
          title="Add a project"
          onClick={() => setProjectMenu((m) => (m ? null : 'menu'))}
        >
          +
        </button>
      </div>
      {projectMenu === 'menu' && (
        <div className="project-name-form project-add-menu">
          <button
            className="project-menu-btn"
            onClick={() => {
              setCreateError(null);
              setProjectMenu('new');
            }}
          >
            <Icon name="folder" size={12} /> New project…
          </button>
          <button className="project-menu-btn" onClick={() => void continueExisting()}>
            <Icon name="folder" size={12} /> Continue from folder…
          </button>
          <div className="project-loc-hint">
            Continue attaches any existing folder — no new folder, no questionnaire.
          </div>
          {createError && <div className="project-loc-hint error-text">{createError}</div>}
        </div>
      )}
      {projectMenu === 'new' && (
        <div className="project-name-form">
          <input
            autoFocus
            value={name}
            placeholder="Project name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createProject();
              if (e.key === 'Escape') setProjectMenu(null);
            }}
          />
          <button
            className="project-loc"
            title="Where the project folder is created"
            onClick={() => void pickParent()}
          >
            <Icon name="folder" size={12} />{' '}
            {parent ? `…\\${parent.split(/[\\/]/).pop()}` : 'Choose location…'}
          </button>
          {name.trim() && parent && (
            <div className="project-loc-hint">
              creates {parent.split(/[\\/]/).pop()}\{name.trim()} and starts setup
            </div>
          )}
          <button
            className="send project-create"
            disabled={!name.trim() || !parent}
            onClick={() => void createProject()}
          >
            Create project
          </button>
          <button className="ghost project-create" onClick={() => setProjectMenu('menu')}>
            Back
          </button>
          {createError && <div className="project-loc-hint error-text">{createError}</div>}
        </div>
      )}
      <div className="projects-list">
        {/* Mr Homelab's project belongs to his tab, not the sidebar. */}
        {projects
          .filter((p) => p.id !== HOMELAB_PROJECT_ID)
          .map((project) => {
          const sessions = sessionMetas.filter((m) => m.projectId === project.id);
          const isOpen = !collapsed.has(project.id);
          return (
            <div key={project.id} className="project-block">
              <div
                className={`project-row ${project.id === activeProjectId ? 'active' : ''}`}
              >
                <button className="project-toggle" onClick={() => toggle(project.id)}>
                  <span className="tree-arrow">{isOpen ? '▾' : '▸'}</span> {project.name}
                </button>
                <button
                  className="chip-x"
                  title="New chat in this project"
                  onClick={() => void newSession(project.id)}
                >
                  +
                </button>
                {projects.length > 1 && (
                  <button
                    className="chip-x"
                    title="Delete project and its chats"
                    onClick={() =>
                      setDeleteTarget({
                        kind: 'project',
                        id: project.id,
                        name: project.name,
                        chatCount: sessions.length,
                      })
                    }
                  >
                    ×
                  </button>
                )}
              </div>
              {(() => {
                if (!isOpen) return null;
                // A group project is ONE sidebar entry, folded by default —
                // its coordinator and member chats live inside it, and its ×
                // deletes them all at once instead of one by one.
                const groupsHere = groups.filter((g) => g.projectId === project.id);
                const inBundle = (m: (typeof sessions)[number]) =>
                  groupsHere.some((g) => g.id === m.groupId || g.coordinatorId === m.id);
                // Group chats whose record is gone (legacy runs, drift) used
                // to scatter as loose rows — the exact clutter bundles exist
                // to prevent. They fold into a synthetic bundle per groupId.
                const orphanIds = [
                  ...new Set(
                    sessions
                      .filter((m) => m.groupId && !inBundle(m))
                      .map((m) => m.groupId as string),
                  ),
                ];
                const loose = sessions.filter((m) => !inBundle(m) && !m.groupId);
                const row = (meta: (typeof sessions)[number], bundled = false) => (
                  <div
                    key={meta.id}
                    className={`session-row ${meta.id === activeSessionId ? 'active' : ''} ${bundled ? 'in-bundle' : ''}`}
                  >
                    {editingId === meta.id ? (
                      <input
                        autoFocus
                        className="session-rename"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitRename(meta.id);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        onBlur={() => void commitRename(meta.id)}
                      />
                    ) : (
                      <>
                        <button
                          className="session-title"
                          title={
                            meta.groupId
                              ? 'Part of a group project — opening it brings all the agent windows back'
                              : 'Double-click to rename'
                          }
                          onClick={() => void openSession(meta.id)}
                          onDoubleClick={() => {
                            setEditingId(meta.id);
                            setDraft(meta.title);
                          }}
                        >
                          {!bundled && meta.groupId ? '⊞ ' : ''}
                          {meta.title}
                        </button>
                        <button
                          className="chip-x session-x session-edit"
                          title="Rename chat"
                          onClick={() => {
                            setEditingId(meta.id);
                            setDraft(meta.title);
                          }}
                        >
                          ✎
                        </button>
                        <button
                          className="chip-x session-x"
                          title="Delete chat"
                          onClick={() =>
                            setDeleteTarget({ kind: 'session', id: meta.id, title: meta.title })
                          }
                        >
                          ×
                        </button>
                      </>
                    )}
                  </div>
                );
                return (
                  <>
                    {loose.map((m) => row(m))}
                    {groupsHere.map((g) => {
                      const bundle = sessions.filter(
                        (m) => m.groupId === g.id || m.id === g.coordinatorId,
                      );
                      if (!bundle.length) return null;
                      const openG = openGroups.has(g.id);
                      const holdsActive = bundle.some((m) => m.id === activeSessionId);
                      return (
                        <div key={g.id} className="group-bundle">
                          <div
                            className={`session-row bundle-head ${holdsActive && !openG ? 'active' : ''}`}
                          >
                            <button
                              className="session-title"
                              title={`${g.goal}${g.endedAt ? ' (ended)' : ''} — ${bundle.length} chats`}
                              onClick={() => toggleGroup(g.id)}
                            >
                              <span className="tree-arrow">{openG ? '▾' : '▸'}</span> ⊞{' '}
                              {g.goal.length > 30 ? `${g.goal.slice(0, 30)}…` : g.goal}
                              <span className="bundle-count">{bundle.length}</span>
                            </button>
                            <button
                              className="chip-x session-x"
                              title="Delete this group project and ALL its chats"
                              onClick={() =>
                                setDeleteTarget({
                                  kind: 'group',
                                  id: g.id,
                                  name: g.goal.slice(0, 40),
                                  chatCount: bundle.length,
                                })
                              }
                            >
                              ×
                            </button>
                          </div>
                          {openG && bundle.map((m) => row(m, true))}
                        </div>
                      );
                    })}
                    {orphanIds.map((gid) => {
                      const bundle = sessions.filter((m) => m.groupId === gid);
                      if (!bundle.length) return null;
                      const openG = openGroups.has(gid);
                      const holdsActive = bundle.some((m) => m.id === activeSessionId);
                      const label = bundle[0]!.title;
                      return (
                        <div key={gid} className="group-bundle">
                          <div
                            className={`session-row bundle-head ${holdsActive && !openG ? 'active' : ''}`}
                          >
                            <button
                              className="session-title"
                              title={`Chats from an earlier group run — ${bundle.length} chats`}
                              onClick={() => toggleGroup(gid)}
                            >
                              <span className="tree-arrow">{openG ? '▾' : '▸'}</span> ⊞{' '}
                              {label.length > 30 ? `${label.slice(0, 30)}…` : label}
                              <span className="bundle-count">{bundle.length}</span>
                            </button>
                            <button
                              className="chip-x session-x"
                              title="Delete this group's chats"
                              onClick={() =>
                                setDeleteTarget({
                                  kind: 'group',
                                  id: gid,
                                  name: label.slice(0, 40),
                                  chatCount: bundle.length,
                                })
                              }
                            >
                              ×
                            </button>
                          </div>
                          {openG && bundle.map((m) => row(m, true))}
                        </div>
                      );
                    })}
                    {sessions.length === 0 && <div className="session-row empty">no chats yet</div>}
                  </>
                );
              })()}
            </div>
          );
        })}
      </div>
      {deleteTarget && (
        <DeleteGuard target={deleteTarget} onClose={() => setDeleteTarget(null)} />
      )}
    </div>
  );
}

/** All-time usage across every project — the tool shed's meter. */
function TotalUsage() {
  const usage = useStore((s) => s.usage);
  const t = usage?.allTime ?? { inputTokens: 0, outputTokens: 0, cost: 0 };
  return (
    <div className="sidebar-footer usage-footer" title="All-time usage across all projects">
      <span className="usage-label">Usage</span>
      <span className="usage-cost">{fmtCost(t.cost)}</span>
      <span>
        {fmtTokens(t.inputTokens)} in · {fmtTokens(t.outputTokens)} out
      </span>
    </div>
  );
}

/** Windows runs with a hidden title bar + overlaid native buttons. */
const CUSTOM_TITLEBAR = navigator.platform.toLowerCase().includes('win');

export function App() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const init = useStore((s) => s.init);
  const updateInfo = useStore((s) => s.updateInfo);
  const homelabOn = useStore((s) => !!s.config?.homelabEnabled);
  // Mr Homelab slots in under Terminal, and only when switched on in Settings.
  const navItems = useMemo(() => {
    const items: Array<{ id: string; label: string; enabled: boolean; title?: string }> = [
      ...NAV,
    ];
    if (homelabOn) {
      const at = items.findIndex((i) => i.id === 'console');
      items.splice(at + 1, 0, {
        id: 'homelab',
        label: 'Mr Homelab',
        enabled: true,
        title: 'Your infrastructure agent — hypervisors, containers, network, backups',
      });
    }
    return items;
  }, [homelabOn]);

  useEffect(() => {
    void init();
    if (CUSTOM_TITLEBAR) document.body.classList.add('custom-titlebar');
  }, [init]);

  return (
    <div className="app">
      {CUSTOM_TITLEBAR && <div className="drag-strip" />}
      <aside className="sidebar">
        <div className="logo">
          <VodoMark /> Vo-Coder
        </div>
        <nav>
          {navItems.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? 'active' : ''}`}
              disabled={!item.enabled}
              title={item.title}
              onClick={() => item.enabled && setView(item.id as View)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <ProjectsPanel />
        {updateInfo?.state === 'downloaded' && (
          <button className="update-chip" onClick={() => void window.vo.updateInstall()}>
            ⬆ Update ready — restart
          </button>
        )}
        <TotalUsage />
      </aside>
      <main className="content">
        {/* Homelab IS the Chat view, bound to Mr Homelab's own session — one
            component, so voice / Live / folders / attachments all work there. */}
        {view === 'chat' || view === 'homelab' ? (
          <Chat />
        ) : view === 'agents' ? (
          <Agents />
        ) : view === 'missions' ? (
          <Missions />
        ) : view === 'pipelines' ? (
          <Pipelines />
        ) : view === 'memory' ? (
          <Memory />
        ) : view === 'scaffold' ? (
          <Projects />
        ) : view === 'preview' ? (
          <Preview />
        ) : view === 'console' ? null : (
          <Settings />
        )}
        {/* Always mounted so the shell session and scrollback survive tab switches. */}
        <div className={view === 'console' ? 'terminal-host' : 'terminal-host hidden-view'}>
          <TerminalTabs active={view === 'console'} />
        </div>
      </main>
    </div>
  );
}
