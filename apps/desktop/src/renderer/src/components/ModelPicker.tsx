import { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelInfo } from '@vo-coder/providers';
import { useStore } from '../state/store';

interface Row {
  id: string;
  name: string;
  ctx?: number;
  inPrice?: number;
  outPrice?: number;
  quality?: number;
  local: boolean;
  fits?: boolean;
}

/**
 * Model dropdown with search, price columns, and price sorting — comparing
 * cost is the point of the whole harness, so the numbers sit right in the
 * picker instead of hiding in provider dashboards.
 */
export function ModelPicker({
  provider,
  value,
  onChange,
  placeholder,
}: {
  provider: string;
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
}) {
  const catalog = useStore((s) => s.catalog);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [byPrice, setByPrice] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setModels([]);
    setFailed(false);
    window.vo
      .listModels(provider)
      .then((list) => {
        if (!cancelled) setModels(list);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!hostRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, []);

  const rows = useMemo<Row[]>(() => {
    const list = models.map((m) => {
      const rec = catalog?.records.find((r) => r.id === m.id);
      const inPrice = rec?.pricing?.inputPerMTok;
      const outPrice = rec?.pricing?.outputPerMTok;
      const valid = inPrice !== undefined && inPrice >= 0 && (outPrice ?? 0) >= 0;
      return {
        id: m.id,
        name: rec?.displayName ?? m.displayName ?? m.id,
        ctx: rec?.contextLength ?? m.contextLength,
        inPrice: valid ? inPrice : undefined,
        outPrice: valid ? outPrice : undefined,
        quality: rec?.quality,
        local: rec?.estMemGb !== undefined || provider === 'ollama' || provider === 'lmstudio',
        fits: rec?.fit?.fits,
      };
    });
    const q = query.trim().toLowerCase();
    const filtered = q
      ? list.filter(
          (r) =>
            r.id.toLowerCase().includes(q) ||
            r.name.toLowerCase().includes(q) ||
            (q === 'free' && (r.inPrice === 0 || r.local)),
        )
      : list;
    if (byPrice) {
      return [...filtered].sort(
        (a, b) => (a.local ? 0 : (a.inPrice ?? 1e9)) - (b.local ? 0 : (b.inPrice ?? 1e9)),
      );
    }
    return filtered;
  }, [models, catalog, query, byPrice, provider]);

  const price = (r: Row) =>
    r.local ? 'local · $0' : r.inPrice !== undefined ? `$${r.inPrice}/$${r.outPrice}` : '—';

  if (failed || (models.length === 0 && !open)) {
    // Free-text fallback (no key / server down) — still fully usable.
    return (
      <input
        className="grow"
        value={value}
        placeholder={placeholder ?? 'model id'}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <div className="model-picker grow" ref={hostRef}>
      <button className="model-picker-value" onClick={() => setOpen(!open)}>
        {value || placeholder || 'pick a model'} <span className="tree-arrow">▾</span>
      </button>
      {open && (
        <div className="model-picker-panel">
          <div className="model-picker-controls">
            <input
              autoFocus
              placeholder='search… (try "free")'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setOpen(false);
                if (e.key === 'Enter' && rows[0]) {
                  onChange(rows[0].id);
                  setOpen(false);
                }
              }}
            />
            <button
              className={`ghost ${byPrice ? 'thinking-on' : ''}`}
              title="Sort cheapest first"
              onClick={() => setByPrice(!byPrice)}
            >
              $↑
            </button>
          </div>
          <div className="model-picker-head">
            <span className="mp-name">model</span>
            <span className="mp-ctx">ctx</span>
            <span className="mp-price">$in/$out per MTok</span>
          </div>
          <div className="model-picker-list">
            {rows.map((r) => (
              <button
                key={r.id}
                className={`model-picker-row ${r.id === value ? 'active' : ''}`}
                onClick={() => {
                  onChange(r.id);
                  setOpen(false);
                }}
              >
                <span className="mp-name" title={r.id}>
                  {r.name}
                  {r.quality !== undefined && <em> q{r.quality}</em>}
                  {r.local && r.fits === false && <em className="st-deleted"> too big</em>}
                </span>
                <span className="mp-ctx">{r.ctx ? `${Math.round(r.ctx / 1000)}k` : ''}</span>
                <span className="mp-price">{price(r)}</span>
              </button>
            ))}
            {rows.length === 0 && <div className="hint mp-empty">no matches</div>}
          </div>
        </div>
      )}
    </div>
  );
}
