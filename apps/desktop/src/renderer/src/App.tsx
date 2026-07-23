import { useEffect, useState } from 'react';
import { Icon } from './components/Icon';
import { VodoMark } from './components/VodoMark';
import { useStore, type View } from './state/store';
import { Agents } from './views/Agents';
import { Chat, fmtCost, fmtTokens } from './views/Chat';
import { TerminalTabs } from './views/Console';
import { Memory } from './views/Memory';
import { Missions } from './views/Missions';
import { Preview } from './views/Preview';
import { Scaffold } from './views/Scaffold';
import { Settings } from './views/Settings';

const NAV = [
  { id: 'chat', label: 'Chat', enabled: true },
  { id: 'agents', label: 'Agents', enabled: true },
  { id: 'missions', label: 'Missions', enabled: true },
  { id: 'memory', label: 'Memory', enabled: true },
  { id: 'scaffold', label: 'Scaffold', enabled: true },
  { id: 'preview', label: 'Preview', enabled: true },
  { id: 'console', label: 'Terminal', enabled: true },
  { id: 'settings', label: 'Settings', enabled: true },
] as const;

type DeleteTarget =
  | { kind: 'project'; id: string; name: string; chatCount: number }
  | { kind: 'session'; id: string; title: string };

/**
 * Guard rail for destructive sidebar actions: projects must have their name
 * typed back (chats are gone for good; the folder on disk is never touched),
 * chats get a plain confirm instead of dying to a stray click.
 */
function DeleteGuard({ target, onClose }: { target: DeleteTarget; onClose: () => void }) {
  const removeSession = useStore((s) => s.removeSession);
  const removeProject = useStore((s) => s.removeProject);
  const [typed, setTyped] = useState('');
  const isProject = target.kind === 'project';
  const armed = !isProject || typed.trim().toLowerCase() === target.name.trim().toLowerCase();

  const confirm = async () => {
    if (!armed) return;
    if (target.kind === 'project') await removeProject(target.id);
    else await removeSession(target.id);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{isProject ? 'Delete project' : 'Delete chat'}</h3>
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

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [naming, setNaming] = useState(false);
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
    setNaming(false);
  };

  return (
    <div className="projects-panel">
      <div className="projects-head">
        <span>Projects</span>
        <button className="chip-x" title="New project" onClick={() => setNaming(!naming)}>
          +
        </button>
      </div>
      {naming && (
        <div className="project-name-form">
          <input
            autoFocus
            value={name}
            placeholder="Project name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createProject();
              if (e.key === 'Escape') setNaming(false);
            }}
          />
          <button className="project-loc" title="Where the project folder is created" onClick={() => void pickParent()}>
            <Icon name="folder" size={12} /> {parent ? `…\\${parent.split(/[\\/]/).pop()}` : 'Choose location…'}
          </button>
          {name.trim() && parent && (
            <div className="project-loc-hint">creates {parent.split(/[\\/]/).pop()}\{name.trim()} and starts setup</div>
          )}
          <button className="send project-create" disabled={!name.trim() || !parent} onClick={() => void createProject()}>
            Create project
          </button>
          {createError && <div className="project-loc-hint error-text">{createError}</div>}
        </div>
      )}
      <div className="projects-list">
        {projects.map((project) => {
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
              {isOpen &&
                sessions.map((meta) => (
                  <div
                    key={meta.id}
                    className={`session-row ${meta.id === activeSessionId ? 'active' : ''}`}
                  >
                    <button className="session-title" onClick={() => void openSession(meta.id)}>
                      {meta.title}
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
                  </div>
                ))}
              {isOpen && sessions.length === 0 && (
                <div className="session-row empty">no chats yet</div>
              )}
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
  const mode = useStore((s) => s.config?.approvalMode ?? 'guided');
  const saveConfig = useStore((s) => s.saveConfig);
  const t = usage?.allTime ?? { inputTokens: 0, outputTokens: 0, cost: 0 };
  return (
    <div className="sidebar-footer usage-footer" title="All-time usage across all projects">
      <span className="usage-head">
        <span className="usage-label">Usage</span>
        <span
          className="mode-toggle"
          title="Auto: agents act autonomously — no permission prompts (destructive infra tools still require confirmation). Guided: approve every write/run."
        >
          <button
            className={mode === 'auto' ? 'on' : ''}
            onClick={() => void saveConfig({ approvalMode: 'auto' })}
          >
            Auto
          </button>
          <button
            className={mode === 'guided' ? 'on' : ''}
            onClick={() => void saveConfig({ approvalMode: 'guided' })}
          >
            Guided
          </button>
        </span>
      </span>
      <span className="usage-cost">{fmtCost(t.cost)}</span>
      <span>
        {fmtTokens(t.inputTokens)} in · {fmtTokens(t.outputTokens)} out
      </span>
    </div>
  );
}

export function App() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const init = useStore((s) => s.init);
  const updateInfo = useStore((s) => s.updateInfo);

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo">
          <VodoMark /> Vo-Coder
        </div>
        <nav>
          {NAV.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? 'active' : ''}`}
              disabled={!item.enabled}
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
        {view === 'chat' ? (
          <Chat />
        ) : view === 'agents' ? (
          <Agents />
        ) : view === 'missions' ? (
          <Missions />
        ) : view === 'memory' ? (
          <Memory />
        ) : view === 'scaffold' ? (
          <Scaffold />
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
