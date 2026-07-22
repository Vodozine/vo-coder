import { useEffect, useRef, useState } from 'react';
import { CodeWatch } from './CodeWatch';

/**
 * Preview is two things: a live browser pane for the running app (dev-server
 * HMR) and a live code view that follows the work as files are written.
 */

function BrowserPreview() {
  const [url, setUrl] = useState('http://localhost:5173');
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => {
    void window.vo.previewState().then((s) => {
      if (s.url) {
        setActive(s.url);
        setUrl(s.url);
      }
    });
  }, []);

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
      {error && <p className="hint error-text preview-hint">{error}</p>}
      {!active && (
        <div className="empty-state">
          <h2>Live app preview</h2>
          <p>
            Point this at your project's dev server (Vite, Next, anything with hot reload) and
            watch the build render as the agents work on it.
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
