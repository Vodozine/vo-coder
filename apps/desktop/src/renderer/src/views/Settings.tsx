import { useEffect, useState } from 'react';
import type { McpRegistryEntry } from '@vo-coder/core';
import { useStore } from '../state/store';

const PROVIDERS = ['anthropic', 'ollama', 'lmstudio', 'openai', 'openrouter', 'xai'];

function KeyRow({ provider }: { provider: string }) {
  const status = useStore((s) => s.secretStatus[provider]);
  const saveSecret = useStore((s) => s.saveSecret);
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(false);

  const save = async () => {
    await saveSecret(provider, value);
    setValue('');
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="field-row">
      <label>{provider}</label>
      <input
        type="password"
        value={value}
        placeholder={status ? `saved (${status})` : 'not set'}
        onChange={(e) => setValue(e.target.value)}
      />
      <button onClick={() => void save()} disabled={!value}>
        {saved ? 'Saved ✓' : 'Save'}
      </button>
      {status && (
        <button className="ghost" onClick={() => void saveSecret(provider, '')}>
          Clear
        </button>
      )}
    </div>
  );
}

function RegistryResult({ entry, taken }: { entry: McpRegistryEntry; taken: string[] }) {
  const refreshMcp = useStore((s) => s.refreshMcp);
  const saveConfig = useStore((s) => s.saveConfig);
  const [envOpen, setEnvOpen] = useState(false);
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [state, setState] = useState<'idle' | 'adding' | 'added' | 'failed'>('idle');
  const [detail, setDetail] = useState('');

  const add = async () => {
    if (!entry.install) return;
    const required = entry.install.envVars.filter((v) => v.isRequired);
    if (required.some((v) => !envValues[v.name]?.trim()) && !envOpen) {
      setEnvOpen(true);
      return;
    }
    setState('adding');
    const name = suggestName(entry, taken);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(envValues)) if (v.trim()) env[k] = v.trim();
    const status = await window.vo.mcpAdd({
      name,
      command: entry.install.command,
      args: entry.install.args,
      ...(Object.keys(env).length ? { env } : {}),
    });
    await saveConfig({}); // re-pull config (mcpAdd wrote the server list in main)
    await refreshMcp();
    if (status.connected) {
      setState('added');
      setDetail(`connected as "${name}" — ${status.toolCount} tools`);
    } else {
      setState('failed');
      setDetail(status.error ?? 'could not connect (it stays in your server list to retry)');
    }
  };

  return (
    <div className="registry-result">
      <div className="registry-head">
        <div className="registry-info">
          <strong>{entry.displayName}</strong>
          <span className="meta">{entry.description || entry.name}</span>
          {entry.install && (
            <code className="registry-cmd">
              {entry.install.command} {entry.install.args.join(' ')}
            </code>
          )}
        </div>
        {entry.install ? (
          <button
            className={state === 'added' ? 'ghost' : 'send'}
            disabled={state === 'adding' || state === 'added'}
            onClick={() => void add()}
          >
            {state === 'adding' ? 'Adding…' : state === 'added' ? 'Added ✓' : 'Add'}
          </button>
        ) : (
          <button
            className="ghost"
            title="Remote-hosted server — open its page (remote connections land in a later phase)"
            onClick={() => entry.homepage && void window.vo.openExternal(entry.homepage)}
          >
            remote ↗
          </button>
        )}
      </div>
      {envOpen && entry.install && entry.install.envVars.length > 0 && (
        <div className="registry-env">
          {entry.install.envVars.map((v) => (
            <div key={v.name} className="field-row">
              <label title={v.description}>
                {v.name}
                {v.isRequired ? ' *' : ''}
              </label>
              <input
                className="grow"
                type={v.isSecret ? 'password' : 'text'}
                placeholder={v.description ?? (v.isRequired ? 'required' : 'optional')}
                value={envValues[v.name] ?? ''}
                onChange={(e) => setEnvValues((p) => ({ ...p, [v.name]: e.target.value }))}
              />
            </div>
          ))}
          <button className="send" onClick={() => void add()}>
            Add with these settings
          </button>
        </div>
      )}
      {detail && <p className={`hint ${state === 'failed' ? 'error-text' : ''}`}>{detail}</p>}
    </div>
  );
}

/** Mirror of core's suggestServerName, kept renderer-side to avoid a node import chain. */
function suggestName(entry: McpRegistryEntry, taken: string[]): string {
  let base = entry.displayName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let prev = '';
  while (prev !== base) {
    prev = base;
    base = base.replace(/^(mcp|server)-|-(mcp|server)$/g, '');
  }
  if (!base) base = 'server';
  let name = base;
  let n = 2;
  while (taken.includes(name)) name = `${base}-${n++}`;
  return name;
}

function McpFinder() {
  const config = useStore((s) => s.config);
  const consumeQuery = useStore((s) => s.consumeMcpSearchQuery);
  const send = useStore((s) => s.send);
  const setView = useStore((s) => s.setView);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<McpRegistryEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async (q: string) => {
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setResults(await window.vo.mcpSearch(q.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const prefill = consumeQuery();
    if (prefill) {
      setQuery(prefill);
      void search(prefill);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const askAgentToBuild = () => {
    setView('chat');
    void send(
      `I need an MCP server that doesn't seem to exist yet: "${query}". ` +
        'Build a minimal custom MCP server for it as a Node project using @modelcontextprotocol/sdk ' +
        '(McpServer + StdioServerTransport, zod schemas). Ask me what tools it should expose, then ' +
        'write the files, tell me the npm install command for the Console, and give me the ' +
        'name/command/args to add under Settings → MCP servers.',
    );
  };

  const taken = (config?.mcpServers ?? []).map((s) => s.name);

  return (
    <div className="mcp-finder">
      <div className="field-row">
        <input
          className="grow"
          placeholder="What should your agents be able to do? (e.g. github, postgres, browser)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search(query);
          }}
        />
        <button className="send" disabled={busy || !query.trim()} onClick={() => void search(query)}>
          {busy ? 'Searching…' : 'Find servers'}
        </button>
        <button
          className="ghost"
          title="Browse the community directory in your browser"
          onClick={() => void window.vo.openExternal('https://mcpservers.org/')}
        >
          Browse ↗
        </button>
      </div>
      {error && <p className="hint error-text">{error}</p>}
      {results && results.length === 0 && (
        <div className="field-row">
          <span className="hint grow">Nothing in the registry matches.</span>
          <button onClick={askAgentToBuild}>Ask an agent to build one</button>
        </div>
      )}
      {results?.map((entry) => (
        <RegistryResult key={entry.name} entry={entry} taken={taken} />
      ))}
    </div>
  );
}

function McpSection() {
  const config = useStore((s) => s.config);
  const mcpStatus = useStore((s) => s.mcpStatus);
  const saveConfig = useStore((s) => s.saveConfig);
  const mcpConnect = useStore((s) => s.mcpConnect);
  const mcpDisconnect = useStore((s) => s.mcpDisconnect);
  const refreshMcp = useStore((s) => s.refreshMcp);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');

  if (!config) return null;

  const add = async () => {
    const cfg = {
      name: name.trim(),
      command: command.trim(),
      args: args.trim() ? args.trim().split(/\s+/) : [],
    };
    await saveConfig({ mcpServers: [...config.mcpServers, cfg] });
    setName('');
    setCommand('');
    setArgs('');
    await mcpConnect(cfg.name);
  };

  const remove = async (serverName: string) => {
    await mcpDisconnect(serverName).catch(() => {});
    await saveConfig({
      mcpServers: config.mcpServers.filter((s) => s.name !== serverName),
    });
    await refreshMcp();
  };

  return (
    <section>
      <h2>MCP servers</h2>
      <p className="hint">
        Tools for your agents — search below and add with one click; the harness runs and connects
        them for you. Advanced: add any server manually by command.
      </p>
      <McpFinder />
      {config.mcpServers.map((s) => {
        const status = mcpStatus.find((st) => st.name === s.name);
        return (
          <div key={s.name} className="field-row">
            <span className={`status-dot ${status?.connected ? 'on' : 'off'}`} />
            <label>{s.name}</label>
            <span className="meta grow">
              {s.command} {s.args?.join(' ')}
              {status?.connected ? ` — ${status.toolCount} tools` : ''}
              {status?.error ? ` — ${status.error}` : ''}
            </span>
            {status?.connected ? (
              <button className="ghost" onClick={() => void mcpDisconnect(s.name)}>
                Disconnect
              </button>
            ) : (
              <button onClick={() => void mcpConnect(s.name)}>Connect</button>
            )}
            <button className="ghost" onClick={() => void remove(s.name)}>
              Remove
            </button>
          </div>
        );
      })}
      <div className="field-row">
        <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="command" value={command} onChange={(e) => setCommand(e.target.value)} />
        <input
          className="grow"
          placeholder="args"
          value={args}
          onChange={(e) => setArgs(e.target.value)}
        />
        <button disabled={!name.trim() || !command.trim()} onClick={() => void add()}>
          Add
        </button>
      </div>
    </section>
  );
}

function VisionSection() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const [provider, setProvider] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);

  if (!config) return null;
  const effProvider = provider ?? config.visionModel?.provider ?? '';
  const effModel = model ?? config.visionModel?.model ?? '';

  return (
    <section>
      <h2>Vision model</h2>
      <p className="hint">
        When an agent's model can't see images, attachments get offered to this model instead.
      </p>
      <div className="field-row">
        <label>provider</label>
        <select value={effProvider} onChange={(e) => setProvider(e.target.value)}>
          <option value="">(none)</option>
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <input
          placeholder="model id"
          value={effModel}
          onChange={(e) => setModel(e.target.value)}
        />
        <button
          onClick={() =>
            void saveConfig({
              visionModel: effProvider && effModel ? { provider: effProvider, model: effModel } : null,
            })
          }
        >
          Save
        </button>
      </div>
    </section>
  );
}

function WhisperSetupButton() {
  const saveConfig = useStore((s) => s.saveConfig);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setup = async () => {
    setBusy(true);
    setError(null);
    const result = await window.vo.voiceSetupWhisper();
    if (result.ok) {
      await saveConfig({}); // re-pull config; main already wrote the paths
    } else {
      setError(result.error ?? 'Setup failed');
    }
    setBusy(false);
  };

  return (
    <>
      <button className="send" disabled={busy} onClick={() => void setup()}>
        {busy ? 'Downloading… (~150 MB)' : 'Download & set up whisper'}
      </button>
      {error && <span className="hint error-text">{error}</span>}
    </>
  );
}

function VoiceSection() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  if (!config) return null;
  const v = config.voice;
  const save = (patch: Partial<typeof v>) => void saveConfig({ voice: { ...v, ...patch } });

  return (
    <section>
      <h2>Voice</h2>
      <p className="hint">
        Push-to-talk: hold the 🎤 button or Ctrl+Space. Live chat: the 🎧 toggle in the chat
        header — speak, get spoken answers, interrupt any time.
      </p>
      <div className="field-row">
        <label>speech→text</label>
        <select value={v.stt} onChange={(e) => save({ stt: e.target.value as typeof v.stt })}>
          <option value="openai">OpenAI-compatible API (uses your openai key)</option>
          <option value="whisper-local">whisper.cpp binary (local, offline)</option>
        </select>
        {v.stt === 'openai' && (
          <input
            value={v.sttModel}
            title="Transcription model"
            onChange={(e) => save({ sttModel: e.target.value })}
          />
        )}
      </div>
      {v.stt === 'whisper-local' && (!v.whisperPath || !v.whisperModel) && (
        <div className="field-row">
          <span className="hint grow">
            Nothing to configure by hand — one click downloads whisper.cpp and the base model
            (≈150 MB) and wires it up.
          </span>
          <WhisperSetupButton />
        </div>
      )}
      {v.stt === 'whisper-local' && (
        <>
          <div className="field-row">
            <label>whisper binary</label>
            <input
              className="grow"
              placeholder="C:\\tools\\whisper\\whisper-cli.exe"
              value={v.whisperPath}
              onChange={(e) => save({ whisperPath: e.target.value })}
            />
          </div>
          <div className="field-row">
            <label>whisper model</label>
            <input
              className="grow"
              placeholder="C:\\tools\\whisper\\ggml-base.en.bin"
              value={v.whisperModel}
              onChange={(e) => save({ whisperModel: e.target.value })}
            />
          </div>
        </>
      )}
      <div className="field-row">
        <label>text→speech</label>
        <select value={v.tts} onChange={(e) => save({ tts: e.target.value as typeof v.tts })}>
          <option value="system">System voice (offline)</option>
          <option value="openai">OpenAI TTS (uses your openai key)</option>
          <option value="none">Off</option>
        </select>
        {v.tts === 'openai' && (
          <input
            value={v.openaiVoice}
            title="Voice name (alloy, nova, …)"
            onChange={(e) => save({ openaiVoice: e.target.value })}
          />
        )}
      </div>
    </section>
  );
}

function UpdatesSection() {
  const updateInfo = useStore((s) => s.updateInfo);
  const [version, setVersion] = useState('');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    void window.vo.appVersion().then(setVersion);
  }, []);

  const check = async () => {
    setChecking(true);
    const r = await window.vo.updateCheck();
    setResult(
      r.state === 'available'
        ? `Update ${r.version} found — downloading in the background.`
        : r.state === 'none'
          ? 'You are on the latest version.'
          : r.state === 'dev'
            ? (r.message ?? 'Dev mode.')
            : `Check failed: ${r.message ?? 'unknown error'} (releases not published yet?)`,
    );
    setChecking(false);
  };

  return (
    <section>
      <h2>Updates</h2>
      <div className="field-row">
        <label>version</label>
        <span className="meta grow">Vo-Coder {version || '…'}</span>
        {updateInfo?.state === 'downloaded' ? (
          <button className="send" onClick={() => void window.vo.updateInstall()}>
            Restart to update{updateInfo.version ? ` to ${updateInfo.version}` : ''}
          </button>
        ) : (
          <button disabled={checking} onClick={() => void check()}>
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
        )}
      </div>
      {result && <p className="hint">{result}</p>}
      <p className="hint">
        The installed app checks automatically and downloads updates in the background — installing
        keeps all your settings and keys.
      </p>
    </section>
  );
}

export function Settings() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const [ollamaUrl, setOllamaUrl] = useState<string | null>(null);
  const [lmstudioUrl, setLmstudioUrl] = useState<string | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);

  if (!config) return <div className="empty-state">Loading…</div>;

  return (
    <div className="settings">
      <h1>Settings</h1>

      <section>
        <h2>API keys</h2>
        <p className="hint">
          Keys are encrypted with your OS keychain and never leave this machine except to call the
          provider you configured.
        </p>
        <KeyRow provider="anthropic" />
        <KeyRow provider="openai" />
        <KeyRow provider="openrouter" />
        <KeyRow provider="xai" />
      </section>

      <section>
        <h2>Local model servers</h2>
        <div className="field-row">
          <label>Ollama</label>
          <input
            value={ollamaUrl ?? config.ollamaBaseUrl}
            onChange={(e) => setOllamaUrl(e.target.value)}
          />
          <button
            disabled={ollamaUrl === null || ollamaUrl === config.ollamaBaseUrl}
            onClick={() => void saveConfig({ ollamaBaseUrl: ollamaUrl ?? config.ollamaBaseUrl })}
          >
            Save
          </button>
        </div>
        <div className="field-row">
          <label>LM Studio</label>
          <input
            value={lmstudioUrl ?? config.lmstudioBaseUrl}
            onChange={(e) => setLmstudioUrl(e.target.value)}
          />
          <button
            disabled={lmstudioUrl === null || lmstudioUrl === config.lmstudioBaseUrl}
            onClick={() =>
              void saveConfig({ lmstudioBaseUrl: lmstudioUrl ?? config.lmstudioBaseUrl })
            }
          >
            Save
          </button>
        </div>
        <p className="hint">
          No keys needed — both are picked up automatically when their server is running.
        </p>
      </section>

      <McpSection />
      <VisionSection />
      <VoiceSection />

      <UpdatesSection />

      <section>
        <h2>System prompt (Default agent)</h2>
        <textarea
          className="system-prompt"
          rows={4}
          value={systemPrompt ?? config.systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
        />
        <button
          disabled={systemPrompt === null || systemPrompt === config.systemPrompt}
          onClick={() => void saveConfig({ systemPrompt: systemPrompt ?? config.systemPrompt })}
        >
          Save prompt
        </button>
      </section>
    </div>
  );
}
