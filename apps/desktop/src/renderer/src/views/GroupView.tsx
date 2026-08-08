import { useEffect, useRef, useState } from 'react';
import type { GroupMember, GroupRun } from '../../../shared/ipc-contract';
import { Icon } from '../components/Icon';
import { useStore } from '../state/store';
import { AssistantBody } from './Chat';

/**
 * Several agents working one goal, side by side — and the coordinator's chat
 * is ONE OF THE TILES, pinned bottom-right, not a thread buried underneath.
 * The main composer keeps talking to the coordinator; its tile is where the
 * answer shows up.
 *
 * Each member pane is a real chat session — it archives, distils, and can be
 * opened on its own afterwards. Nothing here passes messages between agents:
 * they stay in step through the project's memory map.
 */
export function GroupView({
  group,
  coordinatorId,
  activeSessionId,
  collapsed,
  onToggle,
  onOpenSolo,
}: {
  group: GroupRun;
  coordinatorId: string;
  /** The chat the composer talks to right now — its tile is marked. */
  activeSessionId: string;
  collapsed: boolean;
  onToggle: () => void;
  /** Show one member full size (activates it and folds the grid). */
  onOpenSolo: (sessionId: string) => void;
}) {
  const endGroup = useStore((s) => s.endGroup);
  const working = useStore(
    (s) => group.members.filter((m) => s.sessions[m.sessionId]?.streaming).length,
  );
  // Remembered across view switches: this component unmounts every time the
  // user visits Preview/Settings and back, and re-picking 8-per-page on every
  // return is exactly the papercut that got reported.
  const [perPage, setPerPageState] = useState<4 | 8 | 16>(() => {
    const stored = localStorage.getItem('vo-group-per-page');
    return stored === '16' ? 16 : stored === '8' ? 8 : 4;
  });
  const setPerPage = (n: 4 | 8 | 16) => {
    setPerPageState(n);
    try {
      localStorage.setItem('vo-group-per-page', String(n));
    } catch {
      /* private-mode etc. — the session still works, it just forgets */
    }
  };
  const [page, setPage] = useState(0);

  // The coordinator holds one tile, members get the rest.
  const slots = perPage - 1;
  const pages = Math.max(1, Math.ceil(group.members.length / slots));
  const current = Math.min(page, pages - 1);
  const shown = group.members.slice(current * slots, current * slots + slots);

  return (
    <div className={`group-view${collapsed ? ' collapsed' : ' full'}`}>
      <header className="group-head">
        <button
          className="ghost"
          title={collapsed ? 'Show the agent panes' : 'Fold to the plain chat — they keep working'}
          onClick={onToggle}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="group-goal" title={group.goal}>
          <Icon name="compass" size={12} /> {group.goal}
        </span>
        <span className="meta">
          {working > 0 ? `${working} of ${group.members.length} working` : 'all idle'}
        </span>
        <div className="group-controls">
          <select
            value={String(perPage)}
            title="How many windows per page (one is the coordinator)"
            onChange={(e) => {
              const n = Number(e.target.value);
              setPerPage(n === 16 ? 16 : n === 8 ? 8 : 4);
              setPage(0);
            }}
          >
            <option value="4">4 per page</option>
            <option value="8">8 per page</option>
            <option value="16">16 per page</option>
          </select>
          {pages > 1 && (
            <>
              <button
                className="ghost"
                disabled={current === 0}
                title="Previous page"
                onClick={() => setPage(current - 1)}
              >
                ‹
              </button>
              <span className="meta">
                {current + 1}/{pages}
              </span>
              <button
                className="ghost"
                disabled={current >= pages - 1}
                title="Next page"
                onClick={() => setPage(current + 1)}
              >
                ›
              </button>
            </>
          )}
          <button
            className="ghost"
            title="Stop coordinating — every chat stays exactly where it is"
            onClick={() => void endGroup(group.id)}
          >
            End group
          </button>
        </div>
      </header>
      {!collapsed && (
        <div className={`group-grid per${perPage}`}>
          {shown.map((m) => (
            <GroupPane
              key={m.sessionId}
              member={m}
              isActive={m.sessionId === activeSessionId}
              onOpenSolo={onOpenSolo}
            />
          ))}
          <CoordinatorPane
            sessionId={coordinatorId}
            isActive={coordinatorId === activeSessionId}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The coordinator's own thread, always bottom-right (grid-area in CSS). The
 * main composer below the grid is its input, so the tile carries no input of
 * its own — it is the chat window, relocated, not a second chat.
 */
function CoordinatorPane({ sessionId, isActive }: { sessionId: string; isActive: boolean }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const primeSession = useStore((s) => s.primeSession);
  const openSession = useStore((s) => s.openSession);
  const scrollRef = useRef<HTMLDivElement>(null);
  // After a restart the coordinator's transcript may not be in the store yet —
  // a restored group must come back with its thread, not an empty tile.
  useEffect(() => {
    void primeSession(sessionId);
  }, [sessionId, primeSession]);
  const messages = session?.messages ?? [];
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div
      className={`group-pane coordinator${session?.streaming ? ' working' : ''}${isActive ? ' active-chat' : ''}`}
    >
      <header>
        <strong>Vodo</strong>
        <span className="meta">
          {isActive ? 'coordinator — the box below types here' : 'coordinator'}
        </span>
        <span className="group-pane-actions">
          <em className="meta">{session?.streaming ? 'working…' : 'idle'}</em>
          {!isActive && (
            <button
              className="ghost"
              title="Talk to the coordinator (the composer switches to this chat)"
              onClick={() => void openSession(sessionId)}
            >
              talk
            </button>
          )}
        </span>
      </header>
      <div className="group-pane-body" ref={scrollRef}>
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="bubble user">
              {m.text}
            </div>
          ) : (
            <AssistantBody key={m.id} m={m} hideThinking={false} />
          ),
        )}
      </div>
    </div>
  );
}

function GroupPane({
  member,
  isActive,
  onOpenSolo,
}: {
  member: GroupMember;
  isActive: boolean;
  onOpenSolo: (sessionId: string) => void;
}) {
  const session = useStore((s) => s.sessions[member.sessionId]);
  const primeSession = useStore((s) => s.primeSession);
  const sendToMember = useStore((s) => s.sendToMember);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void primeSession(member.sessionId);
  }, [member.sessionId, primeSession]);

  const messages = session?.messages ?? [];
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div
      className={`group-pane${session?.streaming ? ' working' : ''}${isActive ? ' active-chat' : ''}`}
    >
      <header>
        <strong>{member.agentName}</strong>
        <span className="meta" title={member.task}>
          {member.task}
        </span>
        <span className="group-pane-actions">
          {session?.streaming ? (
            <em className="meta">working…</em>
          ) : (
            <em className="meta">idle</em>
          )}
          <button
            className="ghost"
            title="Open this chat full size (▸ in the header brings the grid back)"
            onClick={() => onOpenSolo(member.sessionId)}
          >
            open
          </button>
        </span>
      </header>
      <div className="group-pane-body" ref={scrollRef}>
        {messages.length === 0 && <div className="meta">starting…</div>}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="bubble user group-brief" title={m.text}>
              {m.text}
            </div>
          ) : (
            <AssistantBody key={m.id} m={m} hideThinking />
          ),
        )}
      </div>
      <div className="group-pane-input">
        <input
          value={input}
          placeholder={`redirect ${member.agentName}…`}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !input.trim()) return;
            void sendToMember(member.sessionId, input);
            setInput('');
          }}
        />
        {session?.streaming && (
          // Stop THIS member — the store's stop() targets the active session,
          // which is not this pane.
          <button
            className="ghost"
            title={`Stop ${member.agentName}`}
            onClick={() => void window.vo.chatStop(member.sessionId)}
          >
            ■
          </button>
        )}
      </div>
    </div>
  );
}
