import { useEffect } from 'react';
import { useStore, type View } from './state/store';
import { Agents } from './views/Agents';
import { Chat } from './views/Chat';
import { TerminalTabs } from './views/Console';
import { Preview } from './views/Preview';
import { Scaffold } from './views/Scaffold';
import { Settings } from './views/Settings';

const NAV = [
  { id: 'chat', label: 'Chat', enabled: true },
  { id: 'agents', label: 'Agents', enabled: true },
  { id: 'scaffold', label: 'Scaffold', enabled: true },
  { id: 'preview', label: 'Preview', enabled: true },
  { id: 'console', label: 'Terminal', enabled: true },
  { id: 'settings', label: 'Settings', enabled: true },
] as const;

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
          <span className="logo-mark">▞</span> Vo-Coder
        </div>
        <nav>
          {NAV.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? 'active' : ''}`}
              disabled={!item.enabled}
              title={item.enabled ? undefined : 'Coming in a later phase'}
              onClick={() => item.enabled && setView(item.id as View)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        {updateInfo?.state === 'downloaded' && (
          <button className="update-chip" onClick={() => void window.vo.updateInstall()}>
            ⬆ Update ready — restart
          </button>
        )}
        <div className="sidebar-footer">the tool shed</div>
      </aside>
      <main className="content">
        {view === 'chat' ? (
          <Chat />
        ) : view === 'agents' ? (
          <Agents />
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
