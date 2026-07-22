import { useEffect, useState } from 'react';
import type { AgentSpec, ModelInfo } from '@vo-coder/providers';
import { useStore } from '../state/store';

const PROVIDERS = ['', 'anthropic', 'ollama', 'lmstudio', 'openai', 'openrouter', 'xai'];

function AgentForm({
  initial,
  mcpServerNames,
  defaultProvider,
  onSave,
  onCancel,
}: {
  initial: AgentSpec | null;
  mcpServerNames: string[];
  defaultProvider: string;
  onSave: (spec: AgentSpec) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? '');
  const [provider, setProvider] = useState(initial?.provider ?? '');
  const [model, setModel] = useState(initial?.model ?? '');
  const [servers, setServers] = useState<string[]>(initial?.mcpServers ?? []);
  const [thinking, setThinking] = useState(initial?.thinking?.enabled ?? false);
  const [thinkingVisibility, setThinkingVisibility] = useState(
    initial?.thinkingVisibility ?? 'visible',
  );
  const [injectionMode, setInjectionMode] = useState(initial?.injectionMode ?? 'queue');
  const [models, setModels] = useState<ModelInfo[]>([]);

  // Same dropdown experience as the chat header: list the models of whichever
  // provider this agent will actually use; free-text fallback when the list
  // can't load (e.g. missing key).
  const effectiveProvider = provider || defaultProvider;
  useEffect(() => {
    let cancelled = false;
    setModels([]);
    window.vo
      .listModels(effectiveProvider)
      .then((list) => {
        if (!cancelled) setModels(list);
      })
      .catch(() => {
        /* fall back to the text input */
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveProvider]);

  const knownModel = models.some((m) => m.id === model);

  const toggleServer = (s: string) =>
    setServers((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  return (
    <div className="agent-form">
      <div className="field-row">
        <label>name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Researcher" />
      </div>
      <div className="field-row">
        <label>provider</label>
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p || '(app default)'}
            </option>
          ))}
        </select>
      </div>
      <div className="field-row">
        <label>model</label>
        {models.length > 0 ? (
          <select value={knownModel ? model : ''} onChange={(e) => setModel(e.target.value)}>
            <option value="">
              {provider ? 'pick a model (required)' : model || '(app default)'}
            </option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName ?? m.id}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={provider ? 'required for a provider override' : '(app default)'}
          />
        )}
      </div>
      <div className="field-row">
        <label>system prompt</label>
        <textarea
          rows={3}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="What is this agent for?"
        />
      </div>
      {mcpServerNames.length > 0 && (
        <div className="field-row">
          <label>MCP servers</label>
          <div className="checkbox-row">
            {mcpServerNames.map((s) => (
              <label key={s} className="checkbox">
                <input
                  type="checkbox"
                  checked={servers.includes(s)}
                  onChange={() => toggleServer(s)}
                />
                {s}
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="field-row">
        <label>thinking</label>
        <label className="checkbox">
          <input type="checkbox" checked={thinking} onChange={(e) => setThinking(e.target.checked)} />
          extended thinking
        </label>
        <select
          value={thinkingVisibility}
          onChange={(e) => setThinkingVisibility(e.target.value as 'visible' | 'hidden')}
          title="Show or hide the reasoning stream in chat"
        >
          <option value="visible">show reasoning</option>
          <option value="hidden">hide reasoning</option>
        </select>
      </div>
      <div className="field-row">
        <label>mid-task input</label>
        <select
          value={injectionMode}
          onChange={(e) => setInjectionMode(e.target.value as 'queue' | 'abort-and-resend')}
          title="How a message typed during generation is handled"
        >
          <option value="queue">queue until the turn finishes</option>
          <option value="abort-and-resend">interrupt, keep partial, resend</option>
        </select>
      </div>
      <div className="modal-actions">
        <button className="ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="send"
          disabled={!name.trim() || (!!provider && !model.trim())}
          onClick={() =>
            onSave({
              id: initial?.id ?? `agent_${Date.now()}`,
              name: name.trim(),
              systemPrompt: systemPrompt.trim() || undefined,
              provider: provider || undefined,
              model: model.trim() || undefined,
              mcpServers: servers.length ? servers : undefined,
              thinking: thinking ? { enabled: true } : undefined,
              thinkingVisibility,
              injectionMode,
            })
          }
        >
          Save agent
        </button>
      </div>
    </div>
  );
}

export function Agents() {
  const config = useStore((s) => s.config);
  const saveAgents = useStore((s) => s.saveAgents);
  const setActiveAgent = useStore((s) => s.setActiveAgent);
  const setView = useStore((s) => s.setView);
  const [editing, setEditing] = useState<AgentSpec | null | 'new'>(null);

  if (!config) return <div className="empty-state">Loading…</div>;

  const save = (spec: AgentSpec) => {
    const rest = config.agents.filter((a) => a.id !== spec.id);
    void saveAgents([...rest, spec]);
    setEditing(null);
  };

  const remove = (id: string) => {
    void saveAgents(config.agents.filter((a) => a.id !== id));
  };

  return (
    <div className="settings">
      <h1>Agents</h1>
      <p className="hint">
        Each agent has its own conversation, system prompt, and optional provider/model override —
        isolated sessions running side by side. Unset fields inherit the app defaults.
      </p>

      {config.agents.length === 0 && editing === null && (
        <div className="empty-state left">
          <p>No agents yet. The Default agent always exists; add specialists here.</p>
        </div>
      )}

      {config.agents.map((a) => (
        <div key={a.id} className="agent-row">
          <div className="agent-info">
            <strong>{a.name}</strong>
            <span className="meta">
              {a.provider ?? 'default provider'} · {a.model ?? 'default model'}
              {a.mcpServers?.length ? ` · MCP: ${a.mcpServers.join(', ')}` : ''}
            </span>
            {a.systemPrompt && <span className="agent-prompt">{a.systemPrompt}</span>}
          </div>
          <div className="agent-actions">
            <button
              onClick={() => {
                setActiveAgent(a.id);
                setView('chat');
              }}
            >
              Chat
            </button>
            <button className="ghost" onClick={() => setEditing(a)}>
              Edit
            </button>
            <button className="ghost" onClick={() => remove(a.id)}>
              Delete
            </button>
          </div>
        </div>
      ))}

      {editing !== null ? (
        <AgentForm
          initial={editing === 'new' ? null : editing}
          mcpServerNames={config.mcpServers.map((s) => s.name)}
          defaultProvider={config.defaultProvider}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <button onClick={() => setEditing('new')}>+ New agent</button>
      )}
    </div>
  );
}
