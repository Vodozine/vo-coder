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

export type ModelPickerFilter = 'all' | 'vision' | 'image';

/**
 * Model dropdown with search, price columns, and price sorting — comparing
 * cost is the point of the whole harness, so the numbers sit right in the
 * picker instead of hiding in provider dashboards.
 *
 * filter:
 *   'vision' — models that accept image input (Settings → Vision model)
 *   'image'  — models that OUTPUT images (Settings → Image model)
 *   'all'    — every model the provider lists (default)
 */
export function ModelPicker({
  provider,
  value,
  onChange,
  placeholder,
  filter = 'all',
  filterId,
}: {
  provider: string;
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  filter?: ModelPickerFilter;
  /** Narrow the list by id — e.g. to one local server's "@name" models. */
  filterId?: (id: string) => boolean;
}) {
  const catalog = useStore((s) => s.catalog);
  // Grok login registers xAI without an API key — re-fetch when that flips.
  const xaiOauthConnected = useStore((s) => s.xaiOauthConnected);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [byPrice, setByPrice] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  // Only xAI care about OAuth; other providers ignore the flag for cache stability.
  const authEpoch = provider === 'xai' ? (xaiOauthConnected ? 1 : 0) : 0;

  useEffect(() => {
    let cancelled = false;
    setModels([]);
    setFailed(false);
    if (!provider) {
      setFailed(true);
      return;
    }
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
  }, [provider, authEpoch]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!hostRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, []);

  const rows = useMemo<Row[]>(() => {
    // Start from the live provider list; always merge catalog seed entries for
    // the active filter so Grok login / sparse /v1/models still show curated
    // xAI chat, vision, and Imagine models.
    const byId = new Map<string, ModelInfo>();
    for (const m of models) byId.set(m.id, m);
    if (catalog?.records) {
      for (const r of catalog.records) {
        if (r.provider !== provider) continue;
        if (filter === 'vision' && r.supportsVision !== true) continue;
        if (filter === 'image' && r.outputsImage !== true) continue;
        if (filter === 'all') {
          // Chat/agent pickers: skip pure image-gen seeds.
          const tags = r.tags ?? [];
          const pureImage =
            r.outputsImage === true &&
            r.supportsVision !== true &&
            (tags.length === 0 || tags.every((t) => t === 'image-gen' || t === 'image'));
          if (pureImage) continue;
        }
        if (!byId.has(r.id)) {
          byId.set(r.id, {
            id: r.id,
            provider,
            displayName: r.displayName ?? r.id,
            contextLength: r.contextLength,
            supportsVision: r.supportsVision,
          });
        }
      }
    }

    // Grok login is subscription-billed — show $0 even when an API key is also
    // saved (hub prefers OAuth). NVIDIA free tier is the same pattern.
    const freeEndpoint =
      provider === 'nvidia' || (provider === 'xai' && xaiOauthConnected);

    let list = [...byId.values()].map((m) => {
      const rec = catalog?.records.find((r) => r.id === m.id && (!r.provider || r.provider === provider));
      // Also match catalog rows that only differ by openrouter-style id for OR.
      const recLoose =
        rec ??
        catalog?.records.find(
          (r) => r.id === m.id || (r.provider === provider && r.displayName === m.displayName),
        );
      const inPrice = freeEndpoint ? 0 : recLoose?.pricing?.inputPerMTok;
      const outPrice = freeEndpoint ? 0 : recLoose?.pricing?.outputPerMTok;
      const valid = inPrice !== undefined && inPrice >= 0 && (outPrice ?? 0) >= 0;
      return {
        id: m.id,
        name: recLoose?.displayName ?? m.displayName ?? m.id,
        ctx: recLoose?.contextLength ?? m.contextLength,
        inPrice: valid ? inPrice : undefined,
        outPrice: valid ? outPrice : undefined,
        quality: recLoose?.quality,
        local:
          recLoose?.estMemGb !== undefined ||
          provider === 'ollama' ||
          provider === 'lmstudio' ||
          provider === 'llamacpp',
        fits: recLoose?.fit?.fits,
        supportsVision: recLoose?.supportsVision ?? m.supportsVision,
        outputsImage: recLoose?.outputsImage === true,
      };
    });

    if (filterId) list = list.filter((r) => filterId(r.id));

    if (filter === 'vision') {
      // Prefer positively vision-capable; keep unknown live ids (provider may
      // list models the seed doesn't annotate) so the picker stays complete.
      const known = list.filter((r) => r.supportsVision === true);
      const unknown = list.filter((r) => r.supportsVision !== true && r.supportsVision !== false);
      // If the catalog flagged any, show those first then unknowns; if nothing
      // is annotated, fall back to the full live list so XAI still works.
      list = known.length > 0 ? [...known, ...unknown] : list;
    } else if (filter === 'image') {
      const imageOnly = list.filter((r) => r.outputsImage);
      // Image generators are a dedicated class — never dump the whole chat list.
      // If the live API returned none and the seed has none, leave empty so the
      // free-text fallback appears.
      list = imageOnly;
    }

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
  }, [models, catalog, query, byPrice, provider, filter, filterId, xaiOauthConnected]);

  const price = (r: Row) => {
    if (r.local) return 'local · $0';
    // Subscription / free-tier endpoints surface as $0/$0.
    if (r.inPrice === 0 && (r.outPrice ?? 0) === 0) {
      if (provider === 'xai' && xaiOauthConnected) return 'free (Grok login)';
      if (provider === 'nvidia') return 'free endpoint';
      return '$0/$0';
    }
    return r.inPrice !== undefined ? `$${r.inPrice}/$${r.outPrice}` : '—';
  };

  // Catalog seeds can still offer a dropdown when listModels fails (e.g. Grok
  // login just landed) as long as matching rows exist. For chat ('all'), only
  // fall back when listModels did not hard-fail — that means the provider is
  // configured (API key or Grok login); otherwise keep the free-text field.
  const hasCatalogFallback = (catalog?.records ?? []).some((r) => {
    if (r.provider !== provider) return false;
    if (filter === 'vision') return r.supportsVision === true;
    if (filter === 'image') return r.outputsImage === true;
    // filter === 'all'
    if (failed) return false;
    const tags = r.tags ?? [];
    const pureImage =
      r.outputsImage === true &&
      r.supportsVision !== true &&
      (tags.length === 0 || tags.every((t) => t === 'image-gen' || t === 'image'));
    return !pureImage;
  });

  if ((failed && !hasCatalogFallback) || (models.length === 0 && !hasCatalogFallback && !open)) {
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

  // When we only have catalog rows (list failed/empty), still open the picker.
  if (rows.length === 0 && !open && models.length === 0 && !hasCatalogFallback) {
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
