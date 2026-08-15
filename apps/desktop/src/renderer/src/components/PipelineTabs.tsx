import { useStore } from '../state/store';

/**
 * One tab per running pipeline (a live GroupRun) in the chat header. Clicking a
 * tab jumps to that run's coordinator session, which flips the chat into its
 * group view (member panes + redirect inputs) — so several pipelines can run at
 * once and you switch between them, with Vodo coordinating each. Empty when
 * nothing is running; it also holds the header's flexible middle space.
 */

const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function PipelineTabs() {
  const groups = useStore((s) => s.groups);
  const sessions = useStore((s) => s.sessions);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const openSession = useStore((s) => s.openSession);

  const running = groups.filter((g) => !g.endedAt);

  return (
    <div className="pipeline-tabs">
      {running.map((g) => {
        const active =
          g.coordinatorId === activeSessionId ||
          g.members.some((m) => m.sessionId === activeSessionId);
        const working = g.members.some((m) => sessions[m.sessionId]?.streaming);
        return (
          <button
            key={g.id}
            type="button"
            className={`pipeline-tab${active ? ' active' : ''}`}
            title={g.goal}
            onClick={() => {
              if (g.coordinatorId) void openSession(g.coordinatorId);
            }}
          >
            <span className={`pipeline-tab-dot${working ? ' working' : ''}`} />
            <span className="pipeline-tab-label">{trunc(g.goal, 24)}</span>
          </button>
        );
      })}
    </div>
  );
}
