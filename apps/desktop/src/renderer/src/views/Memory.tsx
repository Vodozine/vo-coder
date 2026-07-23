import { useCallback, useEffect, useState } from 'react';
import type { MapNodeDto } from '../../../shared/ipc-contract';
import { Icon } from '../components/Icon';
import { useStore } from '../state/store';

const TYPES = ['file', 'component', 'decision', 'task', 'fact', 'issue', 'preference'] as const;
const STATUSES = ['active', 'done', 'superseded', 'dropped'] as const;

function fmtWhen(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function NodeCard({
  node,
  onStatus,
  onDelete,
}: {
  node: MapNodeDto;
  onStatus: (status: string) => void;
  onDelete: () => void;
}) {
  return (
    <div className={`mem-node st-${node.status}`}>
      <div className="mem-node-head">
        <span className={`mem-type t-${node.type}`}>{node.type}</span>
        <strong className="grow">{node.title}</strong>
        <select
          value={node.status}
          title="Node status — superseded/dropped nodes leave the digest"
          onChange={(e) => onStatus(e.target.value)}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button className="ghost" title="Delete node" onClick={onDelete}>
          <Icon name="x" size={13} />
        </button>
      </div>
      {node.body && <p className="mem-body">{node.body}</p>}
      <div className="meta">
        {node.links.length > 0 && (
          <span className="mem-links">
            {node.links.map((l, i) => (
              <span key={i}>
                {l.rel}→{l.title}
                {i < node.links.length - 1 ? ' · ' : ''}
              </span>
            ))}
            {'  '}
          </span>
        )}
        {node.tags && <span>#{node.tags} · </span>}
        {fmtWhen(node.updatedAt)}
      </div>
    </div>
  );
}

export function Memory() {
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const [projectId, setProjectId] = useState<string>('');
  const [nodes, setNodes] = useState<MapNodeDto[]>([]);
  const [stats, setStats] = useState<{ nodes: number; archiveTurns: number } | null>(null);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);

  const effectiveId = projectId || activeProjectId || projects[0]?.id || '';
  const project = projects.find((p) => p.id === effectiveId);

  const refresh = useCallback(async () => {
    if (!effectiveId) return;
    const [list, st] = await Promise.all([
      window.vo.memMapList(effectiveId, {
        ...(query.trim() ? { query: query.trim() } : {}),
        ...(typeFilter ? { type: typeFilter } : {}),
        includeInactive,
      }),
      window.vo.memStats(effectiveId),
    ]);
    setNodes(list);
    setStats(st);
  }, [effectiveId, query, typeFilter, includeInactive]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setStatus = async (nodeId: number, status: string) => {
    await window.vo.memMapSetStatus(effectiveId, nodeId, status);
    await refresh();
  };
  const remove = async (nodeId: number) => {
    await window.vo.memMapDelete(effectiveId, nodeId);
    await refresh();
  };
  const toggleAssemble = async (enabled: boolean) => {
    await window.vo.projectSetAssemble(effectiveId, enabled);
  };

  return (
    <div className="settings settings-full">
      <h1>Memory</h1>
      <p className="hint">
        The project's memory map — durable knowledge distilled from your conversations. The full
        verbatim archive sits underneath it; nothing here replaces the record.
      </p>

      <div className="field-row mem-controls">
        <select value={effectiveId} onChange={(e) => setProjectId(e.target.value)}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          className="grow"
          placeholder="Search the map…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">all types</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
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
      </div>

      <div className="field-row mem-assemble">
        <label className="checkbox" title="Requests carry the map digest + recent turns instead of replaying the whole conversation. The chat UI and archive keep everything.">
          <input
            type="checkbox"
            checked={project?.assemble ?? false}
            onChange={(e) => void toggleAssemble(e.target.checked)}
          />
          <strong>Smart context</strong>&nbsp;— assemble digest + recent buffer instead of full
          replay (beta)
        </label>
        <span className="meta grow" style={{ textAlign: 'right' }}>
          {stats ? `${stats.nodes} map nodes · ${stats.archiveTurns} archived turns` : ''}
        </span>
      </div>

      {nodes.length === 0 ? (
        <div className="empty-state left">
          <p>
            {query || typeFilter
              ? 'No map nodes match.'
              : 'The map is empty so far — it fills in automatically as conversations in this project distill.'}
          </p>
        </div>
      ) : (
        <div className="mem-grid">
          {nodes.map((n) => (
            <NodeCard
              key={n.id}
              node={n}
              onStatus={(s) => void setStatus(n.id, s)}
              onDelete={() => void remove(n.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
