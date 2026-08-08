import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSpec } from '@vo-coder/providers';
import { Icon } from '../components/Icon';
import { ModelPicker } from '../components/ModelPicker';
import { ModeToggle } from '../components/ModeToggle';
import { HOMELAB_AGENT_ID } from '../../../shared/homelab';
import { useStore, type Segment, type UiMessage } from '../state/store';
import { useVoice } from '../voice/useVoice';
import { GroupView } from './GroupView';

/**
 * Context-window meter: estimates how much of the model's window the next
 * turn will replay (chars/4 + fixed system/tool overhead), anchored by the
 * last turn's ACTUAL token usage. The popup offers compaction — a cheap model
 * rewrites the conversation into a briefing and the history is swapped.
 */
function ContextChip({
  messages,
  model,
  streaming,
  assemble,
}: {
  messages: UiMessage[];
  model: string;
  streaming: boolean;
  /** Smart context on for this project — the request is digest + buffer. */
  assemble: boolean;
}) {
  const catalog = useStore((s) => s.catalog);
  const routeMode = useStore((s) => s.config?.routeMode ?? 'off');
  const compactSession = useStore((s) => s.compactSession);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { estTokens, lastUsage } = useMemo(() => {
    let chars = 0;
    let lastUsage: UiMessage['usage'];
    for (const m of messages) {
      chars += m.text?.length ?? 0;
      for (const seg of m.segments ?? []) {
        // Count what was SENT, not the truncated display copy.
        if (seg.kind === 'tool') chars += (seg.resultChars ?? seg.result?.length ?? 0) + 60;
        else chars += seg.text.length;
      }
      chars += (m.attachments?.length ?? 0) * 6400; // ~1.6k tokens per image
      if (m.usage) lastUsage = m.usage;
    }
    // +1500 stands in for the system prompt, briefing and tool schemas, which
    // ride along on every request and are not in `messages` at all.
    return { estTokens: Math.round(chars / 4) + 1500, lastUsage };
  }, [messages]);

  const record = catalog?.records.find((r) => r.id === model);
  const windowTokens = record?.contextLength ?? 128_000;
  // The size of ONE request, straight from the provider — exact, and the only
  // figure that says anything about fitting. The turn's sum would count a
  // 10-step tool run ten times over.
  const perRequest = lastUsage?.lastInputTokens;
  const assembled = assemble && perRequest !== undefined;
  const basis = perRequest ?? estTokens;
  const pct = Math.min(100, Math.round((basis / windowTokens) * 100));
  // With smart context on there is no cliff to walk toward — the request is
  // rebuilt to a bounded size every turn — so the reading is a steady-state
  // cost, not a countdown, and it should not turn red for being large.
  const level = assembled ? 'ok' : pct >= 85 ? 'hot' : pct >= 60 ? 'warm' : 'ok';

  const compact = async () => {
    setBusy(true);
    setError(null);
    const err = await compactSession();
    setBusy(false);
    if (err) setError(err);
    else setOpen(false);
  };

  return (
    <div className="ctx-wrap">
      {open && (
        <div className="ctx-popup">
          <div className="ctx-row">
            <span>model window</span>
            <b>
              {fmtTokens(windowTokens)}
              {record?.contextLength ? '' : ' (est.)'}
            </b>
          </div>
          {assembled ? (
            <>
              <div className="ctx-row">
                <span>per request (measured)</span>
                <b>
                  {fmtTokens(perRequest!)} · {pct}%
                </b>
              </div>
              <div className="ctx-row">
                <span>whole conversation</span>
                <b>{fmtTokens(estTokens)} — not sent</b>
              </div>
            </>
          ) : (
            <>
              <div className="ctx-row">
                <span>in context now (est.)</span>
                <b>
                  {fmtTokens(estTokens)} · {pct}%
                </b>
              </div>
              {lastUsage && (
                <div className="ctx-row">
                  <span>last turn actual</span>
                  <b>
                    {fmtTokens(lastUsage.inputTokens)} in · {fmtTokens(lastUsage.outputTokens)} out
                  </b>
                </div>
              )}
            </>
          )}
          <div className="ctx-row">
            <span>messages</span>
            <b>{messages.length}</b>
          </div>
          <p className="hint">
            {assemble
              ? 'Smart context is on — each request carries the project briefing plus recent turns, so this stays roughly flat however long the chat runs. Everything older is in the memory bank, one tool call away.'
              : `The whole conversation replays every turn${routeMode === 'auto' ? ' (window shown is the selected fallback model)' : ''}, so this climbs until it hits the model's limit. Smart context (in Memory) keeps it flat instead.`}
          </p>
          {error && <p className="hint error-text">{error}</p>}
          <button className="send ctx-compact" disabled={busy || streaming} onClick={() => void compact()}>
            {busy ? 'Consolidating…' : assemble ? 'Consolidate memory' : 'Compact conversation'}
          </button>
        </div>
      )}
      <button
        className={`ghost ctx-chip ${level}`}
        title={
          assembled
            ? 'What one request costs. With smart context on this stays flat however long the chat runs — click for details.'
            : 'How full the model window is — click for details'
        }
        onClick={() => setOpen(!open)}
      >
        <Icon name="gauge" size={12} /> {assembled ? fmtTokens(perRequest!) : `${pct}%`}
      </button>
    </div>
  );
}

const PROVIDERS = ['anthropic', 'ollama', 'lmstudio', 'llamacpp', 'openai', 'openrouter', 'xai', 'zai', 'nvidia'];
/** Backends where becoming ready is expensive enough to be worth pre-loading. */
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'llamacpp']);

/** Inline render of a generated image — pixels come over IPC, never tokens. */
function GeneratedImage({ path }: { path: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void window.vo.imageRead(path).then((r) => {
      if (!alive) return;
      if (r.ok && r.dataUrl) setDataUrl(r.dataUrl);
      else setError(r.error ?? 'Could not load the image.');
    });
    return () => {
      alive = false;
    };
  }, [path]);
  if (error) return <div className="meta">🖼 {error}</div>;
  if (!dataUrl) return <div className="meta">loading image…</div>;
  return (
    <img
      className="gen-image"
      src={dataUrl}
      alt="Generated image"
      title={`${path} — click to open`}
      onClick={() => void window.vo.openExternal(`file:///${path.replace(/\\/g, '/')}`)}
    />
  );
}

function ToolChip({ seg }: { seg: Extract<Segment, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const icon =
    seg.status === 'running' ? '⏳' : seg.status === 'done' ? '✓' : seg.status === 'error' ? '✗' : '·';
  return (
    <div className={`tool-chip ${seg.status}`}>
      <button className="tool-chip-head" onClick={() => setOpen(!open)}>
        <span className="tool-icon">{icon}</span> {seg.name}
      </button>
      {open && seg.result && <pre className="tool-result">{seg.result}</pre>}
      {seg.imagePath && <GeneratedImage path={seg.imagePath} />}
    </div>
  );
}

/**
 * A local server sends nothing while it loads the model and reads the prompt —
 * minutes on an older GPU. A bare "…" reads as a hang, so once the wait stops
 * looking instant, say what is happening and count.
 */
function WaitingBubble() {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      <div className="bubble pulse">…</div>
      {secs >= 8 && (
        <div className="meta">
          {secs}s — waiting for the first token. Local servers load the model and read the whole
          prompt before answering; the GPU is busy even though nothing has arrived yet.
        </div>
      )}
    </>
  );
}

/**
 * Output tokens per second of actual generation — the number people compare
 * GPUs with. Model loading, prompt processing and tool runs are excluded
 * (see UiMessage.genMs), so this is the model's speed, not the turn's
 * wall-clock. Hidden for spans too short to measure honestly.
 */
function tokensPerSec(m: UiMessage): string | null {
  const out = m.usage?.outputTokens ?? 0;
  const ms = m.genMs ?? 0;
  if (out < 2 || ms < 300) return null;
  const rate = out / (ms / 1000);
  return rate >= 10 ? rate.toFixed(0) : rate.toFixed(1);
}

export function AssistantBody({ m, hideThinking }: { m: UiMessage; hideThinking: boolean }) {
  return (
    <>
      {m.routedNote && (
        <div className="meta routed">
          <Icon name="compass" size={12} /> Vodo: {m.routedNote}
        </div>
      )}
      {(m.segments ?? []).map((seg, i) => {
        if (seg.kind === 'thinking') {
          if (hideThinking) return null;
          return (
            <details key={i} className="thinking">
              <summary>Thinking</summary>
              <pre>{seg.text}</pre>
            </details>
          );
        }
        if (seg.kind === 'tool') return <ToolChip key={i} seg={seg} />;
        return (
          <div key={i} className="bubble">
            {seg.text}
          </div>
        );
      })}
      {m.streaming && m.writing && (
        <div className="meta pulse">
          ✍ writing {m.writing.name ?? 'a tool call'} —{' '}
          {m.writing.chars >= 1024 ? `${(m.writing.chars / 1024).toFixed(1)}k` : m.writing.chars}{' '}
          chars…
        </div>
      )}
      {m.streaming && !m.writing && (m.segments ?? []).length === 0 && <WaitingBubble />}
      {!m.streaming &&
        !m.error &&
        !m.aborted &&
        !!m.usage &&
        (m.segments ?? []).every(
          (s) => (s.kind === 'text' && !s.text.trim()) || (s.kind === 'thinking' && hideThinking),
        ) && (
          <div className="meta">
            the model returned no visible text — with local models this usually means the context
            window overflowed (fewer tools / MCP servers on the agent, or a shorter prompt, helps)
          </div>
        )}
      {m.error && <div className="bubble error">⚠ {m.error}</div>}
      {m.aborted && <div className="meta">stopped</div>}
      {m.usage && (
        <div className="meta">
          {m.usage.inputTokens} in · {m.usage.outputTokens} out
          {tokensPerSec(m) !== null && ` · ${tokensPerSec(m)} tok/s`}
        </div>
      )}
    </>
  );
}

function PermissionModal() {
  const prompt = useStore((s) => s.permissions[0]);
  const respond = useStore((s) => s.respondPermission);
  if (!prompt) return null;
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>Tool permission</h3>
        <p>
          Agent <strong>{prompt.agentName}</strong> wants to run:
        </p>
        <code className="perm-tool">{prompt.name}</code>
        <pre className="perm-args">{JSON.stringify(prompt.args, null, 2)}</pre>
        {prompt.name === 'mission_create' && (
          <p className="perm-note">
            Allowing this starts an <strong>unattended</strong> agent. Unless it was created with
            autoApprove false, its own tool calls are approved automatically for the life of the
            mission — including file writes and shell commands in the project folder — and a
            mission with an interval keeps running on that schedule until you pause or delete it.
          </p>
        )}
        {prompt.name === 'group_start' && (
          <p className="perm-note">
            This is the plan — the parts above are the whole of it. Allowing starts one chat per
            part, and while the group runs the members&apos; <strong>project-folder writes and
            commands</strong> (plus their memory-map updates) are approved automatically: approving
            the plan approves the team doing its assigned work, instead of one modal per file
            until a timeout denies them. Everything else they try still asks. End group withdraws
            it all.
          </p>
        )}
        <div className="modal-actions">
          <button className="ghost" onClick={() => void respond(prompt.requestId, 'deny')}>
            Deny
          </button>
          <button className="send" onClick={() => void respond(prompt.requestId, 'allow')}>
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}

/** Ask for the goal, then hand it to Vodo to split across the agents. */
function GroupStarter({
  onStart,
  onCancel,
}: {
  onStart: (goal: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    if (!goal.trim() || busy) return;
    setBusy(true);
    setError(await onStart(goal));
    setBusy(false);
  };
  return (
    <div className="group-starter">
      <textarea
        autoFocus
        className="group-goal"
        rows={2}
        value={goal}
        placeholder="What should the group work on? (it gets split across your agents) — Enter starts, Shift+Enter for a new line"
        onChange={(e) => {
          setGoal(e.target.value);
          // Grow with the prompt: a big goal deserves to be SEEN, not
          // squeezed through one line. Capped by CSS max-height.
          e.currentTarget.style.height = 'auto';
          e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void go();
          }
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div className="group-starter-actions">
        <button className="send" disabled={busy || !goal.trim()} onClick={() => void go()}>
          {busy ? 'Splitting…' : 'Start'}
        </button>
        <button className="ghost" onClick={onCancel}>
          Cancel
        </button>
        {error && <span className="hint error-text">{error}</span>}
      </div>
    </div>
  );
}

type RowState = 'ok' | 'warn' | 'bad' | 'dim';

function StatusRow({ state, label, detail }: { state: RowState; label: string; detail: string }) {
  const icon = state === 'ok' ? '●' : state === 'warn' ? '●' : state === 'bad' ? '●' : '○';
  return (
    <div className={`status-row ${state}`}>
      <span className="status-dot-txt">{icon}</span>
      <span className="status-label">{label}</span>
      <span className="status-detail">{detail}</span>
    </div>
  );
}

/** The start page tells the truth: what is actually connected and usable. */
function StatusCard({
  provider,
  model,
  usingDefaults,
}: {
  provider: string;
  model: string;
  usingDefaults: boolean;
}) {
  const secretStatus = useStore((s) => s.secretStatus);
  const xaiOauthConnected = useStore((s) => s.xaiOauthConnected);
  const models = useStore((s) => s.models);
  const modelsError = useStore((s) => s.modelsError);
  const mcpStatus = useStore((s) => s.mcpStatus);
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeProject = projects.find((p) => p.id === activeProjectId);
  // General is folder-less by design — a folder there belongs to the CHAT, not
  // the project, so the card reads/attaches the active session's own dir.
  const isGeneral = activeProject?.id === 'general';
  const activeSessionId = useStore((s) => s.activeSessionId);
  const sessionMetas = useStore((s) => s.sessionMetas);
  const attachFolder = useStore((s) => s.attachFolder);
  const activeMeta = sessionMetas.find((m) => m.id === activeSessionId);

  const config = useStore((s) => s.config);
  const isLocal = provider === 'ollama' || provider === 'lmstudio' || provider === 'llamacpp';
  const keyOk = !!secretStatus[provider];
  // Grok login (subscription OAuth) is valid xAI auth without an API key.
  const authOk = keyOk || (provider === 'xai' && xaiOauthConnected);
  const providerDisabled = (config?.disabledProviders ?? []).includes(provider);
  const routeMode = config?.routeMode ?? 'off';
  const autoRouting = routeMode !== 'off' && usingDefaults;
  // The loaded model list belongs to the header provider; only trust it when
  // this agent actually uses the app defaults.
  const listUsable = usingDefaults && models.length > 0;

  let providerState: RowState;
  let providerDetail: string;
  if (providerDisabled) {
    providerState = 'bad';
    providerDetail =
      provider === 'xai'
        ? 'turned off in Settings — Grok login / API key stay saved; flip On to use again'
        : 'turned off in Settings — key stays saved; flip On to use again';
  } else if (isLocal) {
    providerState = listUsable ? 'ok' : 'bad';
    providerDetail = listUsable
      ? `server reachable — ${models.length} model(s) installed`
      : (modelsError ??
        (provider === 'llamacpp'
          ? 'no llama.cpp server reachable — add or enable one in Settings'
          : 'server not reachable — is it running?'));
  } else if (provider === 'xai') {
    providerState = authOk ? 'ok' : 'bad';
    if (xaiOauthConnected && keyOk) {
      providerDetail = `signed in with Grok + API key (${secretStatus[provider]})`;
    } else if (xaiOauthConnected) {
      providerDetail = 'signed in with Grok (SuperGrok / X Premium)';
    } else if (keyOk) {
      providerDetail = `API key saved (${secretStatus[provider]})`;
    } else {
      providerDetail = 'no credentials — add an API key or Sign in with X in Settings';
    }
  } else {
    providerState = keyOk ? 'ok' : 'bad';
    providerDetail = keyOk ? `API key saved (${secretStatus[provider]})` : 'no API key — add it in Settings';
  }

  let modelState: RowState;
  let modelDetail: string;
  if (autoRouting) {
    modelState = 'ok';
    modelDetail =
      routeMode === 'agents'
        ? `Vodo delegates to your agents, Auto as fallback (manual fallback: ${model || 'none'})`
        : routeMode === 'agents-only'
          ? `Vodo always hands work to one of your agents (no agents → ${model || 'none'})`
          : `Vodo auto-routes each message (fallback: ${model || 'none'})`;
  } else if (!model) {
    modelState = 'bad';
    modelDetail = 'no model selected';
  } else if (listUsable) {
    const known = models.some((m) => m.id === model);
    modelState = known ? 'ok' : 'warn';
    modelDetail = known
      ? model
      : `"${model}" is not in ${provider}'s model list — pick one from the dropdown`;
  } else {
    modelState = 'dim';
    modelDetail = `${model} (can't verify — model list unavailable)`;
  }

  const connected = mcpStatus.filter((s) => s.connected);
  const toolCount = connected.reduce((n, s) => n + s.toolCount, 0);
  const ready = providerState === 'ok' && modelState !== 'bad' && modelState !== 'warn';

  return (
    <div className="empty-state">
      <h2>{ready ? 'The shed is open.' : 'Not ready yet.'}</h2>
      <div className="status-card">
        <StatusRow state={providerState} label={provider} detail={providerDetail} />
        <StatusRow state={modelState} label="model" detail={modelDetail} />
        <StatusRow
          state={connected.length > 0 ? 'ok' : 'dim'}
          label="tools"
          detail={
            connected.length > 0
              ? `${connected.length} MCP server(s) connected — ${toolCount} tools`
              : 'no MCP servers connected (Settings → MCP servers)'
          }
        />
        {activeProject && isGeneral && (
          <StatusRow
            state={activeMeta?.dir ? 'ok' : 'dim'}
            label="folder"
            detail={
              activeMeta?.dir ??
              'generic chat — loose files land in the generic folder (Settings); attach a folder for project work'
            }
          />
        )}
        {activeProject && !isGeneral && (
          <StatusRow
            state={activeProject.dir ? 'ok' : 'warn'}
            label="folder"
            detail={
              activeProject.dir ??
              'no project folder — agents cannot build here and routing treats chats as talk'
            }
          />
        )}
      </div>
      {isGeneral && activeMeta && !activeMeta.dir && (
        <button className="send" onClick={() => void attachFolder()}>
          Work in a folder…
        </button>
      )}
      {activeProject && !isGeneral && !activeProject.dir && (
        <button
          className="send"
          onClick={() =>
            void (async () => {
              const dir = await window.vo.scaffoldPickDir();
              if (dir) await window.vo.projectSetDir(activeProject.id, dir);
            })()
          }
        >
          Attach project folder…
        </button>
      )}
      <p>Drop files or images anywhere to attach them. Hold Ctrl+Space to talk.</p>
    </div>
  );
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function fmtCost(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** Mode switch on top, usage below, code review underneath — the composer's left chip. */
function ProjectUsage({ projectId }: { projectId: string | undefined }) {
  const usage = useStore((s) => s.usage);
  const startReview = useStore((s) => s.startReview);
  const reviewState = useStore((s) =>
    s.activeSessionId ? s.review[s.activeSessionId] : undefined,
  );
  const streaming = useStore((s) =>
    s.activeSessionId ? (s.sessions[s.activeSessionId]?.streaming ?? false) : false,
  );
  const hasFolder = useStore((s) => {
    const meta = s.sessionMetas.find((m) => m.id === s.activeSessionId);
    if (!meta) return false;
    return !!(meta.dir ?? s.projects.find((p) => p.id === meta.projectId)?.dir);
  });
  const totals = projectId ? usage?.perProject[projectId] : undefined;
  const t = totals ?? { inputTokens: 0, outputTokens: 0, cost: 0 };
  return (
    <div className="usage-chip">
      <ModeToggle />
      <span
        className="usage-tokens"
        title="This project's total usage, across all of its chats"
      >
        <span className="usage-cost">{fmtCost(t.cost)}</span>
        {'  '}
        {fmtTokens(t.inputTokens)} in · {fmtTokens(t.outputTokens)} out
      </span>
      <button
        className="review-btn"
        disabled={!hasFolder || !!reviewState || streaming}
        title={
          hasFolder
            ? 'Start a real code review of this chat’s folder — findings, then proposed fixes you approve or decline'
            : 'Code review needs a folder — use a project with one, or attach a folder to this chat'
        }
        onClick={() => void startReview()}
      >
        <Icon name="search" size={12} />{' '}
        {reviewState === 'running' ? 'Reviewing…' : reviewState === 'verdict' ? 'Awaiting verdict' : 'Code review'}
      </button>
    </div>
  );
}

function AdvisorBanner() {
  const suggestion = useStore((s) => s.mcpSuggestion);
  const dismiss = useStore((s) => s.dismissMcpSuggestion);
  if (!suggestion) return null;
  return (
    <div className="checkin-banner advisor">
      <div className="checkin-text">
        <strong>💡 Tool suggestion</strong>
        <p>{suggestion.reason}</p>
      </div>
      <button onClick={() => dismiss(true)}>Find servers</button>
      <button className="ghost" onClick={() => dismiss(false)}>
        Not now
      </button>
    </div>
  );
}

function CheckinBanner() {
  const checkin = useStore((s) => s.checkin);
  const dismiss = useStore((s) => s.dismissCheckin);
  if (!checkin) return null;
  return (
    <div className="checkin-banner">
      <div className="checkin-text">
        <strong>Quick check-in</strong> ({checkin.reasons.join('; ')})
        <p>{checkin.prompt}</p>
      </div>
      <button className="chip-x" onClick={dismiss}>
        ×
      </button>
    </div>
  );
}

function SuggestPanel({ onApply }: { onApply: () => void }) {
  const suggestions = useStore((s) => s.suggestions);
  const applySuggestion = useStore((s) => s.applySuggestion);
  const clearSuggestions = useStore((s) => s.clearSuggestions);
  if (!suggestions) return null;
  return (
    <div className="suggest-panel">
      <div className="suggest-head">
        <span>Model suggestions (advisory — you decide)</span>
        <button className="chip-x" onClick={clearSuggestions}>
          ×
        </button>
      </div>
      {suggestions.length === 0 && <p className="hint">No rated model matches this task.</p>}
      {suggestions.map((r) => (
        <div key={r.model.id} className="suggest-row">
          <span className="grow">{r.rationale}</span>
          <button
            onClick={() => {
              void applySuggestion(r);
              onApply();
            }}
          >
            Use
          </button>
        </div>
      ))}
    </div>
  );
}

export function Chat() {
  const config = useStore((s) => s.config);
  const models = useStore((s) => s.models);
  const modelsError = useStore((s) => s.modelsError);
  const catalog = useStore((s) => s.catalog);
  // Grok login prefers OAuth over API key — show subscription (free) pricing.
  const xaiOauthConnected = useStore((s) => s.xaiOauthConnected);
  const suggestFor = useStore((s) => s.suggestFor);
  const saveAgents = useStore((s) => s.saveAgents);
  const editAgent = useStore((s) => s.editAgent);
  const activeMeta = useStore((s) => s.sessionMetas.find((m) => m.id === s.activeSessionId));
  const activeAgentId = activeMeta?.agentId ?? 'default';
  /** Chat rendered inside the Mr Homelab tab — his agent is fixed there. */
  const isHomelabTab = useStore((s) => s.view === 'homelab');
  const assembleOn = useStore(
    (s) => !!s.projects.find((p) => p.id === activeMeta?.projectId)?.assemble,
  );
  const session = useStore((s) =>
    s.activeSessionId ? s.sessions[s.activeSessionId] : undefined,
  );
  const attachments = useStore((s) => s.attachments);
  const setComposerDraft = useStore((s) => s.setComposerDraft);
  const send = useStore((s) => s.send);
  const stop = useStore((s) => s.stop);
  const saveConfig = useStore((s) => s.saveConfig);
  const loadModels = useStore((s) => s.loadModels);
  const setSessionAgent = useStore((s) => s.setSessionAgent);
  const newSession = useStore((s) => s.newSession);
  const addAttachment = useStore((s) => s.addAttachment);
  const removeAttachment = useStore((s) => s.removeAttachment);
  const attachFolder = useStore((s) => s.attachFolder);
  const detachFolder = useStore((s) => s.detachFolder);
  const resolveReview = useStore((s) => s.resolveReview);
  const reviewVerdict = useStore(
    (s) => (s.activeSessionId ? s.review[s.activeSessionId] : undefined) === 'verdict',
  );

  const activeSessionId = useStore((s) => s.activeSessionId);
  // Draft lives in the store so leaving Chat (another nav tab) does not wipe it.
  // Keyed by session so switching chats keeps each thread's unsent text.
  const input = useStore((s) =>
    s.activeSessionId ? (s.composerDrafts[s.activeSessionId] ?? '') : '',
  );
  const setInput = (value: string | ((prev: string) => string)) => {
    const sessionId = useStore.getState().activeSessionId;
    if (!sessionId) return;
    const next =
      typeof value === 'function'
        ? value(useStore.getState().composerDrafts[sessionId] ?? '')
        : value;
    setComposerDraft(sessionId, next);
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** Follow new output only while the user is already near the bottom. */
  const pinToBottomRef = useRef(true);

  const { recording, live, voiceError, pttStart, pttStop, liveToggle } = useVoice((text) =>
    setInput((prev) => (prev ? `${prev} ${text}` : text)),
  );

  // Push-to-talk hotkey: hold Ctrl+Space.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && e.ctrlKey && !e.repeat) {
        e.preventDefault();
        void pttStart();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') void pttStop();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [pttStart, pttStop]);

  const messages = session?.messages ?? [];
  const streaming = session?.streaming ?? false;

  const isNearBottom = (el: HTMLElement, threshold = 80) =>
    el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;

  const scrollToBottom = (behavior: ScrollBehavior = 'auto') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  };

  const onMessagesScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinToBottomRef.current = isNearBottom(el);
  };

  // New chat / session switch: jump to latest and re-enable follow.
  useEffect(() => {
    pinToBottomRef.current = true;
    // Wait a frame so the new session's messages are painted.
    requestAnimationFrame(() => scrollToBottom());
  }, [activeSessionId]);

  // While pinned, keep the viewport on the latest tokens/tools as they stream in.
  useEffect(() => {
    if (!pinToBottomRef.current) return;
    scrollToBottom();
  }, [messages]);

  // A group run belongs to the project and shows above the thread — the
  // coordinator keeps its own conversation while the members work.
  const groups = useStore((s) => s.groups);
  const startGroup = useStore((s) => s.startGroup);
  const [groupPrompt, setGroupPrompt] = useState(false);
  // A live group's view restores from ANY of its chats — coordinator or
  // member. Opening one of them later (or after a restart) brings all the
  // agent windows back; only unrelated chats in the project stay plain.
  // (Groups from before coordinator tracking carry no coordinatorId; those
  // stay project-wide until ended.)
  const activeGroup = groups.find(
    (g) =>
      !g.endedAt &&
      (g.coordinatorId === activeSessionId ||
        g.members.some((m) => m.sessionId === activeSessionId) ||
        (!g.coordinatorId && g.projectId === activeMeta?.projectId)),
  );
  // Expanded, the grid IS the chat surface (coordinator tile bottom-right);
  // folded, the classic thread returns. The composer talks to the coordinator
  // either way.
  const [groupOpen, setGroupOpen] = useState(true);
  const groupTakesOver = !!activeGroup && groupOpen;
  const openSession = useStore((s) => s.openSession);
  // Opening any chat of a group unfolds its grid — that is what "restore the
  // group" means — EXCEPT when the switch came from a pane's own "open full
  // size", which is an explicit request for the solo view.
  const soloOpenRef = useRef(false);
  const activeGroupId = activeGroup?.id;
  useEffect(() => {
    if (soloOpenRef.current) {
      soloOpenRef.current = false;
      return;
    }
    if (activeGroupId) setGroupOpen(true);
  }, [activeSessionId, activeGroupId]);

  // A local model has to be read off disk before it can answer — up to a
  // minute for a big one. Start that the moment the agent is chosen so the
  // load overlaps with the user typing, instead of beginning after Send.
  // Mirrors how the real turn resolves provider+model, or it would warm the
  // wrong instance and gain nothing.
  const warmAgent = config?.agents.find((a) => a.id === activeAgentId);
  const warmProvider = warmAgent?.provider ?? config?.defaultProvider ?? '';
  const warmModel = warmAgent?.model ?? config?.defaultModel ?? '';
  useEffect(() => {
    if (!LOCAL_PROVIDERS.has(warmProvider) || !warmModel) return;
    void window.vo.modelWarm(warmProvider, warmModel).catch(() => undefined);
  }, [warmProvider, warmModel]);

  if (!config) return <div className="empty-state">Loading…</div>;

  const activeAgent = config.agents.find((a) => a.id === activeAgentId);
  const usingDefaults = !activeAgent?.provider && !activeAgent?.model;

  const submit = () => {
    if (!input.trim() && attachments.length === 0) return;
    pinToBottomRef.current = true; // user sent something — follow the reply
    void send(input); // while streaming this becomes a graceful injection
    setInput('');
    requestAnimationFrame(() => scrollToBottom());
  };

  const onProviderChange = async (provider: string) => {
    await saveConfig({ defaultProvider: provider });
    await loadModels(provider);
  };

  const onFiles = (files: FileList | null) => {
    if (!files) return;
    for (const file of files) void addAttachment(file);
  };

  const knownModel = models.some((m) => m.id === config.defaultModel);

  const decorate = (modelId: string): string => {
    const rec = catalog?.records.find((r) => r.id === modelId);
    const bits: string[] = [rec?.displayName ?? modelId];
    if (rec?.contextLength) bits.push(`${Math.round(rec.contextLength / 1000)}k`);
    // Pricing is per-ENDPOINT. The catalog carries OpenRouter / API rates;
    // NVIDIA's free tier and Grok subscription login must not inherit those.
    if (config.defaultProvider === 'nvidia') {
      bits.push('free endpoint');
    } else if (
      config.defaultProvider === 'xai' &&
      (xaiOauthConnected ||
        (rec?.pricing?.inputPerMTok === 0 && (rec?.pricing?.outputPerMTok ?? 0) === 0))
    ) {
      // OAuth flag OR catalog already zeroed by main (Grok login active).
      bits.push('free (Grok login)');
    } else if (
      rec?.pricing?.inputPerMTok !== undefined &&
      rec.pricing.inputPerMTok >= 0 &&
      (rec.pricing.outputPerMTok ?? 0) >= 0
    ) {
      bits.push(`$${rec.pricing.inputPerMTok}/$${rec.pricing.outputPerMTok} per MTok`);
    } else if (rec?.estMemGb !== undefined) {
      bits.push(rec.fit.fits ? `local · fits ✓` : `local · too big ✗`);
    }
    return bits.join(' · ');
  };

  return (
    <div
      className="chat"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onFiles(e.dataTransfer.files);
      }}
    >
      <header className="chat-header">
        {/* The Homelab tab belongs to Mr Homelab — swapping agents there would
            leave the tab named after someone who is not answering in it. */}
        {isHomelabTab ? (
          <span className="chat-agent-fixed" title="This tab is Mr Homelab's own chat">
            Mr Homelab
          </span>
        ) : (
          <select value={activeAgentId} onChange={(e) => void setSessionAgent(e.target.value)}>
            <option value="default">Vodo</option>
            {/* Mr Homelab answers in his own tab; an agent taken off duty is
                not on offer. A chat already bound to one still shows it. */}
            {config.agents
              .filter(
                (a) =>
                  a.id === activeAgentId ||
                  (a.id !== HOMELAB_AGENT_ID && a.enabled !== false),
              )
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.enabled === false ? ' (off)' : ''}
                </option>
              ))}
          </select>
        )}
        {/* Picking an agent talks to it DIRECTLY — routing, delegation and
            group projects all belong to Vodo, and nothing used to say so. */}
        {!isHomelabTab && activeAgentId !== 'default' && (config.routeMode ?? 'auto') !== 'off' && (
          <span
            className="meta"
            title="This chat goes straight to this agent. Vodo is not routing it, so it will not pick a model, hand work to another agent, or split it across the team — switch to Vodo for that."
          >
            direct — Vodo not routing
          </span>
        )}
        {isHomelabTab && activeAgent ? (
          /* His tab is where he is configured, so the model line next to his
             name is a real picker — the same choice Vodo's header offers. */
          <>
            <select
              value={activeAgent.provider ?? ''}
              title="Provider for Mr Homelab"
              onChange={(e) => {
                const provider = e.target.value;
                void saveAgents(
                  config.agents.map((a) =>
                    a.id === activeAgent.id
                      ? {
                          ...a,
                          ...(provider
                            ? { provider: provider as AgentSpec['provider'] }
                            : { provider: undefined }),
                          // A model id belongs to one provider — never carry it over.
                          model: undefined,
                        }
                      : a,
                  ),
                );
              }}
            >
              <option value="">default provider</option>
              {PROVIDERS.filter(Boolean).map((p) => (
                <option key={p} value={p}>
                  {(config.disabledProviders ?? []).includes(p) ? `${p} (off)` : p}
                </option>
              ))}
            </select>
            <div className="homelab-model-picker">
              <ModelPicker
                provider={activeAgent.provider ?? config.defaultProvider}
                value={activeAgent.model ?? ''}
                placeholder="default model"
                onChange={(id) =>
                  void saveAgents(
                    config.agents.map((a) =>
                      a.id === activeAgent.id ? { ...a, model: id || undefined } : a,
                    ),
                  )
                }
              />
            </div>
            <button
              className="ghost"
              title="His prompt, routing hints and MCP servers"
              onClick={() => editAgent(HOMELAB_AGENT_ID)}
            >
              Edit
            </button>
          </>
        ) : usingDefaults ? (
          <>
            <select
              value={config.defaultProvider}
              onChange={(e) => void onProviderChange(e.target.value)}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {(config.disabledProviders ?? []).includes(p) ? `${p} (off)` : p}
                </option>
              ))}
            </select>
            {models.length > 0 ? (
              <select
                value={knownModel ? config.defaultModel : ''}
                onChange={(e) => void saveConfig({ defaultModel: e.target.value })}
              >
                {!knownModel && <option value="">{config.defaultModel || 'pick a model'}</option>}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {decorate(m.id)}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="model-input"
                value={config.defaultModel}
                placeholder="model id"
                onChange={(e) => void saveConfig({ defaultModel: e.target.value })}
                title={modelsError ?? 'Type a model id'}
              />
            )}
          </>
        ) : (
          <span className="meta">
            {activeAgent?.provider ?? config.defaultProvider} ·{' '}
            {activeAgent?.model ?? config.defaultModel}
          </span>
        )}
        <div className="spacer" />
        <button
          className="ghost"
          title="Split this goal across your agents — they work side by side, each in its own chat"
          disabled={
            !activeMeta ||
            config.agents.filter((a) => a.id !== HOMELAB_AGENT_ID && a.enabled !== false).length ===
              0
          }
          onClick={() => setGroupPrompt(true)}
        >
          Group project
        </button>
        {/* Always General: this button used to open the chat in the ACTIVE
            project, so the previous chat's folder rode along — seen live: a
            fresh chat showing the last project's workspace. A new chat is a
            clean slate; the sidebar's per-project + is the scoped one. */}
        <button
          className="ghost"
          title="Start a fresh chat (General — no folder). The sidebar's + makes project chats."
          onClick={() => void newSession('general')}
        >
          New chat
        </button>
      </header>

      {groupPrompt && (
        <GroupStarter
          onCancel={() => setGroupPrompt(false)}
          onStart={async (goal) => {
            const err = await startGroup(goal);
            if (!err) setGroupPrompt(false);
            return err;
          }}
        />
      )}
      {activeGroup && (
        <GroupView
          group={activeGroup}
          coordinatorId={activeGroup.coordinatorId || (activeSessionId ?? '')}
          activeSessionId={activeSessionId ?? ''}
          collapsed={!groupOpen}
          onToggle={() => setGroupOpen(!groupOpen)}
          onOpenSolo={(sid) => {
            // Full-size view of one member = that chat active, grid folded.
            // The header's ▸ brings the grid back.
            soloOpenRef.current = true;
            void openSession(sid);
            setGroupOpen(false);
          }}
        />
      )}

      {!groupTakesOver && (
      <div className="messages" ref={scrollRef} onScroll={onMessagesScroll}>
        {messages.length === 0 && (
          <StatusCard
            provider={activeAgent?.provider ?? config.defaultProvider}
            model={activeAgent?.model ?? config.defaultModel}
            usingDefaults={usingDefaults}
          />
        )}
        {messages.map((m) => (
          <div key={m.id} className={`message ${m.role}`}>
            {m.role === 'user' ? (
              <>
                {m.attachments && m.attachments.length > 0 && (
                  <div className="attachment-row">
                    {m.attachments.map((a, i) => (
                      <span key={i} className="attachment-chip">
                        <Icon name={a.kind === 'image' ? 'image' : 'file'} size={12} /> {a.name}
                      </span>
                    ))}
                  </div>
                )}
                {m.text && <div className="bubble">{m.text}</div>}
                {m.queuedNote && <div className="meta">queued — delivered next turn</div>}
              </>
            ) : (
              <AssistantBody
                m={m}
                hideThinking={activeAgent?.thinkingVisibility === 'hidden'}
              />
            )}
          </div>
        ))}
      </div>
      )}

      <footer className="composer-wrap">
        <CheckinBanner />
        <AdvisorBanner />
        <SuggestPanel onApply={() => undefined} />
        {reviewVerdict && !streaming && (
          <div className="review-verdict">
            <span className="rv-label">
              <Icon name="search" size={12} /> Review proposal — your verdict:
            </span>
            <button
              className="rv-approve"
              title="Apply the proposed fixes (the agent edits and verifies)"
              onClick={() => void resolveReview('approve')}
            >
              Approve
            </button>
            <button
              className="rv-revise"
              title="Ask for changes to the proposal before anything is applied"
              onClick={() => {
                void resolveReview('clear');
                setInput('Revise the proposal: ');
              }}
            >
              Revise
            </button>
            <button
              className="rv-reject"
              title="Decline — nothing gets changed"
              onClick={() => void resolveReview('reject')}
            >
              Don&apos;t accept
            </button>
          </div>
        )}
        {voiceError && (
          <div className="hint error-text preview-hint">
            <Icon name="mic" size={12} /> {voiceError}
          </div>
        )}
        {(attachments.length > 0 || activeMeta?.dir) && (
          <div className="attachment-row staged">
            {activeMeta?.dir && (
              <span className="attachment-chip folder-chip" title={activeMeta.dir}>
                <Icon name="folder" size={12} /> {activeMeta.dir.split(/[\\/]/).pop()}
                <button
                  className="chip-x"
                  title="Detach this folder from the chat"
                  onClick={() => void detachFolder()}
                >
                  ×
                </button>
              </span>
            )}
            {attachments.map((a, i) => (
              <span key={i} className="attachment-chip">
                <Icon name={a.kind === 'image' ? 'image' : 'file'} size={12} /> {a.name}
                <button className="chip-x" onClick={() => removeAttachment(i)}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer">
          <ProjectUsage projectId={activeMeta?.projectId} />
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              onFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <div className="composer-tools">
            <div className="composer-tools-row">
              <button
                className={`ghost attach mini ${live !== 'off' ? 'live-on' : ''}`}
                title={
                  live === 'off'
                    ? 'Start live voice chat (hands-free)'
                    : `Live chat: ${live} — click to stop`
                }
                onClick={liveToggle}
              >
                <Icon name="headset" size={14} /> {live === 'off' ? 'Live' : live}
              </button>
              {activeAgentId === 'default' && (
                <button
                  className={`ghost attach mini ${config.thinkingDefault ? 'thinking-on' : ''}`}
                  title={
                    config.thinkingDefault
                      ? 'Extended thinking ON — click to disable'
                      : 'Extended thinking OFF — click to enable'
                  }
                  onClick={() => void saveConfig({ thinkingDefault: !config.thinkingDefault })}
                >
                  <Icon name="brain" size={14} /> Think
                </button>
              )}
            </div>
            <div className="composer-tools-row">
              <button className="ghost attach" title="Attach files" onClick={() => fileRef.current?.click()}>
                <Icon name="paperclip" />
              </button>
              <button
                className={`ghost attach ${activeMeta?.dir ? 'folder-on' : ''}`}
                title={
                  activeMeta?.dir
                    ? `Chat folder: ${activeMeta.dir} — click to change`
                    : 'Point this chat at a folder — browse files, review code, catalog photos'
                }
                onClick={() => void attachFolder()}
              >
                <Icon name="folder" />
              </button>
              <button
                className="ghost attach"
                title="Suggest the cheapest adequate model for this message"
                disabled={!input.trim()}
                onClick={() => void suggestFor(input)}
              >
                <Icon name="sparkles" />
              </button>
              <button
                className={`ghost attach ${recording ? 'recording' : ''}`}
                title="Hold to talk (or hold Ctrl+Space) — release to transcribe into the input"
                onPointerDown={() => void pttStart()}
                onPointerUp={() => void pttStop()}
                onPointerLeave={() => void pttStop()}
              >
                <Icon name="mic" />
              </button>
            </div>
          </div>
          <textarea
            value={input}
            placeholder="Ask anything… (Enter to send, Shift+Enter for a new line)"
            rows={3}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              const files = e.clipboardData?.files;
              if (files && files.length > 0) {
                e.preventDefault();
                onFiles(files);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="send-col">
            <ContextChip
              messages={messages}
              model={activeAgent?.model ?? config.defaultModel}
              streaming={streaming}
              assemble={assembleOn}
            />
            <div className="send-btns">
              {streaming ? (
                <>
                  <button
                    className="send"
                    title="Add this mid-task without resetting the run"
                    onClick={submit}
                    disabled={!input.trim() && attachments.length === 0}
                  >
                    ↷ Inject
                  </button>
                  <button className="stop" onClick={() => void stop()}>
                    ■ Stop
                  </button>
                </>
              ) : (
                <button
                  className="send"
                  onClick={submit}
                  disabled={!input.trim() && attachments.length === 0}
                >
                  Send
                </button>
              )}
            </div>
          </div>
        </div>
      </footer>
      <PermissionModal />
    </div>
  );
}
