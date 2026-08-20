import { useCallback, useEffect, useState } from 'react';
import type {
  LifeBatchDto,
  LifeNoteDto,
  LifeProgressDto,
  LifeScanDto,
  LifeStateDto,
} from '../../../shared/ipc-contract';
import { Icon } from '../components/Icon';
import { ModelPicker } from '../components/ModelPicker';
import { useStore } from '../state/store';

const LIFE_KINDS = ['identity', 'preference', 'project', 'skill', 'fact', 'era'] as const;
const LIFE_STATUSES = ['active', 'superseded'] as const;
/** Providers that can hold the digester seat. Local ones read for free. */
const PROVIDERS = ['', 'ollama', 'lmstudio', 'llamacpp', 'flm', 'anthropic', 'openai', 'openrouter', 'xai', 'zai', 'nvidia', 'gemini'];
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'llamacpp', 'flm']);

function fmtTokens(n?: number): string {
  if (!n) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function fmtWhen(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 3_600_000) return `${Math.max(1, Math.round(delta / 60_000))}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function NoteCard({
  note,
  onStatus,
  onDelete,
}: {
  note: LifeNoteDto;
  onStatus: (status: string) => void;
  onDelete: () => void;
}) {
  return (
    <div className={`mem-node st-${note.status}`}>
      <div className="mem-node-head">
        <span className={`mem-type t-${note.kind}`}>{note.kind}</span>
        <strong className="grow">{note.title}</strong>
        <select
          value={note.status}
          title="Superseded notes leave Vodo's briefing but stay searchable"
          onChange={(e) => onStatus(e.target.value)}
        >
          {LIFE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button className="ghost" title="Delete note" onClick={onDelete}>
          <Icon name="x" size={13} />
        </button>
      </div>
      {note.body && <p className="mem-body">{note.body}</p>}
      <div className="meta">
        <span className="life-src">{note.source}</span>
        {note.period && <span> · {note.period}</span>}
        {note.tags && <span> · #{note.tags}</span>}
        <span> · {fmtWhen(note.updatedAt)}</span>
      </div>
    </div>
  );
}

/**
 * Memory → Archives: import a personal chat-export dump (ChatGPT, Claude,
 * Gemini Takeout) and dilute it into provenance-stamped life notes. The scan
 * stage is free code — the price tag shows BEFORE any model runs.
 */
export function LifeArchives() {
  const catalog = useStore((s) => s.catalog);
  const send = useStore((s) => s.send);
  const setView = useStore((s) => s.setView);

  const [state, setState] = useState<LifeStateDto | null>(null);
  const [notes, setNotes] = useState<LifeNoteDto[]>([]);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);

  // The import flow: pick → scan (free) → choose depth+model → start.
  const [path, setPath] = useState('');
  const [scan, setScan] = useState<LifeScanDto | null>(null);
  const [depth, setDepth] = useState<'deep' | 'skim'>('deep');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [progress, setProgress] = useState<LifeProgressDto | null>(null);
  const [startErr, setStartErr] = useState('');
  const [armedDelete, setArmedDelete] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const [st, list] = await Promise.all([
      window.vo.lifeState(),
      window.vo.lifeNotes({
        ...(query.trim() ? { query: query.trim() } : {}),
        ...(kind ? { kind } : {}),
        includeInactive,
      }),
    ]);
    setState(st);
    setNotes(list);
  }, [query, kind, includeInactive]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return window.vo.onLifeProgress((ev) => {
      setProgress(ev);
      if (ev.phase !== 'reading' && ev.phase !== 'final') void refresh();
    });
  }, [refresh]);

  const pick = async () => {
    const { path: picked } = await window.vo.lifePickFile();
    if (!picked) return;
    setPath(picked);
    setScan(null);
    setStartErr('');
    setScan(await window.vo.lifeScan(picked));
  };

  const start = async (resumeBatchId?: number, resumePath?: string, resumeDepth?: string) => {
    setStartErr('');
    const res = await window.vo.lifeStart(resumePath ?? path, {
      depth: (resumeDepth === 'skim' ? 'skim' : resumeDepth === 'deep' ? 'deep' : depth),
      ...(provider && model ? { provider, model } : {}),
      ...(resumeBatchId !== undefined ? { resumeBatchId } : {}),
    });
    if (!res.ok) setStartErr(res.error ?? 'Could not start.');
    else {
      setProgress(null);
      await refresh();
    }
  };

  const estCost = (tokens?: number): string => {
    if (!tokens) return '';
    if (provider && LOCAL_PROVIDERS.has(provider)) return 'free on your own hardware';
    if (provider && model) {
      const bare = model.split('@')[0];
      const rec = catalog?.records.find((r) => r.id === bare || r.id === model);
      const price = rec?.pricing?.inputPerMTok;
      if (price !== undefined) {
        const usd = (tokens / 1_000_000) * price;
        return usd < 0.01 ? 'under $0.01' : `≈ $${usd.toFixed(2)}`;
      }
      return '';
    }
    return 'cheap-routed — pennies on cloud, free on local';
  };

  const running = !!state?.running || progress?.phase === 'reading' || progress?.phase === 'final';
  const doneBatch = state?.batches.find((b) => b.status === 'done' && b.summary);

  return (
    <>
      <p className="hint">
        Bring your history with other assistants home: import the personal-data export from
        ChatGPT, Claude, or Google (Gemini), and it is diluted into life notes — durable knowledge
        about you, each note stamped with the archive it came from. Vodo knows those chats and
        projects never happened here: there is no transcript, only what they taught him about you.
      </p>

      <div className="life-import">
        {!running && (
          <div className="field-row">
            <button onClick={() => void pick()}>Choose export file…</button>
            {path && <span className="meta grow">{baseName(path)}</span>}
          </div>
        )}
        {scan && !scan.ok && <p className="error">{scan.error}</p>}
        {scan?.ok && !running && (
          <>
            <p className="meta">
              {scan.sourceLabel} export · {scan.chatsFound} chats found, {scan.chatsKept} worth
              reading{scan.span ? ` · ${scan.span}` : ''}
            </p>
            <div className="field-row">
              <label className="checkbox" title="Every kept chat, trimmed — the full picture">
                <input
                  type="radio"
                  name="life-depth"
                  checked={depth === 'deep'}
                  onChange={() => setDepth('deep')}
                />
                deep read — ≈{fmtTokens(scan.estTokensDeep)} tokens
                {estCost(scan.estTokensDeep) ? ` (${estCost(scan.estTokensDeep)})` : ''}
              </label>
              <label className="checkbox" title="Titles and opening messages only — a tenth of the reading">
                <input
                  type="radio"
                  name="life-depth"
                  checked={depth === 'skim'}
                  onChange={() => setDepth('skim')}
                />
                skim — ≈{fmtTokens(scan.estTokensSkim)} tokens
                {estCost(scan.estTokensSkim) ? ` (${estCost(scan.estTokensSkim)})` : ''}
              </label>
            </div>
            <div className="field-row">
              <label>reader</label>
              <select
                value={provider}
                title="Which model grinds through the archive — extraction work, so cheap/local is ideal. Vodo's own model always writes the final summary."
                onChange={(e) => {
                  setProvider(e.target.value);
                  setModel('');
                }}
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p || 'auto (cheapest adequate)'}
                  </option>
                ))}
              </select>
              {provider && (
                <ModelPicker
                  provider={provider}
                  value={model}
                  onChange={setModel}
                  placeholder="pick a model"
                />
              )}
              <button disabled={!!provider && !model} onClick={() => void start()}>
                Start reading
              </button>
            </div>
          </>
        )}
        {startErr && <p className="error">{startErr}</p>}
        {running && !progress && state?.running && (
          <div className="life-progress">
            <div className="life-bar">
              <div
                className="life-bar-fill"
                style={{
                  width: `${state.running.total ? Math.round((state.running.processed / state.running.total) * 100) : 0}%`,
                }}
              />
            </div>
            <span className="meta grow">
              reading {state.running.processed}/{state.running.total} chats
            </span>
            <button onClick={() => void window.vo.lifeCancel()}>Stop</button>
          </div>
        )}
        {running && progress && (
          <div className="life-progress">
            <div className="life-bar">
              <div
                className="life-bar-fill"
                style={{
                  width: `${progress.total ? Math.round((progress.processed / progress.total) * 100) : 0}%`,
                }}
              />
            </div>
            <span className="meta grow">
              {progress.phase === 'final'
                ? 'Vodo is writing what he learned…'
                : `reading ${progress.processed}/${progress.total} chats · ${progress.notes} notes shaped`}
            </span>
            <button onClick={() => void window.vo.lifeCancel()}>Stop</button>
          </div>
        )}
        {!running && progress?.phase === 'done' && progress.summary && (
          <div className="life-summary">
            <p>{progress.summary}</p>
            <button
              onClick={() => {
                setView('chat');
                void send(
                  'I just imported one of my chat archives into your life memory — tell me what you learned about me.',
                );
              }}
            >
              Discuss in chat
            </button>
          </div>
        )}
      </div>

      {(state?.batches.length ?? 0) > 0 && (
        <div className="life-batches">
          {state!.batches.map((b: LifeBatchDto) => (
            <div key={b.id} className="life-batch">
              <div className="field-row">
                <span className="life-src">{b.source}</span>
                <strong className="grow" title={b.file}>
                  {baseName(b.file)}
                </strong>
                <span className="meta">
                  {b.status === 'running'
                    ? `reading ${b.cursor}/${b.chatsTotal}`
                    : `${b.status} · ${b.cursor}/${b.chatsTotal} chats · ${b.notes} notes`}
                  {' · '}
                  {b.depth} · {b.model} · {fmtWhen(b.startedAt)}
                </span>
                {(b.status === 'canceled' || b.status === 'error') && (
                  <button
                    title="Continue from where it stopped — already-read chats are not re-read"
                    onClick={() => void start(b.id, b.file, b.depth)}
                  >
                    Resume
                  </button>
                )}
                {b.status !== 'running' &&
                  (armedDelete === b.id ? (
                    <button
                      className="danger"
                      onClick={() => {
                        setArmedDelete(null);
                        void window.vo.lifeBatchDelete(b.id).then(refresh);
                      }}
                    >
                      Really delete run + its notes?
                    </button>
                  ) : (
                    <button className="ghost" title="Delete this run and the notes it created" onClick={() => setArmedDelete(b.id)}>
                      <Icon name="x" size={13} />
                    </button>
                  ))}
              </div>
              {b.error && <p className="error">{b.error}</p>}
              {b.summary && <p className="life-batch-summary">{b.summary}</p>}
            </div>
          ))}
        </div>
      )}

      <div className="field-row mem-controls">
        <input
          className="grow"
          placeholder="Search life notes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">all kinds</option>
          {LIFE_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          show superseded
        </label>
        <span className="meta">{state ? `${state.noteCount} life notes` : ''}</span>
      </div>

      {notes.length === 0 ? (
        <div className="empty-state left">
          <p>
            {query || kind
              ? 'No life notes match.'
              : doneBatch
                ? 'All notes filtered out.'
                : 'Nothing imported yet. Export your data from ChatGPT (Settings → Data controls), Claude (Settings → Export data), or Google Takeout (Gemini Apps activity, JSON), then choose the file above.'}
          </p>
        </div>
      ) : (
        <div className="mem-grid">
          {notes.map((n) => (
            <NoteCard
              key={n.id}
              note={n}
              onStatus={(s) => void window.vo.lifeNoteStatus(n.id, s).then(refresh)}
              onDelete={() => void window.vo.lifeNoteDelete(n.id).then(refresh)}
            />
          ))}
        </div>
      )}
    </>
  );
}
