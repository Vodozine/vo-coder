import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Konva from 'konva';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import type { GraphNodeDto, MemGraphDto } from '../../../shared/ipc-contract';
import { Icon } from '../components/Icon';

/**
 * Obsidian-style force-directed view of the project's memory map. Rendered with
 * IMPERATIVE Konva (not react-konva) driven by a d3-force simulation: a project
 * can hold hundreds of nodes, and re-rendering that many shapes through React
 * every physics tick would jank. React owns only the chrome (legend, detail
 * card); the canvas is built once per dataset and mutated in place per tick.
 *
 * Perf notes: the node layer's hit graph is disabled while the layout settles
 * (the expensive per-frame cost) and re-enabled once it freezes; labels stay
 * hidden until hover/zoom; the sim self-stops when cool, so idle CPU is zero.
 */

type SimNode = GraphNodeDto & SimulationNodeDatum & { degree: number };
type SimEdge = SimulationLinkDatum<SimNode> & { rel: string };

// One colour per node type — the three semantic ones track the pill palette.
function typeColors(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  return {
    decision: v('--accent', '#e0a83a'),
    task: v('--ok', '#3fb950'),
    issue: v('--error', '#f85149'),
    component: v('--accent2', '#37b8c4'),
    fact: '#589bff',
    file: '#8b949e',
    preference: '#c98fd0',
  };
}
const COLOR_FALLBACK = '#8b949e';

const DIM = 0.12; // opacity of faded (out-of-focus / non-matching) items
const LABEL_ZOOM = 1.15; // show in-view labels once zoomed past this
const isLive = (status: string): boolean => status === 'active' || status === 'done';
const radiusOf = (degree: number): number => 5 + Math.min(15, Math.sqrt(degree) * 3);

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
  const applyFocusRef = useRef<() => void>(() => {});
  const fitViewRef = useRef<() => void>(() => {});
  // Latest filter values, read by applyFocus without rebuilding the graph.
  const queryRef = useRef(query);
  const typeRef = useRef(typeFilter);
  const selectedRef = useRef<number | null>(null);

  const [data, setData] = useState<MemGraphDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<GraphNodeDto | null>(null);

  const colors = useMemo(typeColors, []);
  const nodeById = useMemo(
    () => new Map((data?.nodes ?? []).map((n) => [n.id, n])),
    [data],
  );

  const fetchGraph = useCallback(async () => {
    if (!projectId) {
      setData({ nodes: [], edges: [] });
      setLoading(false);
      return;
    }
    setLoading(true);
    const g = await window.vo.memMapGraph(projectId, { includeInactive });
    setData(g);
    setLoading(false);
  }, [projectId, includeInactive]);

  useEffect(() => {
    void fetchGraph();
  }, [fetchGraph]);

  // Filter changes only re-highlight — no rebuild, no refetch.
  useEffect(() => {
    queryRef.current = query;
    typeRef.current = typeFilter;
    applyFocusRef.current();
  }, [query, typeFilter]);

  useEffect(() => {
    selectedRef.current = selected?.id ?? null;
    applyFocusRef.current();
  }, [selected]);

  // Build the whole Konva scene + simulation once per dataset.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !data || data.nodes.length === 0) return;
    let width = host.clientWidth || 800;
    let height = host.clientHeight || 600;
    let hoverId: number | null = null;
    let fitted = false;

    const colorOf = (t: string) => colors[t] ?? COLOR_FALLBACK;
    const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#e7ecf5';
    const bgColor = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0b0e14';
    const edgeColor = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || 'rgba(140,150,170,0.5)';

    // ---- model: nodes, edges, adjacency, degree ----
    const nodes: SimNode[] = data.nodes.map((n) => ({ ...n, degree: 0 }));
    const idx = new Map<number, SimNode>(nodes.map((n) => [n.id, n]));
    const adj = new Map<number, Set<number>>();
    const edges: SimEdge[] = [];
    for (const e of data.edges) {
      const s = idx.get(e.from);
      const t = idx.get(e.to);
      if (!s || !t) continue;
      s.degree++;
      t.degree++;
      edges.push({ source: s, target: t, rel: e.rel });
      (adj.get(e.from) ?? adj.set(e.from, new Set()).get(e.from)!).add(e.to);
      (adj.get(e.to) ?? adj.set(e.to, new Set()).get(e.to)!).add(e.from);
    }
    // Seed positions in a centred spiral so the sim settles from the middle
    // rather than flying in from the origin.
    nodes.forEach((n, i) => {
      const angle = i * 2.399963;
      const rad = 12 * Math.sqrt(i);
      n.x = width / 2 + rad * Math.cos(angle);
      n.y = height / 2 + rad * Math.sin(angle);
    });

    // ---- konva scene ----
    const stage = new Konva.Stage({ container: host, width, height, draggable: true });
    const edgeLayer = new Konva.Layer({ listening: false });
    // Hit graph stays OFF while the layout animates — redrawing it for hundreds
    // of shapes every frame is the settle cost. Re-enabled once the sim freezes.
    const nodeLayer = new Konva.Layer({ listening: false });
    const labelLayer = new Konva.Layer({ listening: false });
    stage.add(edgeLayer, nodeLayer, labelLayer);

    const nodeMap = new Map<number, Konva.Circle>();
    const labelMap = new Map<number, Konva.Text>();
    const lines: Array<{ line: Konva.Line; s: SimNode; t: SimNode }> = [];

    for (const e of edges) {
      const line = new Konva.Line({ points: [0, 0, 0, 0], stroke: edgeColor, strokeWidth: 1 });
      edgeLayer.add(line);
      lines.push({ line, s: e.source as SimNode, t: e.target as SimNode });
    }

    const labelVisible = (n: SimNode): boolean => {
      if (hoverId != null) return n.id === hoverId || adj.get(hoverId)?.has(n.id) === true;
      if (selectedRef.current === n.id) return true;
      if (stage.scaleX() >= LABEL_ZOOM) {
        const sx = (n.x ?? 0) * stage.scaleX() + stage.x();
        const sy = (n.y ?? 0) * stage.scaleY() + stage.y();
        return sx > -40 && sy > -20 && sx < width + 40 && sy < height + 20;
      }
      return false;
    };

    const applyFocus = () => {
      const q = queryRef.current.trim().toLowerCase();
      const tf = typeRef.current;
      const focus = hoverId != null ? new Set<number>([hoverId, ...(adj.get(hoverId) ?? [])]) : null;
      for (const n of nodes) {
        const circle = nodeMap.get(n.id);
        if (!circle) continue;
        let op = isLive(n.status) ? 1 : 0.5;
        const matchQ =
          !q ||
          n.title.toLowerCase().includes(q) ||
          n.body.toLowerCase().includes(q) ||
          n.tags.toLowerCase().includes(q);
        if ((!matchQ || (tf && n.type !== tf)) || (focus && !focus.has(n.id))) op = DIM;
        circle.opacity(op);
      }
      for (const { line, s, t } of lines) {
        line.opacity(focus ? (focus.has(s.id) && focus.has(t.id) ? 0.7 : 0.04) : 0.4);
      }
      for (const n of nodes) labelMap.get(n.id)?.visible(labelVisible(n));
      stage.batchDraw();
    };
    applyFocusRef.current = applyFocus;

    for (const n of nodes) {
      const circle = new Konva.Circle({
        radius: radiusOf(n.degree),
        fill: colorOf(n.type),
        stroke: bgColor,
        strokeWidth: 1.5,
        draggable: true,
        opacity: isLive(n.status) ? 1 : 0.5,
      });
      circle.on('mouseenter', () => {
        hoverId = n.id;
        host.style.cursor = 'pointer';
        applyFocus();
      });
      circle.on('mouseleave', () => {
        hoverId = null;
        host.style.cursor = '';
        applyFocus();
      });
      circle.on('click tap', (ev) => {
        ev.cancelBubble = true;
        setSelected(n);
      });
      circle.on('dragstart', () => {
        n.fx = n.x;
        n.fy = n.y;
        sim.alphaTarget(0.3).restart();
      });
      circle.on('dragmove', () => {
        n.fx = circle.x();
        n.fy = circle.y();
      });
      circle.on('dragend', () => {
        sim.alphaTarget(0);
        n.fx = null;
        n.fy = null;
      });
      nodeLayer.add(circle);
      nodeMap.set(n.id, circle);

      const label = new Konva.Text({
        text: n.title,
        fontSize: 12,
        fontFamily: 'system-ui, sans-serif',
        fill: textColor,
        shadowColor: bgColor,
        shadowBlur: 3,
        shadowOpacity: 0.9,
        listening: false,
        visible: false,
      });
      labelLayer.add(label);
      labelMap.set(n.id, label);
    }

    // ---- simulation ----
    const sim: Simulation<SimNode, SimEdge> = forceSimulation<SimNode>(nodes)
      .force('charge', forceManyBody<SimNode>().strength(-90).theta(0.9).distanceMax(450))
      .force(
        'link',
        forceLink<SimNode, SimEdge>(edges)
          .id((d) => d.id)
          .distance(58)
          .strength(0.35),
      )
      .force('center', forceCenter(width / 2, height / 2))
      .force('collide', forceCollide<SimNode>().radius((d) => radiusOf(d.degree) + 4))
      .force('x', forceX(width / 2).strength(0.03))
      .force('y', forceY(height / 2).strength(0.03));

    const tick = () => {
      for (const { line, s, t } of lines) line.points([s.x ?? 0, s.y ?? 0, t.x ?? 0, t.y ?? 0]);
      for (const n of nodes) {
        nodeMap.get(n.id)?.position({ x: n.x ?? 0, y: n.y ?? 0 });
        const label = labelMap.get(n.id);
        if (label?.visible()) {
          label.position({ x: (n.x ?? 0) + radiusOf(n.degree) + 3, y: (n.y ?? 0) - 6 });
        }
      }
      stage.batchDraw();
    };
    sim.on('tick', tick);

    // ---- view helpers: zoom at cursor, pan, fit ----
    const clampScale = (s: number): number => Math.max(0.1, Math.min(4, s));
    stage.on('wheel', (e) => {
      e.evt.preventDefault();
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      const old = stage.scaleX();
      const worldX = (pointer.x - stage.x()) / old;
      const worldY = (pointer.y - stage.y()) / old;
      const next = clampScale(e.evt.deltaY > 0 ? old / 1.08 : old * 1.08);
      stage.scale({ x: next, y: next });
      stage.position({ x: pointer.x - worldX * next, y: pointer.y - worldY * next });
      applyFocus();
    });
    stage.on('dragmove', applyFocus); // panning changes which labels are in view

    const fitView = () => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const n of nodes) {
        minX = Math.min(minX, n.x ?? 0);
        minY = Math.min(minY, n.y ?? 0);
        maxX = Math.max(maxX, n.x ?? 0);
        maxY = Math.max(maxY, n.y ?? 0);
      }
      if (!isFinite(minX)) return;
      const pad = 60;
      const scale = clampScale(
        Math.min((width - pad) / Math.max(1, maxX - minX), (height - pad) / Math.max(1, maxY - minY)),
      );
      stage.scale({ x: scale, y: scale });
      stage.position({
        x: (width - (maxX + minX) * scale) / 2,
        y: (height - (maxY + minY) * scale) / 2,
      });
      applyFocus();
    };
    fitViewRef.current = fitView;
    // First settle: turn hit-testing back on, fit the view once (don't refit on
    // every later drag-induced reheat).
    sim.on('end', () => {
      nodeLayer.listening(true);
      if (!fitted) {
        fitted = true;
        fitView();
      }
    });

    const ro = new ResizeObserver(() => {
      width = host.clientWidth || width;
      height = host.clientHeight || height;
      stage.size({ width, height });
      const c = sim.force('center') as ReturnType<typeof forceCenter> | undefined;
      c?.x(width / 2).y(height / 2);
      applyFocus();
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      sim.stop();
      stage.destroy();
      applyFocusRef.current = () => {};
      fitViewRef.current = () => {};
    };
  }, [data, colors]);

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
    if (!selected || !data) return [];
    const out: Array<{ rel: string; dir: '→' | '←'; other: string }> = [];
    for (const e of data.edges) {
      if (e.from === selected.id) out.push({ rel: e.rel, dir: '→', other: nodeById.get(e.to)?.title ?? String(e.to) });
      else if (e.to === selected.id) out.push({ rel: e.rel, dir: '←', other: nodeById.get(e.from)?.title ?? String(e.from) });
    }
    return out.slice(0, 12);
  }, [selected, data, nodeById]);

  const empty = !loading && (!data || data.nodes.length === 0);

  return (
    <div className="mem-graph">
      <div className="mem-graph-host" ref={hostRef} />

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
              {data?.nodes.length ?? 0} nodes · {data?.edges.length ?? 0} links
            </span>
            <button className="ghost" onClick={() => fitViewRef.current()}>
              Fit
            </button>
          </div>
        </>
      )}

      {selected && (
        <div className="mem-graph-detail">
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
