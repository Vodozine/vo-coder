import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { diffLines } from 'diff';
import hljs from 'highlight.js/lib/core';
import tsLang from 'highlight.js/lib/languages/typescript';
import jsLang from 'highlight.js/lib/languages/javascript';
import pyLang from 'highlight.js/lib/languages/python';
import rustLang from 'highlight.js/lib/languages/rust';
import goLang from 'highlight.js/lib/languages/go';
import javaLang from 'highlight.js/lib/languages/java';
import jsonLang from 'highlight.js/lib/languages/json';
import yamlLang from 'highlight.js/lib/languages/yaml';
import xmlLang from 'highlight.js/lib/languages/xml';
import cssLang from 'highlight.js/lib/languages/css';
import mdLang from 'highlight.js/lib/languages/markdown';
import bashLang from 'highlight.js/lib/languages/bash';
import psLang from 'highlight.js/lib/languages/powershell';
import 'highlight.js/styles/atom-one-dark.css';
import { isAudioPath } from '../../../shared/media';
import { useStore, type FileChangeState } from '../state/store';

hljs.registerLanguage('typescript', tsLang);
hljs.registerLanguage('javascript', jsLang);
hljs.registerLanguage('python', pyLang);
hljs.registerLanguage('rust', rustLang);
hljs.registerLanguage('go', goLang);
hljs.registerLanguage('java', javaLang);
hljs.registerLanguage('json', jsonLang);
hljs.registerLanguage('yaml', yamlLang);
hljs.registerLanguage('xml', xmlLang);
hljs.registerLanguage('css', cssLang);
hljs.registerLanguage('markdown', mdLang);
hljs.registerLanguage('bash', bashLang);
hljs.registerLanguage('powershell', psLang);

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rs: 'rust', go: 'go', java: 'java',
  json: 'json', yml: 'yaml', yaml: 'yaml',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  css: 'css', md: 'markdown', sh: 'bash', bash: 'bash', ps1: 'powershell',
};
const MAX_HIGHLIGHT_LINES = 3000;

function languageOf(path: string): string | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return LANG_BY_EXT[ext] ?? null;
}

/** Per-line highlighting: loses multi-line token context (block comments) but
 *  stays fast and plays well with diff-line rendering — same trade diff
 *  viewers make everywhere. */
function highlight(text: string, lang: string | null): string | null {
  if (!lang || !text) return null;
  try {
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

/** Last content this viewer has seen per file — fallback diff baseline when
 *  the project has no git. */
const lastSeen = new Map<string, string>();

/**
 * An audio file in the tree, played instead of read. The narration the agents
 * are generating is a file like any other in here — the difference is that
 * looking at it tells you nothing and listening to it tells you everything.
 */
function AudioFile({ root, path }: { root: string; path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setUrl(null);
    setError(null);
    const abs = `${root.replace(/[\\/]+$/, '')}/${path}`;
    void window.vo.videoRead(abs).then((r) => {
      if (!live) return;
      if (r.ok && r.data) setUrl(URL.createObjectURL(new Blob([r.data], { type: r.mimeType })));
      else setError(r.error ?? 'Could not open this file.');
    });
    return () => {
      live = false;
    };
  }, [root, path]);

  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );

  return (
    <div className="cw-audio">
      {error ? <div className="meta">🔊 {error}</div> : <audio src={url ?? undefined} controls />}
    </div>
  );
}

interface ViewLine {
  num: number | null;
  text: string;
  type: 'ctx' | 'add' | 'del';
}

function toViewLines(
  prev: string | undefined,
  next: string,
  state: FileChangeState | undefined,
): ViewLine[] {
  const lines: ViewLine[] = [];
  let num = 1;
  if (prev === undefined || prev === next) {
    // A brand-new file reviews as all-added.
    const type = state === 'added' ? 'add' : 'ctx';
    for (const text of next.split('\n')) lines.push({ num: num++, text, type });
    return lines;
  }
  for (const part of diffLines(prev, next)) {
    const partLines = part.value.split('\n');
    if (partLines[partLines.length - 1] === '') partLines.pop();
    for (const text of partLines) {
      if (part.removed) lines.push({ num: null, text, type: 'del' });
      else lines.push({ num: num++, text, type: part.added ? 'add' : 'ctx' });
    }
  }
  return lines;
}

// ---- tree building ----

interface TreeDir {
  dirs: Map<string, TreeDir>;
  files: Array<{ name: string; path: string; state: FileChangeState }>;
}

function buildTree(files: Record<string, FileChangeState>): TreeDir {
  const root: TreeDir = { dirs: new Map(), files: [] };
  for (const [path, state] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let child = node.dirs.get(parts[i]!);
      if (!child) {
        child = { dirs: new Map(), files: [] };
        node.dirs.set(parts[i]!, child);
      }
      node = child;
    }
    node.files.push({ name: parts[parts.length - 1]!, path, state });
  }
  return root;
}

function dirState(dir: TreeDir): FileChangeState {
  let state: FileChangeState = 'baseline';
  for (const f of dir.files) {
    if (f.state !== 'baseline' && f.state !== 'deleted') return f.state === 'added' ? 'added' : 'modified';
    if (f.state === 'deleted') state = 'modified';
  }
  for (const child of dir.dirs.values()) {
    const s = dirState(child);
    if (s !== 'baseline') return 'modified';
  }
  return state;
}

const BADGE: Record<FileChangeState, string> = {
  baseline: '',
  added: 'A',
  modified: 'M',
  deleted: 'D',
};

function Tree({
  dir,
  prefix,
  depth,
  expanded,
  toggle,
  activeFile,
  onOpen,
}: {
  dir: TreeDir;
  prefix: string;
  depth: number;
  expanded: Set<string>;
  toggle: (path: string) => void;
  activeFile: string | null;
  onOpen: (path: string) => void;
}) {
  return (
    <>
      {[...dir.dirs.entries()].map(([name, child]) => {
        const path = prefix ? `${prefix}/${name}` : name;
        const isOpen = expanded.has(path);
        const changed = dirState(child) !== 'baseline';
        return (
          <div key={path}>
            <button
              className={`tree-row dir ${changed ? 'changed' : ''}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => toggle(path)}
            >
              <span className="tree-arrow">{isOpen ? '▾' : '▸'}</span> {name}
            </button>
            {isOpen && (
              <Tree
                dir={child}
                prefix={path}
                depth={depth + 1}
                expanded={expanded}
                toggle={toggle}
                activeFile={activeFile}
                onOpen={onOpen}
              />
            )}
          </div>
        );
      })}
      {dir.files.map((file) => (
        <button
          key={file.path}
          className={`tree-row file st-${file.state} ${activeFile === file.path ? 'active' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => onOpen(file.path)}
        >
          <span className="tree-name">{file.name}</span>
          {BADGE[file.state] && <span className="tree-badge">{BADGE[file.state]}</span>}
        </button>
      ))}
    </>
  );
}

// ---- selection → AI ----

interface SelectionInfo {
  text: string;
  fromLine: number;
  toLine: number;
  x: number;
  y: number;
}

export function CodeWatch() {
  const watchRoot = useStore((s) => s.watchRoot);
  const watchReady = useStore((s) => s.watchReady);
  const watchFiles = useStore((s) => s.watchFiles);
  const watchGit = useStore((s) => s.watchGit);
  const gitStates = useStore((s) => s.gitStates);
  const watchLastChange = useStore((s) => s.watchLastChange);
  const startWatch = useStore((s) => s.startWatch);
  const stopWatch = useStore((s) => s.stopWatch);
  const send = useStore((s) => s.send);
  const setView = useStore((s) => s.setView);
  const activeProject = useStore((s) => s.projects.find((p) => p.id === s.activeProjectId));
  // The chat's attached folder wins over the project's — group chats in
  // General carry the whole workspace on the session, not the project.
  const sessionDir = useStore((s) => s.sessionMetas.find((m) => m.id === s.activeSessionId)?.dir);
  const genericDir = useStore((s) => s.config?.genericDir);
  const effectiveDir = sessionDir ?? activeProject?.dir ?? genericDir;

  const [follow, setFollow] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [viewLines, setViewLines] = useState<ViewLine[]>([]);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [suggestInput, setSuggestInput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Editing the file being watched. The diff view is the point of this pane, so
   * editing is a mode you enter rather than the default: `null` means reading.
   * A truncated read never becomes editable — saving half a file deletes the
   * other half.
   */
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const codeRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  /** The line you were reading when you pressed Edit, so edit and cancel both
   *  put you back there instead of at the top of the file. */
  const anchorLine = useRef<number | null>(null);
  const followRef = useRef(follow);
  followRef.current = follow;
  const activeLang = useMemo(() => (activeFile ? languageOf(activeFile) : null), [activeFile]);

  // Git repos show commit-truth (uncommitted changes vs HEAD, incl. files
  // deleted from disk); plain folders show session states.
  const effectiveFiles = useMemo(() => {
    if (!watchGit) return watchFiles;
    const merged: Record<string, FileChangeState> = {};
    for (const path of Object.keys(watchFiles)) merged[path] = gitStates[path] ?? 'baseline';
    for (const [path, state] of Object.entries(gitStates)) merged[path] = state;
    return merged;
  }, [watchGit, watchFiles, gitStates]);

  const tree = useMemo(() => buildTree(effectiveFiles), [effectiveFiles]);

  // Folder-backed work connects automatically: the code view follows the
  // chat's folder first, then the project's. Manual picking remains for the
  // truly folder-less case.
  useEffect(() => {
    if (effectiveDir && watchRoot !== effectiveDir) {
      setError(null);
      void startWatch(effectiveDir).then((err) => {
        if (err) setError(err);
      });
    } else if (!effectiveDir && watchRoot) {
      // Landing folder-less must stop the previous scan — otherwise the old
      // root keeps churning under an unrelated chat.
      void stopWatch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.id, effectiveDir]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const openFile = useCallback(
    async (path: string, state?: FileChangeState) => {
      setSelection(null);
      setSuggestInput(null);
      setDraft(null); // switching files leaves the editor, never carries a draft across
      setActiveFile(path);
      const s = useStore.getState();
      const effState =
        state ?? (s.watchGit ? (s.gitStates[path] ?? 'baseline') : s.watchFiles[path]);
      if (effState === 'deleted') {
        setViewLines([]);
        setFileNote('This file was deleted.');
        lastSeen.delete(path);
        return;
      }
      // A recording is listened to, not read. Opening one used to dump the
      // decoded bytes as text — a screen of garbage where the narration was.
      if (isAudioPath(path)) {
        setViewLines([]);
        setFileNote(null);
        return;
      }
      const result = await window.vo.watchReadFile(path);
      if (!result.ok || result.content === undefined) {
        setViewLines([]);
        setFileNote(result.error ?? 'Could not read file.');
        return;
      }
      setFileNote(result.truncated ? 'Preview truncated (large file).' : null);
      // Diff baseline: HEAD content in git repos (true review), else last-seen.
      let prev: string | undefined;
      if (s.watchGit) {
        const base = await window.vo.watchReadBaseline(path);
        prev = base.ok ? base.content : undefined;
      } else {
        prev = lastSeen.get(path);
      }
      setViewLines(toViewLines(prev, result.content, effState));
      lastSeen.set(path, result.content);
    },
    [],
  );

  // Follow mode: open whatever the agents just wrote and reveal its folder.
  useEffect(() => {
    if (!watchLastChange || !followRef.current) return;
    const { path } = watchLastChange;
    setExpanded((prev) => {
      const next = new Set(prev);
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join('/'));
      return next;
    });
    void openFile(path, watchLastChange.state);
  }, [watchLastChange, openFile]);

  // Scroll to the first changed line after a diff render.
  useEffect(() => {
    const first = codeRef.current?.querySelector('.cw-line.add, .cw-line.del');
    (first ?? codeRef.current?.firstElementChild)?.scrollIntoView({ block: 'center' });
  }, [viewLines]);

  /** The line number at the top of what you are reading right now. */
  const topVisibleLine = (): number | null => {
    const host = codeRef.current;
    if (!host) return null;
    const head = host.querySelector('.cw-filehead');
    const top = host.scrollTop + (head instanceof HTMLElement ? head.offsetHeight : 0);
    for (const el of host.querySelectorAll<HTMLElement>('.cw-line[data-line]')) {
      if (el.offsetTop + el.offsetHeight > top) return Number(el.dataset.line);
    }
    return null;
  };

  /**
   * Put a line back at the top of the textarea. A textarea has no line API and
   * wrapping makes line height unknowable, so the height of the text ABOVE the
   * line is measured the only way the browser will answer exactly: hand it the
   * prefix on its own, read scrollHeight, put the whole value straight back —
   * all inside one frame, so React never sees the swap.
   */
  const scrollEditorToLine = (line: number) => {
    const el = editorRef.current;
    if (!el) return;
    const full = el.value;
    const idx = full.split('\n').slice(0, Math.max(0, line - 1)).join('\n').length;
    el.setSelectionRange(idx, idx);
    el.value = full.slice(0, idx);
    const above = el.scrollHeight;
    el.value = full;
    // Below one screenful scrollHeight clamps to the box, which would read as
    // "scroll down" for a line that is already visible.
    el.scrollTop = above > el.clientHeight ? Math.max(0, above - el.clientHeight / 4) : 0;
  };

  const showLine = (line: number) => {
    requestAnimationFrame(() => {
      codeRef.current
        ?.querySelector(`.cw-line[data-line="${line}"]`)
        ?.scrollIntoView({ block: 'center' });
    });
  };

  // Entering edit mode keeps your place. autoFocus lands the caret at
  // character zero and the browser scrolls it into view, so without this you
  // are thrown to the top of the file and have to find your paragraph again.
  const editing = draft !== null;
  useEffect(() => {
    if (!editing || anchorLine.current === null) return;
    scrollEditorToLine(anchorLine.current);
  }, [editing]);

  const onMouseUp = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !codeRef.current) {
      setSelection(null);
      return;
    }
    const text = sel.toString();
    if (!text.trim()) return;
    const lineOf = (node: Node | null): number | null => {
      let el = node instanceof Element ? node : node?.parentElement;
      while (el && el !== codeRef.current) {
        const attr = el.getAttribute('data-line');
        if (attr) return Number(attr);
        el = el.parentElement;
      }
      return null;
    };
    const a = lineOf(sel.anchorNode);
    const b = lineOf(sel.focusNode);
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const host = codeRef.current.getBoundingClientRect();
    setSelection({
      text,
      fromLine: Math.min(a ?? 1, b ?? 1),
      toLine: Math.max(a ?? 1, b ?? 1),
      x: rect.left - host.left,
      y: rect.top - host.top + codeRef.current.scrollTop,
    });
  };

  const ask = (kind: 'explain' | 'rethink' | 'suggest', instruction?: string) => {
    if (!selection || !activeFile) return;
    const location = `${watchRoot}/${activeFile} (lines ${selection.fromLine}–${selection.toLine})`;
    const code = '```\n' + selection.text + '\n```';
    const prompt =
      kind === 'explain'
        ? `Explain this section of ${location} — what it does, why it's written this way, and anything fragile about it:\n\n${code}`
        : kind === 'rethink'
          ? `Rethink and redo this section of ${location}. Judge the approach, then rewrite it better — apply the change to the file with your tools if you can, otherwise show the full replacement:\n\n${code}`
          : `In ${location}, apply this change to the selected section: ${instruction}\n\nSelected code:\n${code}\n\nApply it to the file with your tools if you can, otherwise show the full replacement.`;
    setSelection(null);
    setSuggestInput(null);
    setView('chat');
    void send(prompt);
  };

  if (!watchRoot) {
    return (
      <div className="empty-state">
        <h2>Live code view</h2>
        <p>
          {effectiveDir
            ? `Connecting to ${
                sessionDir
                  ? (sessionDir.split(/[\\/]/).pop() ?? sessionDir)
                  : activeProject?.dir
                    ? activeProject.name
                    : `the generic folder (${effectiveDir.split(/[\\/]/).pop() ?? effectiveDir})`
              }…`
            : `"${activeProject?.name ?? 'This project'}" has no folder and this chat has none attached, so there's nothing to watch automatically. You can still point this anywhere:`}
        </p>
        {!effectiveDir && (
          <button
            className="send"
            onClick={async () => {
              const dir = await window.vo.scaffoldPickDir();
              if (dir) setError(await startWatch(dir));
            }}
          >
            Choose a folder…
          </button>
        )}
        {error && <p className="hint error-text">{error}</p>}
      </div>
    );
  }

  return (
    <div className="codewatch">
      <div className="preview-controls">
        <span className="meta grow">
          {activeProject?.dir === watchRoot && activeProject ? (
            <strong className="cw-project">{activeProject.name} · </strong>
          ) : null}
          {watchRoot}
          {watchReady ? '' : ' — scanning…'}
          {watchGit === true ? ' · git: changes vs last commit' : ''}
          {watchGit === false ? ' · no git: changes since watching started' : ''}
        </span>
        <label className="checkbox">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          follow changes
        </label>
        <span className="cw-legend">
          <i className="st-added">■ added</i> <i className="st-modified">■ modified</i>{' '}
          <i className="st-deleted">■ deleted</i>
        </span>
        <button className="ghost" onClick={() => void stopWatch()}>
          Close
        </button>
      </div>
      <div className="codewatch-body">
        <div className="cw-tree">
          <Tree
            dir={tree}
            prefix=""
            depth={0}
            expanded={expanded}
            toggle={toggle}
            activeFile={activeFile}
            onOpen={(p) => void openFile(p)}
          />
        </div>
        <div className={`cw-code${editing ? ' editing' : ''}`} ref={codeRef} onMouseUp={onMouseUp}>
          {activeFile ? (
            <>
              <div className="cw-filehead mono">
                {activeFile}
                {fileNote && <span className="error-text"> — {fileNote}</span>}
                <span className="grow" />
                {draft === null ? (
                  <button
                    className="ghost cw-edit"
                    // A truncated read is a partial file; saving it would drop
                    // the rest, so that one stays read-only. Neither is audio.
                    hidden={isAudioPath(activeFile)}
                    disabled={!!fileNote}
                    title={
                      fileNote
                        ? 'Not editable — this file was only partly loaded'
                        : 'Edit this file here and save it back'
                    }
                    onClick={() => {
                      const line = topVisibleLine();
                      void window.vo.watchReadFile(activeFile).then((r) => {
                        if (r.ok && r.content !== undefined) {
                          anchorLine.current = line;
                          setDraft(r.content);
                        } else setError(r.error ?? 'Could not open the file for editing.');
                      });
                    }}
                  >
                    Edit
                  </button>
                ) : (
                  <>
                    <button
                      className="send cw-edit"
                      disabled={saving}
                      onClick={() => {
                        setSaving(true);
                        void window.vo.watchWriteFile(activeFile, draft).then((r) => {
                          setSaving(false);
                          if (!r.ok) return setError(r.error ?? 'Could not save.');
                          setError(null);
                          setDraft(null);
                          // Re-read: the watcher fires and the diff redraws
                          // against what is now on disk.
                          void openFile(activeFile);
                        });
                      }}
                    >
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      className="ghost cw-edit"
                      onClick={() => {
                        const line = anchorLine.current;
                        setDraft(null);
                        if (line !== null) showLine(line);
                      }}
                    >
                      Cancel
                    </button>
                  </>
                )}
              </div>
              {draft !== null && (
                <textarea
                  className="cw-editor mono"
                  ref={editorRef}
                  spellCheck={false}
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // Ctrl+S saves; Tab indents instead of leaving the box.
                    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                      e.preventDefault();
                      const el = e.currentTarget;
                      setSaving(true);
                      void window.vo.watchWriteFile(activeFile, el.value).then((r) => {
                        setSaving(false);
                        if (!r.ok) return setError(r.error ?? 'Could not save.');
                        setError(null);
                        setDraft(null);
                        void openFile(activeFile);
                      });
                    } else if (e.key === 'Tab') {
                      e.preventDefault();
                      const el = e.currentTarget;
                      const { selectionStart: a, selectionEnd: b, value } = el;
                      setDraft(`${value.slice(0, a)}  ${value.slice(b)}`);
                      requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
                    }
                  }}
                />
              )}
              {isAudioPath(activeFile) && <AudioFile root={watchRoot} path={activeFile} />}
              {draft === null && viewLines.map((line, i) => {
                const html =
                  viewLines.length <= MAX_HIGHLIGHT_LINES
                    ? highlight(line.text, activeLang)
                    : null;
                return (
                  <div key={i} className={`cw-line ${line.type}`} data-line={line.num ?? undefined}>
                    <span className="cw-num">{line.num ?? '·'}</span>
                    {html !== null ? (
                      <span className="cw-text" dangerouslySetInnerHTML={{ __html: html }} />
                    ) : (
                      <span className="cw-text">{line.text || ' '}</span>
                    )}
                  </div>
                );
              })}
              {selection && (
                <div className="cw-toolbar" style={{ left: selection.x, top: selection.y - 40 }}>
                  {suggestInput === null ? (
                    <>
                      <button onClick={() => ask('explain')}>Explain</button>
                      <button onClick={() => ask('rethink')}>Rethink & redo</button>
                      <button onClick={() => setSuggestInput('')}>Suggest change</button>
                    </>
                  ) : (
                    <>
                      <input
                        autoFocus
                        placeholder="What should this do instead?"
                        value={suggestInput}
                        onChange={(e) => setSuggestInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && suggestInput.trim())
                            ask('suggest', suggestInput.trim());
                          if (e.key === 'Escape') setSuggestInput(null);
                        }}
                      />
                      <button
                        disabled={!suggestInput.trim()}
                        onClick={() => ask('suggest', suggestInput.trim())}
                      >
                        Send
                      </button>
                    </>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="empty-state">
              <p>
                {watchReady
                  ? 'Pick a file — or just let follow mode bring the action to you.'
                  : 'Scanning the project…'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
