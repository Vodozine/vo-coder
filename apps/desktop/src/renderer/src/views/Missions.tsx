import { useState } from 'react';
import type { Mission } from '../../../shared/ipc-contract';
import { useStore } from '../state/store';

const INTERVALS: Array<[label: string, minutes: number | undefined]> = [
  ['run once', undefined],
  ['every 15 min', 15],
  ['every 30 min', 30],
  ['every hour', 60],
  ['every 6 hours', 360],
  ['every day', 1440],
];

function fmtWhen(ts?: number): string {
  if (!ts) return 'never';
  const delta = Date.now() - ts;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return new Date(ts).toLocaleString();
}

function MissionCard({ mission }: { mission: Mission }) {
  const projects = useStore((s) => s.projects);
  const [showLog, setShowLog] = useState(false);
  const project = mission.projectId
    ? projects.find((p) => p.id === mission.projectId)?.name
    : undefined;

  const control = (action: 'run' | 'pause' | 'resume' | 'delete') =>
    void window.vo.missionControl(mission.id, action);

  return (
    <div className={`mission-card st-${mission.status}`}>
      <div className="mission-head">
        <span className={`mission-status ${mission.status}`}>
          {mission.status === 'running' ? '◉' : mission.status === 'paused' ? '⏸' : mission.status === 'failed' ? '✕' : mission.status === 'done' ? '✓' : '○'}{' '}
          {mission.status}
        </span>
        <strong className="grow">{mission.title}</strong>
        {mission.status === 'running' ? null : (
          <button className="ghost" title="Run now" onClick={() => control('run')}>
            ▶
          </button>
        )}
        {mission.status === 'paused' || mission.status === 'done' || mission.status === 'failed' ? (
          <button className="ghost" title="Resume schedule" onClick={() => control('resume')}>
            ↻
          </button>
        ) : (
          <button className="ghost" title="Pause" onClick={() => control('pause')}>
            ⏸
          </button>
        )}
        <button
          className="ghost"
          title="Delete mission"
          onClick={() => {
            if (window.confirm(`Delete mission "${mission.title}"?`)) control('delete');
          }}
        >
          ×
        </button>
      </div>
      <div className="meta">
        {mission.intervalMinutes ? `every ${mission.intervalMinutes} min` : 'one-shot'}
        {project ? ` · ${project}` : ''} · runs: {mission.runCount} · last: {fmtWhen(mission.lastRunAt)}
      </div>
      {mission.lastError && <div className="meta error-text">⚠ {mission.lastError}</div>}
      {mission.lastResult && (
        <>
          <button className="ghost mission-log-toggle" onClick={() => setShowLog(!showLog)}>
            {showLog ? '▾ last result' : '▸ last result'}
          </button>
          {showLog && <pre className="mission-log">{mission.lastResult}</pre>}
        </>
      )}
    </div>
  );
}

export function Missions() {
  const missions = useStore((s) => s.missions);
  const projects = useStore((s) => s.projects);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [projectId, setProjectId] = useState('');
  const [interval, setInterval_] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setError(null);
    try {
      await window.vo.missionCreate({
        title: title.trim(),
        objective: objective.trim(),
        ...(projectId ? { projectId } : {}),
        ...(interval ? { intervalMinutes: interval } : {}),
      });
      setTitle('');
      setObjective('');
      setCreating(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="settings settings-full">
      <h1>Missions</h1>
      <p className="hint">
        Background objectives Vodo pursues in its own agent instances — fully concurrent, so a
        running mission never blocks your chats. Loops keep their memory between runs while the app
        is open. You can also just ask Vodo in any chat: “check my backups every hour”.
      </p>

      {missions.length === 0 && !creating && (
        <div className="empty-state left">
          <p>No missions yet.</p>
        </div>
      )}

      <div className="missions-list">
        {missions.map((m) => (
          <MissionCard key={m.id} mission={m} />
        ))}
      </div>

      {creating ? (
        <div className="agent-form">
          <div className="field-row">
            <label>title</label>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Watch the backups"
            />
          </div>
          <div className="field-row">
            <label>objective</label>
            <textarea
              rows={4}
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="Full instructions — the mission agent starts with no other context. e.g. Check the Proxmox backup list; if the newest backup is older than 24h, investigate and report why."
            />
          </div>
          <div className="field-row">
            <label>project</label>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">(none — no folder access)</option>
              {projects
                .filter((p) => p.dir)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
            <select
              value={interval ?? ''}
              onChange={(e) => setInterval_(e.target.value ? Number(e.target.value) : undefined)}
            >
              {INTERVALS.map(([label, minutes]) => (
                <option key={label} value={minutes ?? ''}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {error && <p className="hint error-text">{error}</p>}
          <div className="modal-actions">
            <button className="ghost" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button className="send" disabled={!objective.trim()} onClick={() => void create()}>
              Launch mission
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setCreating(true)}>+ New mission</button>
      )}
    </div>
  );
}
