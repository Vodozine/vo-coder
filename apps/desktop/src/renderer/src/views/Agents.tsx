import { useEffect, useState } from 'react';
import type { AgentSpec } from '@vo-coder/providers';
import { ModelPicker } from '../components/ModelPicker';
import { HOMELAB_AGENT_ID } from '../../../shared/homelab';
import { useStore } from '../state/store';

const PROVIDERS = ['', 'anthropic', 'ollama', 'lmstudio', 'llamacpp', 'openai', 'openrouter', 'xai', 'zai', 'nvidia'];

function AgentForm({
  initial,
  mcpServerNames,
  defaultProvider,
  localServers,
  onSave,
  onCancel,
}: {
  initial: AgentSpec | null;
  mcpServerNames: string[];
  defaultProvider: string;
  /** Named extra local endpoints per provider — the "@name" model-id suffixes. */
  localServers: { ollama: string[]; llamacpp: string[] };
  onSave: (spec: AgentSpec) => void;
  onCancel: () => void;
}) {
  const namesFor = (prov: string): string[] =>
    prov === 'ollama' ? localServers.ollama : prov === 'llamacpp' ? localServers.llamacpp : [];

  const [name, setName] = useState(initial?.name ?? '');
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? '');
  const [provider, setProvider] = useState(initial?.provider ?? '');
  const [model, setModel] = useState(initial?.model ?? '');
  const [server, setServer] = useState(() => {
    const id = initial?.model ?? '';
    const at = id.lastIndexOf('@');
    const s = at > 0 ? id.slice(at + 1) : '';
    return namesFor(initial?.provider ?? defaultProvider).includes(s) ? s : '';
  });
  const [servers, setServers] = useState<string[]>(initial?.mcpServers ?? []);
  const [thinking, setThinking] = useState(initial?.thinking?.enabled ?? false);
  const [thinkingVisibility, setThinkingVisibility] = useState(
    initial?.thinkingVisibility ?? 'visible',
  );
  const [injectionMode, setInjectionMode] = useState(initial?.injectionMode ?? 'queue');
  const [routingHints, setRoutingHints] = useState(initial?.routingHints ?? '');
  const effectiveProvider = provider || defaultProvider;

  // Which local box an ollama/llamacpp agent runs on. "" = the main Ollama
  // server (or "any" for llama.cpp, which has no unnamed primary). The truth
  // lives in the model id's "@name" suffix; this select reads and writes it.
  const serverNames = namesFor(effectiveProvider);
  const activeServer = serverNames.includes(server) ? server : '';
  const serverOf = (id: string): string => {
    const at = id.lastIndexOf('@');
    const s = at > 0 ? id.slice(at + 1) : '';
    return serverNames.includes(s) ? s : '';
  };
  const baseOf = (id: string): string => {
    const s = serverOf(id);
    return s ? id.slice(0, id.length - s.length - 1) : id;
  };
  const changeServer = (s: string) => {
    setServer(s);
    if (model) setModel(s ? `${baseOf(model)}@${s}` : baseOf(model));
  };
  const modelFilter =
    effectiveProvider === 'ollama' && serverNames.length > 0
      ? (id: string) => serverOf(id) === activeServer
      : effectiveProvider === 'llamacpp' && activeServer
        ? (id: string) => serverOf(id) === activeServer
        : undefined;

  const toggleServer = (s: string) =>
    setServers((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  return (
    <div className="agent-form form-grid">
      <div className="field-row">
        <label>name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Researcher" />
      </div>
      <div className="field-row">
        <label>provider</label>
        <select
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value);
            setServer('');
          }}
        >
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p || '(app default)'}
            </option>
          ))}
        </select>
      </div>
      {serverNames.length > 0 && (
        <div className="field-row">
          <label>server</label>
          <select
            value={activeServer}
            onChange={(e) => changeServer(e.target.value)}
            title='Which box this agent runs on — a model pinned to "model@name" always uses that server'
          >
            <option value="">
              {effectiveProvider === 'ollama' ? 'main server' : '(any server)'}
            </option>
            {serverNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="field-row">
        <label>model</label>
        <ModelPicker
          provider={effectiveProvider}
          value={model}
          onChange={(id) => {
            setModel(id);
            setServer(serverOf(id));
          }}
          placeholder={provider ? 'pick a model (required)' : '(app default)'}
          filterId={modelFilter}
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
      <div className="field-row wide">
        <label>system prompt</label>
        <textarea
          rows={3}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="What is this agent for?"
        />
      </div>
      {mcpServerNames.length > 0 && (
        <div className="field-row wide">
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
  const agentToEdit = useStore((s) => s.agentToEdit);
  const clearAgentToEdit = useStore((s) => s.clearAgentToEdit);
  const [editing, setEditing] = useState<AgentSpec | null | 'new'>(null);

  // Arrived here from "Edit" in Mr Homelab's tab — open his form, then forget
  // the request so a later visit starts on the list.
  useEffect(() => {
    if (!agentToEdit) return;
    const spec = config?.agents.find((a) => a.id === agentToEdit);
    if (spec) setEditing(spec);
    clearAgentToEdit();
  }, [agentToEdit, config, clearAgentToEdit]);

  if (!config) return <div className="empty-state">Loading…</div>;

  const save = (spec: AgentSpec) => {
    const rest = config.agents.filter((a) => a.id !== spec.id);
    void saveAgents([...rest, spec]);
    setEditing(null);
  };

  const remove = (id: string) => {
    void saveAgents(config.agents.filter((a) => a.id !== id));
  };

  const setEnabled = (id: string, enabled: boolean) => {
    void saveAgents(config.agents.map((a) => (a.id === id ? { ...a, enabled } : a)));
  };

  // Mr Homelab is configured in his own tab, next to his name — he owns a whole
  // view, so listing him here as one card among the specialists put the same
  // settings in two places.
  const listed = config.agents.filter((a) => a.id !== HOMELAB_AGENT_ID);

  return (
    <div className="settings settings-full">
      <h1>Agents</h1>
      <p className="hint">
        Each agent has its own conversation, system prompt, and optional provider/model override —
        isolated sessions running side by side. Unset fields inherit the app defaults.
      </p>

      {listed.length === 0 && editing === null && (
        <div className="empty-state left">
          <p>No agents yet. The Default agent always exists; add specialists here.</p>
        </div>
      )}

      {listed.length > 0 && (
        <div className="agents-list">
          {listed.map((a) => {
            const on = a.enabled !== false;
            return (
              <div key={a.id} className={`agent-row${on ? '' : ' agent-row--off'}`}>
                <div className="agent-info">
                  <strong>
                    {a.name}
                    {!on && <span className="meta"> — off duty</span>}
                  </strong>
                  <span className="meta">
                    {a.provider ?? 'default provider'} · {a.model ?? 'default model'}
                    {a.mcpServers?.length ? ` · MCP: ${a.mcpServers.join(', ')}` : ''}
                  </span>
                  {a.systemPrompt && <span className="agent-prompt">{a.systemPrompt}</span>}
                </div>
                <div className="agent-actions">
                  <button
                    className={on ? 'ghost' : ''}
                    title={
                      on
                        ? 'Take this agent off duty: routing and group projects skip it, everything else is kept'
                        : 'Put this agent back on duty'
                    }
                    onClick={() => setEnabled(a.id, !on)}
                  >
                    {on ? 'On' : 'Off'}
                  </button>
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
            );
          })}
        </div>
      )}

      {editing !== null ? (
        <AgentForm
          initial={editing === 'new' ? null : editing}
          mcpServerNames={config.mcpServers.map((s) => s.name)}
          defaultProvider={config.defaultProvider}
          localServers={{
            ollama: (config.ollamaExtraEndpoints ?? []).map((e) => e.name).filter(Boolean),
            llamacpp: (config.llamacppEndpoints ?? []).map((e) => e.name).filter(Boolean),
          }}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <button onClick={() => setEditing('new')}>+ New agent</button>
      )}
    </div>
  );
}
