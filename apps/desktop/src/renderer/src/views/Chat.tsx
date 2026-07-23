import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { useStore, type Segment, type UiMessage } from '../state/store';
import { useVoice } from '../voice/useVoice';

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
    let lastUsage: { inputTokens: number; outputTokens: number } | undefined;
    for (const m of messages) {
      chars += m.text?.length ?? 0;
      for (const seg of m.segments ?? []) {
        if (seg.kind === 'tool') chars += (seg.result?.length ?? 0) + 60;
        else chars += seg.text.length;
      }
      chars += (m.attachments?.length ?? 0) * 6400; // ~1.6k tokens per image
      if (m.usage) lastUsage = m.usage;
    }
    return { estTokens: Math.round(chars / 4) + 1500, lastUsage };
  }, [messages]);

  const record = catalog?.records.find((r) => r.id === model);
  const windowTokens = record?.contextLength ?? 128_000;
  // With Smart context on, the request is digest + recent buffer — the last
  // turn's ACTUAL input tokens are the honest gauge, not the full-history sum.
  const assembled = assemble && !!lastUsage;
  const basis = assembled ? lastUsage!.inputTokens : estTokens;
  const pct = Math.min(100, Math.round((basis / windowTokens) * 100));
  const level = pct >= 85 ? 'hot' : pct >= 60 ? 'warm' : 'ok';

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
                <span>assembled request (last turn)</span>
                <b>
                  {fmtTokens(lastUsage!.inputTokens)} · {pct}%
                </b>
              </div>
              <div className="ctx-row">
                <span>full history (est.)</span>
                <b>{fmtTokens(estTokens)}</b>
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
              ? 'Smart context is on — requests carry the map digest plus recent turns; older turns live in the memory bank, one tool call away.'
              : `The whole conversation replays every turn${routeMode === 'auto' ? ' (window shown is the selected fallback model)' : ''}. Compacting rewrites it into a short briefing — same chat, fraction of the tokens.`}
          </p>
          {error && <p className="hint error-text">{error}</p>}
          <button className="send ctx-compact" disabled={busy || streaming} onClick={() => void compact()}>
            {busy ? 'Compacting…' : 'Compact conversation'}
          </button>
        </div>
      )}
      <button
        className={`ghost ctx-chip ${level}`}
        title="Context window usage — click for details"
        onClick={() => setOpen(!open)}
      >
        <Icon name="gauge" size={12} /> {pct}%
      </button>
    </div>
  );
}

const PROVIDERS = ['anthropic', 'ollama', 'lmstudio', 'openai', 'openrouter', 'xai'];

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
    </div>
  );
}

function AssistantBody({ m, hideThinking }: { m: UiMessage; hideThinking: boolean }) {
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
      {m.streaming && (m.segments ?? []).length === 0 && <div className="bubble pulse">…</div>}
      {m.error && <div className="bubble error">⚠ {m.error}</div>}
      {m.aborted && <div className="meta">stopped</div>}
      {m.usage && (
        <div className="meta">
          {m.usage.inputTokens} in · {m.usage.outputTokens} out
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
  const models = useStore((s) => s.models);
  const modelsError = useStore((s) => s.modelsError);
  const mcpStatus = useStore((s) => s.mcpStatus);
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const config = useStore((s) => s.config);
  const isLocal = provider === 'ollama' || provider === 'lmstudio';
  const keyOk = !!secretStatus[provider];
  const routeMode = config?.routeMode ?? 'off';
  const autoRouting = routeMode !== 'off' && usingDefaults;
  // The loaded model list belongs to the header provider; only trust it when
  // this agent actually uses the app defaults.
  const listUsable = usingDefaults && models.length > 0;

  let providerState: RowState;
  let providerDetail: string;
  if (isLocal) {
    providerState = listUsable ? 'ok' : 'bad';
    providerDetail = listUsable
      ? `server reachable — ${models.length} model(s) installed`
      : (modelsError ?? 'server not reachable — is it running?');
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
        {activeProject && (
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
      {activeProject && !activeProject.dir && (
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

/** Per-project token/cost tracker — aggregates every chat in the project. */
function ProjectUsage({ projectId }: { projectId: string | undefined }) {
  const usage = useStore((s) => s.usage);
  const totals = projectId ? usage?.perProject[projectId] : undefined;
  const t = totals ?? { inputTokens: 0, outputTokens: 0, cost: 0 };
  return (
    <div className="usage-chip" title="This project's total usage, across all of its chats">
      <span className="usage-cost">{fmtCost(t.cost)}</span>
      <span className="usage-tokens">
        {fmtTokens(t.inputTokens)} in · {fmtTokens(t.outputTokens)} out
      </span>
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
  const suggestFor = useStore((s) => s.suggestFor);
  const activeMeta = useStore((s) => s.sessionMetas.find((m) => m.id === s.activeSessionId));
  const activeAgentId = activeMeta?.agentId ?? 'default';
  const assembleOn = useStore(
    (s) => !!s.projects.find((p) => p.id === activeMeta?.projectId)?.assemble,
  );
  const session = useStore((s) =>
    s.activeSessionId ? s.sessions[s.activeSessionId] : undefined,
  );
  const attachments = useStore((s) => s.attachments);
  const send = useStore((s) => s.send);
  const stop = useStore((s) => s.stop);
  const saveConfig = useStore((s) => s.saveConfig);
  const loadModels = useStore((s) => s.loadModels);
  const setSessionAgent = useStore((s) => s.setSessionAgent);
  const newSession = useStore((s) => s.newSession);
  const addAttachment = useStore((s) => s.addAttachment);
  const removeAttachment = useStore((s) => s.removeAttachment);

  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  if (!config) return <div className="empty-state">Loading…</div>;

  const activeAgent = config.agents.find((a) => a.id === activeAgentId);
  const usingDefaults = !activeAgent?.provider && !activeAgent?.model;

  const submit = () => {
    if (!input.trim() && attachments.length === 0) return;
    void send(input); // while streaming this becomes a graceful injection
    setInput('');
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
    if (!rec) return modelId;
    const bits: string[] = [rec.displayName ?? modelId];
    if (rec.contextLength) bits.push(`${Math.round(rec.contextLength / 1000)}k`);
    if (
      rec.pricing?.inputPerMTok !== undefined &&
      rec.pricing.inputPerMTok >= 0 &&
      (rec.pricing.outputPerMTok ?? 0) >= 0
    ) {
      bits.push(`$${rec.pricing.inputPerMTok}/$${rec.pricing.outputPerMTok} per MTok`);
    } else if (rec.estMemGb !== undefined) {
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
        <select value={activeAgentId} onChange={(e) => void setSessionAgent(e.target.value)}>
          <option value="default">Vodo</option>
          {config.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        {usingDefaults ? (
          <>
            <select
              value={config.defaultProvider}
              onChange={(e) => void onProviderChange(e.target.value)}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
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
          title="Start a new chat in this project"
          onClick={() => void newSession(activeMeta?.projectId)}
        >
          New chat
        </button>
      </header>

      <div className="messages" ref={scrollRef}>
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

      <footer className="composer-wrap">
        <CheckinBanner />
        <AdvisorBanner />
        <SuggestPanel onApply={() => undefined} />
        {voiceError && (
          <div className="hint error-text preview-hint">
            <Icon name="mic" size={12} /> {voiceError}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="attachment-row staged">
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
