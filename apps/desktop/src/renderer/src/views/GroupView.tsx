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
  collapsed,
  onToggle,
}: {
  group: GroupRun;
  coordinatorId: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const endGroup = useStore((s) => s.endGroup);
  const working = useStore(
    (s) => group.members.filter((m) => s.sessions[m.sessionId]?.streaming).length,
  );
  const [perPage, setPerPage] = useState<4 | 8>(4);
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
              setPerPage(Number(e.target.value) === 8 ? 8 : 4);
              setPage(0);
            }}
          >
            <option value="4">4 per page</option>
            <option value="8">8 per page</option>
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
            <GroupPane key={m.sessionId} member={m} />
          ))}
          <CoordinatorPane sessionId={coordinatorId} />
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
function CoordinatorPane({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = session?.messages ?? [];
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div className={`group-pane coordinator${session?.streaming ? ' working' : ''}`}>
      <header>
        <strong>Vodo</strong>
        <span className="meta">coordinator — type below to steer</span>
        <span className="group-pane-actions">
          <em className="meta">{session?.streaming ? 'working…' : 'idle'}</em>
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

function GroupPane({ member }: { member: GroupMember }) {
  const session = useStore((s) => s.sessions[member.sessionId]);
  const primeSession = useStore((s) => s.primeSession);
  const openSession = useStore((s) => s.openSession);
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
    <div className={`group-pane${session?.streaming ? ' working' : ''}`}>
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
            title="Open this chat full size"
            onClick={() => void openSession(member.sessionId)}
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
