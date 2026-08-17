/**
 * The file dialog, drawn here, for files that live on another machine.
 *
 * When Vodo runs on a different computer, a native dialog is the wrong tool:
 * Electron would draw it on the machine running the agent, which is not the
 * machine anybody is looking at. So the host asks this window instead, and
 * this browses the host's disk and answers in the same shape Electron would
 * have — which is why none of the fourteen handlers that open a dialog had to
 * change.
 */
import { useCallback, useEffect, useState } from 'react';
import type { HostFsEntry, HostFsListing } from '../../../shared/ipc-contract';
import { Icon } from './Icon';

interface OpenOptions {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
  properties?: string[];
  filters?: Array<{ name: string; extensions: string[] }>;
}

interface Request {
  kind: 'dialog:open' | 'dialog:save';
  options: OpenOptions;
  resolve: (value: unknown) => void;
}

/** Extensions this request will accept, or null for anything. */
function allowedExts(filters: OpenOptions['filters']): Set<string> | null {
  if (!filters?.length) return null;
  const all = filters.flatMap((f) => f.extensions).map((e) => e.toLowerCase());
  return all.includes('*') ? null : new Set(all);
}

const sizeLabel = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${Math.round(n / 1024)} KB`
      : n < 1024 * 1024 * 1024
        ? `${(n / 1024 / 1024).toFixed(1)} MB`
        : `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;

export function HostPicker(): React.ReactElement | null {
  const [req, setReq] = useState<Request | null>(null);
  const [listing, setListing] = useState<HostFsListing | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [saveName, setSaveName] = useState('');
  const [busy, setBusy] = useState(false);

  // Registered once. The host calls this whenever a handler wants a dialog;
  // the promise it returns is what the handler on the other machine is
  // sitting on, so it must settle exactly once, on cancel as well as choose.
  useEffect(() => {
    if (!window.vo.isRemote()) return;
    window.vo.setHostPicker(
      (kind, payload) =>
        new Promise((resolve) => {
          setReq({ kind: kind as Request['kind'], options: (payload ?? {}) as OpenOptions, resolve });
        }),
    );
  }, []);

  const browse = useCallback(async (path?: string) => {
    setBusy(true);
    try {
      const r = await window.vo.hostFsList(path);
      setListing(r);
      setSelected(null);
    } finally {
      setBusy(false);
    }
  }, []);

  // Start where the caller suggested, or at the host's known folders.
  useEffect(() => {
    if (!req) return;
    const start = req.options.defaultPath;
    setSaveName(start ? (start.split(/[\\/]/).pop() ?? '') : '');
    void browse(start ? start.replace(/[\\/][^\\/]*$/, '') : undefined);
  }, [req, browse]);

  if (!req) return null;

  const props = req.options.properties ?? [];
  const wantDir = props.includes('openDirectory');
  const multi = props.includes('multiSelections');
  const saving = req.kind === 'dialog:save';
  const exts = allowedExts(req.options.filters);

  const visible = (listing?.entries ?? []).filter((e) => {
    if (e.dir) return true;
    if (wantDir) return false;
    if (!exts) return true;
    return exts.has(e.name.split('.').pop()?.toLowerCase() ?? '');
  });

  const settle = (value: unknown): void => {
    req.resolve(value);
    setReq(null);
    setListing(null);
    setSelected(null);
  };

  const cancel = (): void =>
    settle(saving ? { canceled: true } : { canceled: true, filePaths: [] });

  const confirm = (): void => {
    if (saving) {
      const dir = listing?.path;
      if (!dir || !saveName.trim()) return;
      const sep = dir.includes('\\') ? '\\' : '/';
      settle({ canceled: false, filePath: `${dir}${sep}${saveName.trim()}` });
      return;
    }
    const chosen = wantDir ? (selected ?? listing?.path) : selected;
    if (!chosen) return;
    settle({ canceled: false, filePaths: [chosen] });
  };

  const activate = (e: HostFsEntry): void => {
    if (e.dir && !wantDir) void browse(e.path);
    else if (e.dir) setSelected(selected === e.path ? null : e.path);
    else if (saving) setSaveName(e.name);
    else setSelected(selected === e.path ? null : e.path);
  };

  const canConfirm = saving
    ? !!saveName.trim() && !!listing?.path
    : wantDir
      ? !!(selected ?? listing?.path)
      : !!selected;

  return (
    <div className="modal-backdrop" onClick={cancel}>
      <div className="settings-panel host-picker" onClick={(ev) => ev.stopPropagation()}>
        <h2>
          {req.options.title ??
            (saving ? 'Save on the main computer' : wantDir ? 'Choose a folder' : 'Choose a file')}
        </h2>
        <p className="hint">
          These are folders on the computer Vodo runs on, not this one.
          {multi ? ' (One at a time for now.)' : ''}
        </p>

        <div className="field-row">
          <button
            disabled={!listing?.parent || busy}
            title="Up one level"
            onClick={() => void browse(listing?.parent ?? undefined)}
          >
            ↑
          </button>
          <button disabled={busy} title="Starting points" onClick={() => void browse(undefined)}>
            Top
          </button>
          <code className="perm-tool grow">{listing?.path || 'starting points'}</code>
        </div>

        {listing && !listing.ok && <p className="hint">⚠ {listing.error}</p>}

        <div className="host-picker-list">
          {visible.length === 0 && !busy && <p className="hint">Nothing here to choose.</p>}
          {visible.map((e) => (
            <button
              key={e.path}
              type="button"
              className={`host-picker-row${selected === e.path ? ' active' : ''}`}
              onDoubleClick={() => e.dir && void browse(e.path)}
              onClick={() => activate(e)}
            >
              <Icon name={e.dir ? 'folder' : 'file'} />
              <span className="grow">{e.name}</span>
              {!e.dir && <span className="meta">{sizeLabel(e.size)}</span>}
            </button>
          ))}
        </div>

        {saving && (
          <div className="field-row">
            <label>save as</label>
            <input
              className="grow"
              value={saveName}
              onChange={(ev) => setSaveName(ev.target.value)}
              onKeyDown={(ev) => ev.key === 'Enter' && confirm()}
            />
          </div>
        )}

        <div className="modal-actions">
          <button onClick={cancel}>Cancel</button>
          <button className="primary" disabled={!canConfirm} onClick={confirm}>
            {saving ? 'Save' : wantDir ? 'Use this folder' : 'Choose'}
          </button>
        </div>
      </div>
    </div>
  );
}
