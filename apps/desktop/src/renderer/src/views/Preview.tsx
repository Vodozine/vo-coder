import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { Chat } from './Chat';
import { CodeWatch } from './CodeWatch';

/**
 * Preview shows one of two things — a live browser pane for the running app
 * (dev-server HMR) or a live code view that follows the work as files are
 * written — and Split decides whether the chat sits beside it. Code/Browser
 * always picks WHAT is on the right; Split only picks whether the chat is
 * there too, so every combination is reachable.
 */

/** localStorage is best-effort: a private-mode window still works, it just
 *  forgets the layout between visits. */
function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function BrowserPreview({ suspend = false }: { suspend?: boolean }) {
  const activeProject = useStore((s) => s.projects.find((p) => p.id === s.activeProjectId));
  // Same cascade the workspace tools use in main: the chat's attached folder
  // wins over the project's. Group chats (General has no dir) live entirely
  // on the attached folder — without this, Preview had nothing to show and
  // the user loaded the folder by hand mid-group.
  const sessionDir = useStore((s) => s.sessionMetas.find((m) => m.id === s.activeSessionId)?.dir);
  // Floor of the cascade: the app's generic scratch folder, so a folder-less
  // chat's outputs (a file, an image) still have somewhere to show up.
  const genericDir = useStore((s) => s.config?.genericDir);
  const dir = sessionDir ?? activeProject?.dir ?? genericDir;
  const dirLabel = sessionDir
    ? (sessionDir.split(/[\\/]/).pop() ?? sessionDir)
    : activeProject?.dir
      ? activeProject.name
      : dir
        ? (dir.split(/[\\/]/).pop() ?? dir)
        : undefined;
  const [url, setUrl] = useState('http://localhost:5173');
  const [active, setActive] = useState<string | null>(null);
  /** True while the harness owns a live dev-server process for the preview. */
  const [devRunning, setDevRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  /** A bundler project that needs its dev server started. */
  const [devReady, setDevReady] = useState<{ command: string; port: number } | null>(null);
  const [startingDev, setStartingDev] = useState(false);
  const regionRef = useRef<HTMLDivElement>(null);
  // Ref, not just the prop: detect()/open() schedule requestAnimationFrame
  // callbacks whose closures predate the drag — a slow previewDetect landing
  // mid-drag would reattach the overlay under the captured pointer.
  const suspendRef = useRef(suspend);
  suspendRef.current = suspend;

  const sendBounds = () => {
    if (suspendRef.current) return;
    const rect = regionRef.current?.getBoundingClientRect();
    if (rect) {
      void window.vo.previewBounds({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
    }
  };

  /** Find something to show for the current project (fresh look, no resume):
   * a running dev server, a startable one, or a static index.html. */
  const detect = async () => {
    if (!dir) return;
    setDetecting(true);
    setDevReady(null);
    const found = await window.vo.previewDetect(dir);
    setDetecting(false);
    if (found.kind === 'url') {
      const result = await window.vo.previewOpen(found.url);
      if (result.ok) {
        setActive(found.url);
        setUrl(found.url);
        requestAnimationFrame(sendBounds);
      }
    } else if (found.kind === 'dev') {
      // Bundler project — don't load a blank disk index.html; offer to start
      // the dev server that actually renders it.
      setDevReady({ command: found.command, port: found.port });
      setUrl(`http://localhost:${found.port}`);
    } else if (found.kind === 'file') {
      const result = await window.vo.previewOpenFile(found.path);
      if (result.ok) {
        setActive(`file • ${found.path}`);
        requestAnimationFrame(sendBounds);
      }
    }
  };

  // Auto-connect: resume whatever was showing (the main process has already
  // verified its server still answers — a dead page never resumes); otherwise
  // detect fresh for this project.
  useEffect(() => {
    void (async () => {
      const state = await window.vo.previewState();
      setDevRunning(state.devRunning);
      if (state.url) {
        setActive(state.url);
        if (!state.url.startsWith('file:')) setUrl(state.url);
        return;
      }
      await detect();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.id, dir]);

  useEffect(() => {
    // suspend (divider drag) runs the same cleanup as leaving browser mode:
    // the native overlay would otherwise swallow pointer events mid-drag, so
    // it detaches for the duration and the false-edge re-run reattaches it
    // at the final rect.
    if (!active || suspend) return;
    sendBounds();
    const observer = new ResizeObserver(sendBounds);
    if (regionRef.current) observer.observe(regionRef.current);
    window.addEventListener('resize', sendBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', sendBounds);
      // Leaving browser mode hides the pane but keeps the page loaded.
      void window.vo.previewHide();
    };
  }, [active, suspend]);

  const open = async () => {
    setError(null);
    const target = url.trim();
    const result = await window.vo.previewOpen(target);
    if (!result.ok) {
      setError(result.error ?? 'Could not open preview.');
      return;
    }
    setActive(target);
    requestAnimationFrame(sendBounds);
  };

  const close = async () => {
    await window.vo.previewClose();
    setActive(null);
    setDevReady(null);
    setDevRunning(false);
  };

  /** Kill the dev server behind the preview, then look again — lands on the
   * project's "Start dev server" offer instead of a dead pane. */
  const stopServer = async () => {
    setError(null);
    await window.vo.previewStopDev();
    setActive(null);
    setDevRunning(false);
    await detect();
  };

  const startDev = async () => {
    if (!dir) return;
    setError(null);
    setStartingDev(true);
    const result = await window.vo.previewStartDev(dir);
    setStartingDev(false);
    if (result.ok && result.url) {
      setDevReady(null);
      setActive(result.url);
      setUrl(result.url);
      setDevRunning(true);
      requestAnimationFrame(sendBounds);
    } else {
      setError(
        (result.error ?? 'Could not start the dev server.') +
          (result.log ? `\n\n${result.log.slice(-600)}` : ''),
      );
    }
  };

  return (
    <>
      <div className="preview-controls">
        <input
          className="grow"
          value={url}
          placeholder="http://localhost:5173"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void open();
          }}
        />
        <button className="send" onClick={() => void open()}>
          {active ? 'Go' : 'Open'}
        </button>
        {active && <button onClick={() => void window.vo.previewReload()}>Reload</button>}
        {devRunning && (
          <button
            className="ghost"
            title="Kill the dev server behind this preview"
            onClick={() => void stopServer()}
          >
            Stop server
          </button>
        )}
        {active && (
          <button className="ghost" onClick={() => void close()}>
            Close
          </button>
        )}
      </div>
      {error && <p className="hint error-text preview-hint" style={{ whiteSpace: 'pre-wrap' }}>{error}</p>}
      {active?.startsWith('file • ') && (
        <p className="hint preview-hint">
          Showing the project's page directly: {active.slice(7)} — reload after changes, or start a
          dev server for hot reload.
        </p>
      )}
      {!active && devReady && (
        <div className="empty-state">
          <h2>This app needs its dev server</h2>
          <p>
            {activeProject?.name} is a bundler project (React/Vite and friends). Its page is built
            live by a dev server — opening the file directly shows a blank screen. Start it and the
            preview connects on its own.
          </p>
          <p className="hint">
            Will run <code>{devReady.command}</code> and wait for{' '}
            <code>http://localhost:{devReady.port}</code>.
          </p>
          <button className="send" disabled={startingDev} onClick={() => void startDev()}>
            {startingDev ? 'Starting dev server…' : 'Start dev server'}
          </button>
        </div>
      )}
      {!active && !devReady && (
        <div className="empty-state">
          <h2>Live app preview</h2>
          <p>
            {detecting
              ? `Looking for something to show in ${dirLabel ?? 'this project'}…`
              : dir
                ? `Nothing to show in ${dirLabel ?? 'this folder'} yet — no dev server running and no index.html built. As soon as the agents produce a page, this connects on its own; or point it at a URL above.`
                : "Point this at your project's dev server (Vite, Next, anything with hot reload) and watch the build render as the agents work on it."}
          </p>
        </div>
      )}
      <div ref={regionRef} className={`preview-region ${active ? 'active' : ''}`} />
    </>
  );
}

/**
 * The user's standing rules, editable in the app. Deliberately a plain
 * monospace box and not the highlighted code view: that one follows files as
 * agents change them, and this file is the one thing here they must never
 * touch — it is the user's half of the agreement.
 */
function GlobalRulesEditor() {
  const close = useStore((s) => s.closeGlobalRules);
  const [path, setPath] = useState('');
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.vo.globalRulesRead().then((r) => {
      setPath(r.path);
      setText(r.text);
      setLoaded(true);
    });
  }, []);

  const save = async () => {
    const res = await window.vo.globalRulesWrite(text);
    if (res.ok) {
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } else {
      setError(res.error ?? 'Could not save.');
    }
  };

  return (
    <div className="rules-editor">
      <div className="rules-editor-bar">
        <strong>Your rules</strong>
        <span className="meta grow">{path}</span>
        {error && <span className="meta error-text">{error}</span>}
        <button className="send" disabled={!dirty} onClick={() => void save()}>
          {saved ? 'Saved ✓' : dirty ? 'Save' : 'Saved'}
        </button>
        <button className="ghost" onClick={close}>
          Close
        </button>
      </div>
      <textarea
        className="rules-editor-text"
        spellCheck={false}
        value={loaded ? text : 'Loading…'}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
        }}
        // Ctrl+S is the muscle memory for a text box that owns a file.
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            if (dirty) void save();
          }
        }}
      />
      <p className="hint">
        Every agent reads this before working, in every folder. A project’s own VO-CODER.md is
        more specific and wins where the two disagree. Agents never edit this file.
      </p>
    </div>
  );
}

export function Preview() {
  const editingRules = useStore((s) => s.editGlobalRules);
  // What the pane shows. Remembered across view switches: this component
  // unmounts on every trip to Chat/Settings, and re-picking Browser each time
  // is the same papercut the group grid's per-page pick had.
  const [mode, setMode] = useState<'browser' | 'code'>(() =>
    localStorage.getItem('vo-preview-mode') === 'browser' ? 'browser' : 'code',
  );
  const pickMode = (m: 'browser' | 'code') => {
    setMode(m);
    remember('vo-preview-mode', m);
  };
  // Whether the chat sits beside it, and where the divider rests.
  const [split, setSplit] = useState(() => localStorage.getItem('vo-preview-split-on') === '1');
  const [ratio, setRatio] = useState(() => {
    const stored = Number(localStorage.getItem('vo-preview-split'));
    return Number.isFinite(stored) && stored >= 0.25 && stored <= 0.75 ? stored : 0.5;
  });
  const [dragging, setDragging] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);
  // Written at computation time, not render time — pointerup can outrun the
  // last pointermove's re-render, and the persisted ratio must be the one
  // the user actually released at.
  const ratioRef = useRef(ratio);

  const dragTo = (clientX: number) => {
    const rect = splitRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const next = Math.min(0.75, Math.max(0.25, (clientX - rect.left) / rect.width));
    ratioRef.current = next;
    setRatio(next);
  };
  const endDrag = () => {
    setDragging(false);
    remember('vo-preview-split', String(ratioRef.current));
  };

  // Whatever is on the right, in both layouts. Only the browser pane needs
  // the drag suspend — CodeWatch is plain DOM, so it resizes live.
  // The rules editor takes the pane over when Settings sends us here: it is
  // the one thing in Preview that is written rather than watched.
  const pane = editingRules ? (
    <GlobalRulesEditor />
  ) : mode === 'browser' ? (
    <BrowserPreview suspend={split && dragging} />
  ) : (
    <CodeWatch />
  );

  return (
    <div className="preview-view">
      <div className="mode-switch">
        <button className={mode === 'code' ? 'active' : ''} onClick={() => pickMode('code')}>
          Code
        </button>
        <button className={mode === 'browser' ? 'active' : ''} onClick={() => pickMode('browser')}>
          Browser
        </button>
        <span className="mode-switch-sep" />
        <button
          className={`split-toggle${split ? ' active' : ''}`}
          title={
            split
              ? 'Hide the chat — the pane goes full width'
              : `Put the chat beside the ${mode === 'browser' ? 'browser' : 'code'} pane — drag the center line to resize`
          }
          onClick={() => {
            setSplit(!split);
            remember('vo-preview-split-on', split ? '0' : '1');
          }}
        >
          ◫ Split{split ? ' on' : ''}
        </button>
      </div>
      {split ? (
        <div className="preview-split" ref={splitRef}>
          <div className="split-chat" style={{ width: `${ratio * 100}%` }}>
            <Chat />
          </div>
          {/* With Browser on the right the pane is a NATIVE view above the
              renderer — once the pointer crosses it, our events stop. So the
              drag detaches the overlay (suspend) and works against the
              checkered placeholder; release reattaches at the final rect. */}
          <div
            className={`split-divider${dragging ? ' dragging' : ''}`}
            title="Drag to resize"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              setDragging(true);
            }}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) dragTo(e.clientX);
            }}
            onPointerUp={endDrag}
            onLostPointerCapture={endDrag}
          />
          <div className="split-preview">{pane}</div>
        </div>
      ) : (
        pane
      )}
    </div>
  );
}
