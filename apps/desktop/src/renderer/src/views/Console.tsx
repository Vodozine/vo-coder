import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const THEME = {
  background: '#0f1115',
  foreground: '#e6e9ef',
  cursor: '#e8a33d',
  cursorAccent: '#0f1115',
  selectionBackground: 'rgba(232, 163, 61, 0.3)',
};

interface SessionApi {
  restart: (cwd: string) => void;
  focus: () => void;
}

function TerminalSession({
  visible,
  registerApi,
}: {
  visible: boolean;
  registerApi: (api: SessionApi | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const idRef = useRef<number>(-1);

  const startSession = useCallback(async (dir: string) => {
    const term = termRef.current;
    if (!term) return;
    if (idRef.current > 0) await window.vo.termKill(idRef.current);
    const { id } = await window.vo.termCreate({
      cwd: dir || undefined,
      cols: term.cols,
      rows: term.rows,
    });
    idRef.current = id;
    term.focus();
  }, []);

  useEffect(() => {
    const term = new XTerm({
      fontFamily: "'Cascadia Code', 'Consolas', monospace",
      fontSize: 13,
      theme: THEME,
      cursorBlink: true,
      scrollback: 8000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current!);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const offData = window.vo.onTermData(({ id, data }) => {
      if (id === idRef.current) term.write(data);
    });
    const offExit = window.vo.onTermExit(({ id, exitCode }) => {
      if (id === idRef.current) {
        term.write(`\r\n\x1b[2m[process exited with code ${exitCode} — Restart to relaunch]\x1b[0m\r\n`);
      }
    });
    term.onData((data) => {
      if (idRef.current > 0) void window.vo.termInput(idRef.current, data);
    });
    term.onResize(({ cols, rows }) => {
      if (idRef.current > 0) void window.vo.termResize(idRef.current, cols, rows);
    });

    void startSession(localStorage.getItem('vo-term-cwd') ?? '');
    registerApi({
      restart: (cwd) => void startSession(cwd),
      focus: () => term.focus(),
    });

    const observer = new ResizeObserver(() => {
      if (containerRef.current && containerRef.current.offsetWidth > 0) fit.fit();
    });
    observer.observe(containerRef.current!);

    return () => {
      registerApi(null);
      observer.disconnect();
      offData();
      offExit();
      if (idRef.current > 0) void window.vo.termKill(idRef.current);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        fitRef.current?.fit();
        termRef.current?.focus();
      });
    }
  }, [visible]);

  return (
    <div className={visible ? 'terminal-container' : 'terminal-container hidden-view'}>
      <div className="terminal-mount" ref={containerRef} />
    </div>
  );
}

export function TerminalTabs({ active }: { active: boolean }) {
  const [tabs, setTabs] = useState<number[]>([1]);
  const [current, setCurrent] = useState(1);
  const nextKey = useRef(2);
  const apis = useRef(new Map<number, SessionApi>());
  const [cwd, setCwd] = useState(() => localStorage.getItem('vo-term-cwd') ?? '');

  const addTab = () => {
    const key = nextKey.current++;
    setTabs((prev) => [...prev, key]);
    setCurrent(key);
  };

  const closeTab = (key: number) => {
    setTabs((prev) => {
      const next = prev.filter((k) => k !== key);
      if (next.length === 0) {
        // Always keep one session alive, VS Code style.
        const fresh = nextKey.current++;
        setCurrent(fresh);
        return [fresh];
      }
      if (key === current) setCurrent(next[next.length - 1]!);
      return next;
    });
  };

  const pickDir = async () => {
    const dir = await window.vo.scaffoldPickDir();
    if (dir) {
      setCwd(dir);
      localStorage.setItem('vo-term-cwd', dir);
      apis.current.get(current)?.restart(dir);
    }
  };

  return (
    <div className="terminal-view">
      <div className="terminal-tabbar">
        {tabs.map((key, i) => (
          <div key={key} className={`term-tab ${key === current ? 'active' : ''}`}>
            <button
              className="term-tab-label"
              onClick={() => {
                setCurrent(key);
                apis.current.get(key)?.focus();
              }}
            >
              ⌨ {i + 1}
            </button>
            <button className="chip-x" title="Close session" onClick={() => closeTab(key)}>
              ×
            </button>
          </div>
        ))}
        <button className="term-tab-add" title="New terminal" onClick={addTab}>
          +
        </button>
        <div className="spacer" />
        <span className="meta mono term-cwd">{cwd || '~'}</span>
        <button className="ghost" onClick={() => void pickDir()}>
          Folder…
        </button>
        <button className="ghost" onClick={() => apis.current.get(current)?.restart(cwd)}>
          Restart
        </button>
      </div>
      {tabs.map((key) => (
        <TerminalSession
          key={key}
          visible={active && key === current}
          registerApi={(api) => {
            if (api) apis.current.set(key, api);
            else apis.current.delete(key);
          }}
        />
      ))}
    </div>
  );
}
