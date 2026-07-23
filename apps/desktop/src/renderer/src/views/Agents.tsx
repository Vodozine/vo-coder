import { useState } from 'react';
import type { AgentSpec } from '@vo-coder/providers';
import { ModelPicker } from '../components/ModelPicker';
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
  const [routingHints, setRoutingHints] = useState(initial?.routingHints ?? '');
  const effectiveProvider = provider || defaultProvider;

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
        <ModelPicker
          provider={effectiveProvider}
          value={model}
          onChange={setModel}
          placeholder={provider ? 'pick a model (required)' : '(app default)'}
        />
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
      <div className="field-row">
        <label>specialty</label>
        <input
          className="grow"
          value={routingHints}
          onChange={(e) => setRoutingHints(e.target.value)}
          placeholder="keywords Vodo routes by, e.g. proxmox, vm, docker"
          title='With routing set to "My agents first", Vodo hands messages matching these to this agent'
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
              routingHints: routingHints.trim() || undefined,
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
  const newSession = useStore((s) => s.newSession);
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
              title="Start a new chat with this agent in the current project"
              onClick={() => void newSession(undefined, a.id)}
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
