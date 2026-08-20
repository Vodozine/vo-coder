import { useEffect, useState } from 'react';
import type { AgentSpec } from '@vo-coder/providers';
import { ModelPicker } from '../components/ModelPicker';
import { HOMELAB_AGENT_ID } from '../../../shared/homelab';
import { useStore } from '../state/store';

const PROVIDERS = ['', 'anthropic', 'ollama', 'lmstudio', 'flm', 'llamacpp', 'openai', 'openrouter', 'xai', 'zai', 'nvidia'];
// Appended as a statement: the array line above may not be edited by shared
// commits (scripts/edition-patterns.mjs scans added lines).
PROVIDERS.push('claude-code');
PROVIDERS.push('codex-cli');
PROVIDERS.push('gemini');

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
  localServers: { ollama: string[]; llamacpp: string[]; lmstudio: string[]; flm: string[] };
  onSave: (spec: AgentSpec) => void;
  onCancel: () => void;
}) {
  const namesFor = (prov: string): string[] =>
    prov === 'ollama'
      ? localServers.ollama
      : prov === 'llamacpp'
        ? localServers.llamacpp
        : prov === 'lmstudio'
          ? localServers.lmstudio
          : prov === 'flm'
            ? localServers.flm
            : [];

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
  // Existing agents keep what they have (undefined reads as on); a NEW agent
  // starts as hired help — given a part, not the run of the project.
  const [memory, setMemory] = useState(initial ? initial.memory !== false : false);
  const [personal, setPersonal] = useState(initial?.personal === true);
  const [singleInstance, setSingleInstance] = useState(initial?.singleInstance === true);
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
  // Ollama and LM Studio both have an unnamed primary, so "" is a real choice
  // and the list narrows to it. llama.cpp has no primary, so "" means "any".
  const modelFilter =
    (effectiveProvider === 'ollama' ||
      effectiveProvider === 'lmstudio' ||
      effectiveProvider === 'flm') &&
    serverNames.length > 0
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
              {effectiveProvider === 'llamacpp' ? '(any server)' : 'main server'}
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
      <div className="field-row wide">
        <label>project memory</label>
        <label
          className="checkbox"
          title="On: the agent carries the project between jobs — it gets the project briefing every turn (about 1.5k tokens) and can search the memory map and the archive. Off: it works from what Vodo tells it and the code in front of it, and asks him when something is missing. Off keeps a specialist on its own part instead of reading everyone's tasks as its own."
        >
          <input type="checkbox" checked={memory} onChange={(e) => setMemory(e.target.checked)} />
          knows the project between jobs
        </label>
      </div>
      <div className="field-row wide">
        <label>personal</label>
        <label
          className="checkbox"
          title="On: this agent is yours alone. Vodo never seats it in a group, never assigns it a part, never routes a conversation to it, and never sees it on his roster — asking for it by name is refused out loud. You still talk to it in its own chat, and everything you do with it yourself still works."
        >
          <input type="checkbox" checked={personal} onChange={(e) => setPersonal(e.target.checked)} />
          off limits to Vodo — never drafted, never routed to
        </label>
      </div>
      <div className="field-row wide">
        <label>instances</label>
        <label
          className="checkbox"
          title="Off (default): this agent is a template — every chat, group seat and mission is its own instance, so it is always available; a capable GPU or the cloud simply runs several at once. On: only one running instance exists — while any chat, group or mission is using it, it shows busy everywhere else until idle. For agents whose model owns a small local GPU."
        >
          <input
            type="checkbox"
            checked={singleInstance}
            onChange={(e) => setSingleInstance(e.target.checked)}
          />
          single instance — busy anywhere means busy everywhere
        </label>
      </div>
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
              // Written unconditionally: undefined means "carries memory" here,
              // so a new agent has to persist an explicit false to be hired help.
              memory,
              // Only ever an explicit true — absent means ordinary workforce,
              // so agents from before this flag keep working as they did.
              ...(personal ? { personal: true } : {}),
              ...(singleInstance ? { singleInstance: true } : {}),
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

/**
 * A model id, on one line. Local ids run to 90 characters
 * (hf.co/DavidAU/Qwen3.6-27B-Fable-Fusion-711-Uncensored-…-GGUF:IQ4_XS) and
 * used to set the width of the whole card, so a long one collapses to its
 * tail — the part that identifies it — and opens over the card on click.
 */
function ModelLabel({ model }: { model?: string }) {
  if (!model) return <>default model</>;
  if (model.length <= 30) return <>{model}</>;
  return (
    <details className="agent-model">
      <summary title={model}>…{model.slice(-27)}</summary>
      <span className="agent-model-full">{model}</span>
    </details>
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

  // Esc closes the edit popup, matching the Settings panel.
  useEffect(() => {
    if (editing === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEditing(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing]);

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

  // A spread patch, like setEnabled — deliberately not a trip through the form,
  // which rebuilds the spec from its own fields.
  const setMemory = (id: string, memory: boolean) => {
    void saveAgents(config.agents.map((a) => (a.id === id ? { ...a, memory } : a)));
  };
  const setPersonal = (id: string, personal: boolean) => {
    void saveAgents(
      config.agents.map((a) =>
        a.id === id ? { ...a, ...(personal ? { personal: true } : { personal: undefined }) } : a,
      ),
    );
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
            const remembers = a.memory !== false;
            const kept = a.personal === true;
            return (
              <div key={a.id} className={`agent-row${on ? '' : ' agent-row--off'}`}>
                <div className="agent-info">
                  <strong>
                    {a.name}
                    {kept && <span className="meta"> — personal, off limits to Vodo</span>}
                    {!on && <span className="meta"> — off duty</span>}
                  </strong>
                  <span className="meta">
                    {a.provider ?? 'default provider'} · <ModelLabel model={a.model} />
                  </span>
                  <span className="meta">
                    {a.mcpServers?.length ? `MCP: ${a.mcpServers.join(', ')}` : 'no MCP servers'}
                    {a.memory === false ? ' · no memory' : ''}
                  </span>
                  {a.systemPrompt && <span className="agent-prompt">{a.systemPrompt}</span>}
                </div>
                <div className="agent-actions">
                  {/* What the agent IS — the two states you flip. */}
                  <div className="agent-actions-row">
                    <button
                      className={on ? 'ghost' : ''}
                      title={
                        on
                          ? 'Take this agent off duty: routing and group projects skip it, everything else is kept'
                          : 'Put this agent back on duty'
                      }
                      onClick={() => setEnabled(a.id, !on)}
                    >
                      {on ? 'On duty' : 'Off duty'}
                    </button>
                    <button
                      className={remembers ? 'ghost' : ''}
                      title={
                        remembers
                          ? 'Carries the project between jobs: it gets the project briefing every turn (~1.5k tokens) and can search the memory map and archive. Click to make it work from its brief and the code alone.'
                          : 'Works only from what it is told and the code in front of it — no briefing, no memory tools — and asks the coordinator when something is missing. Click to give it the project.'
                      }
                      onClick={() => setMemory(a.id, !remembers)}
                    >
                      {remembers ? 'Memory' : 'No memory'}
                    </button>
                    <button
                      className={kept ? '' : 'ghost'}
                      title={
                        kept
                          ? 'Personal: Vodo never drafts this agent into groups, never routes to it, never sees it on his roster. Click to return it to the workforce.'
                          : 'Make this agent yours alone — off limits to Vodo: no group seats, no routing, not on his roster. Your own chats with it are untouched.'
                      }
                      onClick={() => setPersonal(a.id, !kept)}
                    >
                      {kept ? 'Personal' : 'Draftable'}
                    </button>
                  </div>
                  {/* What you DO with it. */}
                  <div className="agent-actions-row">
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
              </div>
            );
          })}
        </div>
      )}

      <button onClick={() => setEditing('new')}>+ New agent</button>

      {editing !== null && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="settings-panel agent-edit-panel" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="settings-panel-close"
              aria-label="Close"
              onClick={() => setEditing(null)}
            >
              ×
            </button>
            <div className="settings-panel-body">
              <h2 className="agent-edit-title">{editing === 'new' ? 'New agent' : 'Edit agent'}</h2>
              <AgentForm
                initial={editing === 'new' ? null : editing}
                mcpServerNames={config.mcpServers.map((s) => s.name)}
                defaultProvider={config.defaultProvider}
                localServers={{
                  ollama: (config.ollamaExtraEndpoints ?? []).map((e) => e.name).filter(Boolean),
                  llamacpp: (config.llamacppEndpoints ?? []).map((e) => e.name).filter(Boolean),
                  lmstudio: (config.lmstudioExtraEndpoints ?? []).map((e) => e.name).filter(Boolean),
                  flm: (config.flmExtraEndpoints ?? []).map((e) => e.name).filter(Boolean),
                }}
                onSave={save}
                onCancel={() => setEditing(null)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
