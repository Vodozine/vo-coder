import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph3D, { type ForceGraphMethods } from 'react-force-graph-3d';
import type { GraphNodeDto, MemGraphDto } from '../../../shared/ipc-contract';
import { Icon } from '../components/Icon';

/**
 * A true 3D force-directed view of the project's memory map — a cloud of nodes
 * in space you rotate (drag), fly into (scroll), and click to inspect. Built on
 * react-force-graph-3d (three.js): the library owns the WebGL scene, physics,
 * orbit camera, and picking; this component owns data, styling, and the chrome.
 *
 * Labels are three-spritetext billboards at a fixed WORLD size, so they are tiny
 * specks when the whole graph is in frame and grow readable only as you zoom in
 * close — the "names appear on the dots" behaviour, for free.
 */

type GNode = GraphNodeDto & { degree: number; x?: number; y?: number; z?: number };
type GLink = { source: number; target: number; rel: string };

const cssVar = (name: string, fallback: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

function typeColors(): Record<string, string> {
  return {
    decision: cssVar('--accent', '#e0a83a'),
    task: cssVar('--ok', '#3fb950'),
    issue: cssVar('--error', '#f85149'),
    component: cssVar('--accent2', '#37b8c4'),
    fact: '#589bff',
    file: '#8b949e',
    preference: '#c98fd0',
  };
}
const COLOR_FALLBACK = '#8b949e';
const isLive = (status: string): boolean => status === 'active' || status === 'done';

export function MemoryGraph({
  projectId,
  query,
  typeFilter,
  includeInactive,
}: {
  projectId: string;
  query: string;
  typeFilter: string;
  includeInactive: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods<GNode, GLink> | undefined>(undefined);
  const queryRef = useRef(query);
  const typeRef = useRef(typeFilter);

  const [size, setSize] = useState({ width: 800, height: 600 });
  const [data, setData] = useState<{ nodes: GNode[]; links: GLink[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<GNode | null>(null);

  const colors = useMemo(typeColors, []);
  const bg = useMemo(() => cssVar('--bg', '#0b0e14'), []);
  const edgeColor = useMemo(() => cssVar('--border', '#3a4152'), []);

  const nodeById = useMemo(
    () => new Map((data?.nodes ?? []).map((n) => [n.id, n])),
    [data],
  );

  const fetchGraph = useCallback(async () => {
    if (!projectId) {
      setData({ nodes: [], links: [] });
      setLoading(false);
      return;
    }
    setLoading(true);
    setSelected(null);
    const g: MemGraphDto = await window.vo.memMapGraph(projectId, { includeInactive });
    const degree = new Map<number, number>();
    for (const e of g.edges) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    setData({
      nodes: g.nodes.map((n) => ({ ...n, degree: degree.get(n.id) ?? 0 })),
      links: g.edges.map((e) => ({ source: e.from, target: e.to, rel: e.rel })),
    });
    setLoading(false);
  }, [projectId, includeInactive]);

  useEffect(() => {
    void fetchGraph();
  }, [fetchGraph]);

  // Measure the host so the canvas fills it.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => setSize({ width: host.clientWidth, height: host.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  // Search / type filter hide non-matches (layout unchanged) — refresh so the
  // library re-reads the visibility accessors.
  useEffect(() => {
    queryRef.current = query;
    typeRef.current = typeFilter;
    fgRef.current?.refresh();
  }, [query, typeFilter]);

  const nodeVisible = useCallback((n: GNode): boolean => {
    const tf = typeRef.current;
    if (tf && n.type !== tf) return false;
    const q = queryRef.current.trim().toLowerCase();
    if (!q) return true;
    return (
      n.title.toLowerCase().includes(q) ||
      n.body.toLowerCase().includes(q) ||
      n.tags.toLowerCase().includes(q)
    );
  }, []);

  const nodeColor = useCallback(
    (n: GNode): string => (isLive(n.status) ? colors[n.type] ?? COLOR_FALLBACK : '#48506a'),
    [colors],
  );

  // Keep the detail card pinned to the clicked node as the camera moves.
  useEffect(() => {
    if (!selected) return;
    let raf = 0;
    const follow = () => {
      const fg = fgRef.current;
      const el = detailRef.current;
      if (fg && el && selected.x != null && selected.y != null && selected.z != null) {
        const c = fg.graph2ScreenCoords(selected.x, selected.y, selected.z);
        el.style.left = `${c.x}px`;
        el.style.top = `${c.y}px`;
      }
      raf = requestAnimationFrame(follow);
    };
    raf = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(raf);
  }, [selected]);

  const changeStatus = async (id: number, status: string) => {
    await window.vo.memMapSetStatus(projectId, id, status);
    setSelected(null);
    await fetchGraph();
  };
  const remove = async (id: number) => {
    await window.vo.memMapDelete(projectId, id);
    setSelected(null);
    await fetchGraph();
  };

  const relations = useMemo(() => {
    if (!selected || !data) return [] as Array<{ rel: string; dir: '→' | '←'; other: string }>;
    const out: Array<{ rel: string; dir: '→' | '←'; other: string }> = [];
    for (const l of data.links) {
      const from = typeof l.source === 'object' ? (l.source as GNode).id : l.source;
      const to = typeof l.target === 'object' ? (l.target as GNode).id : l.target;
      if (from === selected.id) out.push({ rel: l.rel, dir: '→', other: nodeById.get(to)?.title ?? String(to) });
      else if (to === selected.id) out.push({ rel: l.rel, dir: '←', other: nodeById.get(from)?.title ?? String(from) });
    }
    return out.slice(0, 12);
  }, [selected, data, nodeById]);

  const empty = !loading && (!data || data.nodes.length === 0);

  return (
    <div className="mem-graph">
      <div className="mem-graph-host" ref={hostRef}>
        {data && data.nodes.length > 0 && (
          <ForceGraph3D
            ref={fgRef}
            width={size.width}
            height={size.height}
            graphData={data}
            backgroundColor={bg}
            showNavInfo={false}
            controlType="orbit"
            enableNodeDrag={false}
            nodeRelSize={4}
            nodeResolution={8}
            nodeVal={(n: GNode) => 1 + n.degree}
            nodeColor={nodeColor}
            nodeOpacity={0.92}
            nodeLabel={(n: GNode) => `${n.type} · ${n.title}`}
            nodeVisibility={nodeVisible}
            onEngineStop={() => fgRef.current?.zoomToFit(400, 40)}
            linkColor={() => edgeColor}
            linkOpacity={0.28}
            linkWidth={0.6}
            linkVisibility={(l: GLink) => {
              const s = typeof l.source === 'object' ? (l.source as GNode) : nodeById.get(l.source);
              const t = typeof l.target === 'object' ? (l.target as GNode) : nodeById.get(l.target);
              return !!s && !!t && nodeVisible(s) && nodeVisible(t);
            }}
            onNodeClick={(n: GNode) => setSelected(n)}
            onBackgroundClick={() => setSelected(null)}
          />
        )}
      </div>

      {loading && <div className="mem-graph-note">Loading the map…</div>}
      {empty && (
        <div className="mem-graph-note">
          Nothing to graph yet — the map fills in as conversations distill.
        </div>
      )}

      {!empty && (
        <>
          <div className="mem-graph-legend">
            {Object.entries(colors).map(([type, color]) => (
              <span key={type} className="mem-legend-item">
                <span className="mem-legend-dot" style={{ background: color }} />
                {type}
              </span>
            ))}
          </div>
          <div className="mem-graph-tools">
            <span className="meta">
              {data?.nodes.length ?? 0} nodes · {data?.links.length ?? 0} links
            </span>
            <button className="ghost" onClick={() => fgRef.current?.zoomToFit(500)}>
              Fit
            </button>
          </div>
          <div className="mem-graph-hint">drag to rotate · scroll to fly in · click a node</div>
        </>
      )}

      {selected && (
        <div className="mem-graph-detail" ref={detailRef}>
          <div className="mem-node-head">
            <span className={`mem-type t-${selected.type}`}>{selected.type}</span>
            <strong className="grow">{selected.title}</strong>
            <select
              value={selected.status}
              onChange={(e) => void changeStatus(selected.id, e.target.value)}
            >
              {['active', 'done', 'superseded', 'dropped'].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <button className="ghost" title="Delete node" onClick={() => void remove(selected.id)}>
              <Icon name="x" size={13} />
            </button>
            <button className="ghost" title="Close" onClick={() => setSelected(null)}>
              ✕
            </button>
          </div>
          {selected.body && <p className="mem-body">{selected.body}</p>}
          {relations.length > 0 && (
            <div className="meta mem-links">
              {relations.map((r, i) => (
                <span key={i}>
                  {r.rel}
                  {r.dir}
                  {r.other}
                  {i < relations.length - 1 ? ' · ' : ''}
                </span>
              ))}
            </div>
          )}
          {selected.tags && <div className="meta">#{selected.tags}</div>}
        </div>
      )}
    </div>
  );
}
