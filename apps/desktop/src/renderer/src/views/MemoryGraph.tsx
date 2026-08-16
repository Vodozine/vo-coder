import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph3D, { type ForceGraphMethods } from 'react-force-graph-3d';
import type { GraphNodeDto, MemGraphDto } from '../../../shared/ipc-contract';
import { Icon } from '../components/Icon';
import { createCelestialNode, nodeValOf } from './memoryGraphBodies';

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
/** Gap between the selected node and the detail card, so the leader line is visible. */
const CARD_GAP = 36;

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
  const leaderLineRef = useRef<SVGLineElement>(null);
  const leaderHaloRef = useRef<SVGLineElement>(null);
  const leaderDotRef = useRef<SVGCircleElement>(null);
  const fgRef = useRef<ForceGraphMethods<GNode, GLink> | undefined>(undefined);
  const queryRef = useRef(query);
  const typeRef = useRef(typeFilter);
  // Fit-to-extents is a one-shot after the first layout (and after a new graph
  // load). Selecting a node re-renders this component; without the guard,
  // onEngineStop would fire zoomToFit again and yank the camera out.
  const initialFitDone = useRef(false);
  // Live mean/max for moon/planet/sun class + glow. Kept in a ref so the
  // nodeThreeObject factory identity does not change on select (a new factory
  // would remake every mesh and can resume the sim -> zoomToFit).
  const sizeStatsRef = useRef({ mean: 1, max: 1 });

  const [size, setSize] = useState({ width: 800, height: 600 });
  const [data, setData] = useState<{ nodes: GNode[]; links: GLink[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<GNode | null>(null);

  const colors = useMemo(typeColors, []);
  const bg = useMemo(() => cssVar('--bg', '#0b0e14'), []);
  const labelColor = useMemo(() => cssVar('--text', '#e7ecf5'), []);
  // --text-dim reads clearly over the dark 3D field; --border was too faint.
  const edgeColor = useMemo(() => cssVar('--text-dim', '#8f9bb3'), []);

  const nodeById = useMemo(
    () => new Map((data?.nodes ?? []).map((n) => [n.id, n])),
    [data],
  );

  // Recompute relative size stats whenever the graph payload changes — not on
  // select / filter. Filters only hide nodes; class + glow stay map-relative.
  useMemo(() => {
    const nodes = data?.nodes ?? [];
    if (nodes.length === 0) {
      sizeStatsRef.current = { mean: 1, max: 1 };
      return;
    }
    let sum = 0;
    let max = 0;
    for (const n of nodes) {
      const s = nodeValOf(n.degree);
      sum += s;
      if (s > max) max = s;
    }
    sizeStatsRef.current = { mean: sum / nodes.length, max };
  }, [data]);

  const fetchGraph = useCallback(async () => {
    if (!projectId) {
      setData({ nodes: [], links: [] });
      setLoading(false);
      return;
    }
    setLoading(true);
    setSelected(null);
    initialFitDone.current = false;
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

  const nodeVal = useCallback((n: GNode) => nodeValOf(n.degree), []);
  const linkColorFn = useCallback(() => edgeColor, [edgeColor]);
  const linkVisible = useCallback(
    (l: GLink) => {
      const s = typeof l.source === 'object' ? (l.source as GNode) : nodeById.get(l.source);
      const t = typeof l.target === 'object' ? (l.target as GNode) : nodeById.get(l.target);
      return !!s && !!t && nodeVisible(s) && nodeVisible(t);
    },
    [nodeById, nodeVisible],
  );
  const onNodeClick = useCallback((n: GNode) => setSelected(n), []);
  const onBackgroundClick = useCallback(() => setSelected(null), []);
  const fitCamera = useCallback(() => {
    fgRef.current?.zoomToFit(500);
  }, []);
  // First engine stop after a graph load frames the cloud. Later stops (a
  // select re-render can resume-then-immediately-stop the sim) must not Fit.
  const onEngineStop = useCallback(() => {
    if (initialFitDone.current) return;
    initialFitDone.current = true;
    fgRef.current?.zoomToFit(400, 40);
  }, []);

  // Custom moon/planet/sun group (body + glow sprite + label). Identity is
  // stable across select: stats are read from sizeStatsRef, not closed over.
  // nodeThreeObjectExtend is false so we do not also draw the default sphere.
  const nodeThree = useCallback(
    (n: GNode) => {
      const { mean, max } = sizeStatsRef.current;
      return createCelestialNode({
        title: n.title,
        type: n.type,
        degree: n.degree,
        color: isLive(n.status) ? colors[n.type] ?? COLOR_FALLBACK : '#48506a',
        live: isLive(n.status),
        mean,
        max,
        labelColor,
      });
    },
    [colors, labelColor],
  );

  // Keep the detail card and leader line pinned to the clicked node as the camera moves.
  useEffect(() => {
    if (!selected) return;
    let raf = 0;
    const follow = () => {
      const fg = fgRef.current;
      const el = detailRef.current;
      const host = hostRef.current;
      const line = leaderLineRef.current;
      const halo = leaderHaloRef.current;
      const dot = leaderDotRef.current;
      if (fg && el && host && selected.x != null && selected.y != null && selected.z != null) {
        const c = fg.graph2ScreenCoords(selected.x, selected.y, selected.z);
        if (Number.isFinite(c.x) && Number.isFinite(c.y)) {
          const hostW = host.clientWidth;
          const hostH = host.clientHeight;
          const cardW = el.offsetWidth;
          const cardH = el.offsetHeight;
          let placeRight = c.x + CARD_GAP + cardW <= hostW - 8;
          if (!placeRight && c.x - CARD_GAP - cardW < 8) {
            placeRight = c.x < hostW / 2;
          }
          let top = c.y;
          const half = cardH / 2;
          if (top - half < 8) top = 8 + half;
          if (top + half > hostH - 8) top = Math.max(8 + half, hostH - 8 - half);

          el.style.left = `${c.x}px`;
          el.style.top = `${top}px`;
          el.style.transform = placeRight
            ? `translate(${CARD_GAP}px, -50%)`
            : `translate(calc(-100% - ${CARD_GAP}px), -50%)`;

          const attachX = placeRight ? c.x + CARD_GAP : c.x - CARD_GAP;
          const attachY = top;
          const x1 = String(c.x);
          const y1 = String(c.y);
          const x2 = String(attachX);
          const y2 = String(attachY);
          if (line) {
            line.setAttribute('x1', x1);
            line.setAttribute('y1', y1);
            line.setAttribute('x2', x2);
            line.setAttribute('y2', y2);
          }
          if (halo) {
            halo.setAttribute('x1', x1);
            halo.setAttribute('y1', y1);
            halo.setAttribute('x2', x2);
            halo.setAttribute('y2', y2);
          }
          if (dot) {
            dot.setAttribute('cx', x1);
            dot.setAttribute('cy', y1);
          }
          const svg = line?.ownerSVGElement ?? halo?.ownerSVGElement;
          if (svg) svg.style.visibility = 'visible';
        }
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
            nodeVal={nodeVal}
            nodeLabel={(n: GNode) => `${n.type} · ${n.title}`}
            nodeVisibility={nodeVisible}
            nodeThreeObjectExtend={false}
            nodeThreeObject={nodeThree}
            onEngineStop={onEngineStop}
            linkColor={linkColorFn}
            linkOpacity={0.5}
            linkWidth={0.8}
            linkVisibility={linkVisible}
            onNodeClick={onNodeClick}
            onBackgroundClick={onBackgroundClick}
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
            <button className="ghost" onClick={fitCamera}>
              Fit
            </button>
          </div>
          <div className="mem-graph-hint">drag to rotate · scroll to fly in · click a node</div>
        </>
      )}

      {selected && (
        <>
          <svg className="mem-graph-connector" aria-hidden style={{ visibility: 'hidden' }}>
            <line ref={leaderHaloRef} className="mem-graph-leader-halo" />
            <line ref={leaderLineRef} className="mem-graph-leader" />
            <circle ref={leaderDotRef} className="mem-graph-leader-dot" r="5" />
          </svg>
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
        </>
      )}
    </div>
  );
}
