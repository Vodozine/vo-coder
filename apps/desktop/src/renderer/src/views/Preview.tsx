import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { CodeWatch } from './CodeWatch';

/**
 * Preview is two things: a live browser pane for the running app (dev-server
 * HMR) and a live code view that follows the work as files are written.
 */

function BrowserPreview() {
  const activeProject = useStore((s) => s.projects.find((p) => p.id === s.activeProjectId));
  const [url, setUrl] = useState('http://localhost:5173');
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  /** A bundler project that needs its dev server started. */
  const [devReady, setDevReady] = useState<{ command: string; port: number } | null>(null);
  const [startingDev, setStartingDev] = useState(false);
  const regionRef = useRef<HTMLDivElement>(null);

  const sendBounds = () => {
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

  // Auto-connect: resume whatever was showing; otherwise find the project's
  // running dev server, or fall back to its built/static index.html.
  useEffect(() => {
    void (async () => {
      const state = await window.vo.previewState();
      if (state.url) {
        setActive(state.url);
        if (!state.url.startsWith('file:')) setUrl(state.url);
        return;
      }
      if (!activeProject?.dir) return;
      setDetecting(true);
      setDevReady(null);
      const found = await window.vo.previewDetect(activeProject.dir);
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
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.id]);

  useEffect(() => {
    if (!active) return;
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
  }, [active]);

  const open = async () => {
    setError(null);
    const result = await window.vo.previewOpen(url.trim());
    if (!result.ok) {
      setError(result.error ?? 'Could not open preview.');
      return;
    }
    setActive(url.trim());
    requestAnimationFrame(sendBounds);
  };

  const close = async () => {
    await window.vo.previewClose();
    setActive(null);
    setDevReady(null);
  };

  const startDev = async () => {
    if (!activeProject?.dir) return;
    setError(null);
    setStartingDev(true);
    const result = await window.vo.previewStartDev(activeProject.dir);
    setStartingDev(false);
    if (result.ok && result.url) {
      setDevReady(null);
      setActive(result.url);
      setUrl(result.url);
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
        {active && (
          <>
            <button onClick={() => void window.vo.previewReload()}>Reload</button>
            <button className="ghost" onClick={() => void close()}>
              Close
            </button>
          </>
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
              ? `Looking for something to show in ${activeProject?.name ?? 'this project'}…`
              : activeProject?.dir
                ? `Nothing to show in ${activeProject.name} yet — no dev server running and no index.html built. As soon as the agents produce a page, this connects on its own; or point it at a URL above.`
                : "Point this at your project's dev server (Vite, Next, anything with hot reload) and watch the build render as the agents work on it."}
          </p>
        </div>
      )}
      <div ref={regionRef} className={`preview-region ${active ? 'active' : ''}`} />
    </>
  );
}

export function Preview() {
  const [mode, setMode] = useState<'browser' | 'code'>('code');

  return (
    <div className="preview-view">
      <div className="mode-switch">
        <button className={mode === 'code' ? 'active' : ''} onClick={() => setMode('code')}>
          Code
        </button>
        <button className={mode === 'browser' ? 'active' : ''} onClick={() => setMode('browser')}>
          Browser
        </button>
      </div>
      {mode === 'browser' ? <BrowserPreview /> : <CodeWatch />}
    </div>
  );
}
