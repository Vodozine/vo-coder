import { useEffect, useState } from 'react';
import { ModelPicker } from '../components/ModelPicker';
import type { McpRegistryEntry } from '@vo-coder/core';
import type { AppConfig, LocalEndpoint, TelegramInfo } from '../../../shared/ipc-contract';
import { useStore } from '../state/store';

const PROVIDERS = ['anthropic', 'ollama', 'lmstudio', 'llamacpp', 'openai', 'openrouter', 'xai', 'nvidia'];
/** Providers that can be flipped off without clearing credentials. */
const TOGGLEABLE_PROVIDERS = new Set(PROVIDERS);

function KeyRow({ provider }: { provider: string }) {
  const status = useStore((s) => s.secretStatus[provider]);
  const saveSecret = useStore((s) => s.saveSecret);
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const [value, setValue] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);
  /** When a key is already stored, hide the empty password field until Replace. */
  const [replacing, setReplacing] = useState(false);

  const canToggle = TOGGLEABLE_PROVIDERS.has(provider);
  const providerOff = canToggle && (config?.disabledProviders ?? []).includes(provider);
  const hasKey = Boolean(status);
  const showInput = !hasKey || replacing;

  const setEnabled = (on: boolean) => {
    if (!canToggle) return;
    const cur = config?.disabledProviders ?? [];
    const nextDisabled = on
      ? cur.filter((p) => p !== provider)
      : cur.includes(provider)
        ? cur
        : [...cur, provider];
    void saveConfig({ disabledProviders: nextDisabled });
  };

  const save = async () => {
    await saveSecret(provider, value);
    setValue('');
    setReplacing(false);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1500);
  };

  const clear = async () => {
    await saveSecret(provider, '');
    setValue('');
    setReplacing(false);
  };

  return (
    <div
      className={`field-row provider-key-row${providerOff ? ' provider-off' : ''}${hasKey ? ' has-key' : ''}`}
    >
      <label>{provider}</label>
      {canToggle && (
        <button
          type="button"
          className={`provider-toggle ${providerOff ? 'off' : 'on'}`}
          title={
            providerOff
              ? 'Provider is off — key stays saved; click to enable for routing and chat'
              : 'Provider is on — click to disable without deleting the key'
          }
          onClick={() => setEnabled(providerOff)}
        >
          {providerOff ? 'Off' : 'On'}
        </button>
      )}
      {showInput ? (
        <>
          <input
            type="password"
            className="grow"
            value={value}
            autoFocus={replacing}
            placeholder={hasKey ? `paste new key (replaces …${status})` : 'paste API key'}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && value.trim()) void save();
              if (e.key === 'Escape' && replacing) {
                setValue('');
                setReplacing(false);
              }
            }}
          />
          <button type="button" onClick={() => void save()} disabled={!value.trim()}>
            {savedFlash ? 'Saved ✓' : hasKey ? 'Update' : 'Save'}
          </button>
          {replacing && (
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setValue('');
                setReplacing(false);
              }}
            >
              Cancel
            </button>
          )}
        </>
      ) : (
        <>
          <span
            className="key-status-pill"
            title="Key is stored in the OS keychain — use Replace to change it, or Off to exclude this provider without deleting the key"
          >
            <span className="key-status-dot" aria-hidden />
            saved (…{status})
          </span>
          <button type="button" className="ghost" onClick={() => setReplacing(true)}>
            Replace
          </button>
          <button type="button" className="ghost" onClick={() => void clear()}>
            Clear
          </button>
        </>
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

/**
 * xAI is one provider with two credential paths: API key and Grok login
 * (SuperGrok / X Premium OAuth). The On/Off toggle covers both — signing in
 * without a key is not a separate "always-on" channel.
 */
function XaiProviderRow() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const status = useStore((s) => s.secretStatus['xai']);
  const saveSecret = useStore((s) => s.saveSecret);
  const xaiOauthConnected = useStore((s) => s.xaiOauthConnected);
  const loadModels = useStore((s) => s.loadModels);
  const [value, setValue] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const providerOff = (config?.disabledProviders ?? []).includes('xai');
  const hasKey = Boolean(status);
  const showInput = !hasKey || replacing;
  const authOk = hasKey || xaiOauthConnected;

  const setEnabled = (on: boolean) => {
    const cur = config?.disabledProviders ?? [];
    const nextDisabled = on
      ? cur.filter((p) => p !== 'xai')
      : cur.includes('xai')
        ? cur
        : [...cur, 'xai'];
    void saveConfig({ disabledProviders: nextDisabled });
  };

  const save = async () => {
    await saveSecret('xai', value);
    setValue('');
    setReplacing(false);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1500);
    // Saving a key implies you want the provider — clear a stale Off flag.
    if (providerOff) setEnabled(true);
    void loadModels('xai');
  };

  const clear = async () => {
    await saveSecret('xai', '');
    setValue('');
    setReplacing(false);
  };

  useEffect(() => {
    return window.vo.onXaiOauth((event) => {
      // Store owns connected state; here we only clear the pending code / errors.
      if (event.state === 'connected') {
        setUserCode(null);
        setError(null);
        // Model pickers (chat + vision/image) need a fresh list once auth lands.
        void loadModels('xai');
      }
      if (event.state === 'error') setError(event.message ?? 'Sign-in failed');
      if (event.state === 'signed_out' && event.message) setError(event.message);
    });
  }, [loadModels]);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    // Grok login is xAI auth — flip the provider On before the browser flow so
    // chat/routing work the moment the token lands (main also clears Off).
    if (providerOff) setEnabled(true);
    const result = await window.vo.xaiOauthBegin();
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? 'Could not start sign-in.');
      return;
    }
    setUserCode(result.userCode ?? null);
  };

  return (
    <div
      className={`xai-provider-block${providerOff ? ' provider-off' : ''}${authOk ? ' has-auth' : ''}`}
    >
      <div
        className={`field-row provider-key-row${providerOff ? ' provider-off' : ''}${hasKey ? ' has-key' : ''}`}
      >
        <label>xai</label>
        <button
          type="button"
          className={`provider-toggle ${providerOff ? 'off' : 'on'}`}
          title={
            providerOff
              ? 'xAI is off — Grok login and API key stay saved; click to enable for routing and chat'
              : 'xAI is on — click to disable without signing out or deleting the key'
          }
          onClick={() => setEnabled(providerOff)}
        >
          {providerOff ? 'Off' : 'On'}
        </button>
        {showInput ? (
          <>
            <input
              type="password"
              className="grow"
              value={value}
              autoFocus={replacing}
              placeholder={
                hasKey
                  ? `paste new key (replaces …${status})`
                  : 'paste API key (optional if signed in)'
              }
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && value.trim()) void save();
                if (e.key === 'Escape' && replacing) {
                  setValue('');
                  setReplacing(false);
                }
              }}
            />
            <button type="button" onClick={() => void save()} disabled={!value.trim()}>
              {savedFlash ? 'Saved ✓' : hasKey ? 'Update' : 'Save'}
            </button>
            {replacing && (
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setValue('');
                  setReplacing(false);
                }}
              >
                Cancel
              </button>
            )}
          </>
        ) : (
          <>
            <span
              className="key-status-pill"
              title="Key is stored in the OS keychain — use Replace to change it, or Off to exclude xAI without deleting the key"
            >
              <span className="key-status-dot" aria-hidden />
              saved (…{status})
            </span>
            <button type="button" className="ghost" onClick={() => setReplacing(true)}>
              Replace
            </button>
            <button type="button" className="ghost" onClick={() => void clear()}>
              Clear
            </button>
          </>
        )}
      </div>
      <div className="field-row xai-signin-row">
        <label>grok login</label>
        {xaiOauthConnected ? (
          <>
            <span className="hint grow">
              ✓ Signed in — same xAI provider as the key above (chat, vision, image)
            </span>
            <button className="ghost" onClick={() => void window.vo.xaiOauthSignOut()}>
              Sign out
            </button>
          </>
        ) : (
          <>
            <span className="hint grow">
              SuperGrok / X Premium? Sign in instead of (or as well as) an API key.
            </span>
            <button disabled={busy} onClick={() => void signIn()}>
              {busy ? 'Starting…' : 'Sign in with X'}
            </button>
          </>
        )}
      </div>
      {userCode && (
        <p className="hint">
          Browser opened — approve the login there. If asked for a code:{' '}
          <code className="perm-tool">{userCode}</code>
        </p>
      )}
      {error && (
        <div className="field-row">
          <span className="hint error-text grow">{error}</span>
          <input
            title="OAuth client id (from xAI's public desktop client; editable if it changes)"
            value={config?.xaiOauthClientId ?? ''}
            onChange={(e) => void saveConfig({ xaiOauthClientId: e.target.value })}
          />
        </div>
      )}
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
        <select
          value={effProvider}
          onChange={(e) => {
            setProvider(e.target.value);
            setModel('');
          }}
        >
          <option value="">(none)</option>
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        {effProvider ? (
          <ModelPicker
            provider={effProvider}
            value={effModel}
            onChange={setModel}
            placeholder="pick a vision model"
            filter="vision"
          />
        ) : (
          <input className="grow" placeholder="model id" value={effModel} disabled />
        )}
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

/** The image_generate tool's model — an image-OUTPUT model. */
function ImageModelSection() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const [provider, setProvider] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);

  if (!config) return null;
  const IMAGE_PROVIDERS = ['xai', 'openrouter', 'openai'] as const;
  const effProvider = provider ?? config.imageModel?.provider ?? 'xai';
  const effModel = model ?? config.imageModel?.model ?? '';

  return (
    <section>
      <h2>Image model</h2>
      <p className="hint">
        Powers the image_generate tool — agents render mockups, icons, and art straight into the
        project's designs/ folder and the chat. Pick an image-output model.
      </p>
      <div className="field-row">
        <label>provider</label>
        <select
          value={effProvider}
          onChange={(e) => {
            setProvider(e.target.value);
            setModel('');
          }}
        >
          {IMAGE_PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <ModelPicker
          provider={effProvider}
          value={effModel}
          onChange={setModel}
          placeholder="pick an image model"
          filter="image"
        />
        <button
          onClick={() =>
            void saveConfig({
              imageModel: effModel ? { provider: effProvider, model: effModel } : null,
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
        Push-to-talk: hold the mic button beside the chat input, or Ctrl+Space. Live chat: the Live
        toggle above it — speak, get spoken answers, interrupt any time.
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
          <option value="elevenlabs">ElevenLabs</option>
          <option value="compat">Custom endpoint (OpenAI-compatible)</option>
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
      {v.tts === 'system' && (
        <div className="field-row">
          <label>voice / rate</label>
          <input
            className="grow"
            placeholder="installed voice name (empty = default)"
            value={v.systemVoice}
            onChange={(e) => save({ systemVoice: e.target.value })}
          />
          <input
            type="number"
            min={-10}
            max={10}
            title="Speaking rate: -10 slow … 10 fast"
            value={v.systemRate}
            onChange={(e) => save({ systemRate: Number(e.target.value) || 0 })}
          />
        </div>
      )}
      {v.tts === 'elevenlabs' && (
        <>
          <KeyRow provider="elevenlabs" />
          <div className="field-row">
            <label>voice id</label>
            <input
              className="grow"
              placeholder="from elevenlabs.io → Voices (e.g. 21m00Tcm4TlvDq8ikWAM)"
              value={v.elevenVoiceId}
              onChange={(e) => save({ elevenVoiceId: e.target.value })}
            />
            <input
              placeholder="model"
              title="Model id (default eleven_multilingual_v2)"
              value={v.elevenModel}
              onChange={(e) => save({ elevenModel: e.target.value })}
            />
          </div>
        </>
      )}
      {v.tts === 'compat' && (
        <>
          <p className="hint">
            Any OpenAI-compatible /audio/speech endpoint works: Groq (PlayAI voices), a local
            Kokoro server, LiteLLM proxies… Key is optional — local servers usually need none.
          </p>
          <div className="field-row">
            <label>base URL</label>
            <input
              className="grow"
              placeholder="https://api.groq.com/openai/v1 or http://127.0.0.1:8880/v1"
              value={v.compatBaseUrl}
              onChange={(e) => save({ compatBaseUrl: e.target.value })}
            />
          </div>
          <div className="field-row">
            <label>model / voice</label>
            <input
              className="grow"
              placeholder="model (e.g. playai-tts, kokoro)"
              value={v.compatModel}
              onChange={(e) => save({ compatModel: e.target.value })}
            />
            <input
              placeholder="voice"
              value={v.compatVoice}
              onChange={(e) => save({ compatVoice: e.target.value })}
            />
          </div>
          <KeyRow provider="tts-custom" />
        </>
      )}
    </section>
  );
}

/** Remote control: talk to Vodo (and run missions) from your phone. */
function TelegramSection() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const [info, setInfo] = useState<TelegramInfo | null>(null);
  const [pairCode, setPairCode] = useState<string | null>(null);

  useEffect(() => {
    void window.vo.telegramInfo().then(setInfo);
    return window.vo.onTelegramChanged(setInfo);
  }, []);

  if (!config) return null;

  return (
    <section>
      <h2>Telegram remote</h2>
      <p className="hint">
        Talk to Vodo from your phone: ask anything, start missions, approve tool calls with buttons.
        Create a bot with Telegram's @BotFather (send it /newbot), paste the token here, then pair
        your chat with a one-time code.
      </p>
      <KeyRow provider="telegram" />
      <div className="field-row">
        <label>enabled</label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={config.telegramEnabled}
            onChange={(e) => void saveConfig({ telegramEnabled: e.target.checked })}
          />
          poll for messages
        </label>
        <span className="meta grow">
          {info?.polling
            ? `● connected${info.botUsername ? ` as @${info.botUsername}` : ''}`
            : info?.lastError
              ? `⚠ ${info.lastError}`
              : info?.configured
                ? 'off'
                : 'no token yet'}
        </span>
      </div>
      <div className="field-row">
        <label>pairing</label>
        {(info?.paired ?? []).length === 0 && <span className="hint">no chats paired</span>}
        <div className="checkbox-row grow">
          {(info?.paired ?? []).map((p) => (
            <span key={p.id} className="attachment-chip">
              {p.name ?? p.id}
              <button className="chip-x" title="Unpair" onClick={() => void window.vo.telegramUnpair(p.id)}>
                ×
              </button>
            </span>
          ))}
        </div>
        <button
          disabled={!info?.polling}
          title={info?.polling ? 'Generate a one-time pairing code' : 'Enable polling first'}
          onClick={() =>
            void window.vo.telegramPairCode().then(({ code }) => setPairCode(code))
          }
        >
          Pair a chat
        </button>
      </div>
      {pairCode && (
        <p className="hint">
          Send <code className="perm-tool">{pairCode}</code> to your bot within 10 minutes to pair
          that chat.
        </p>
      )}
    </section>
  );
}

/** Routing blocklist: vendors/models Vodo must never auto-pick. */
function ExcludedModels() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const catalog = useStore((s) => s.catalog);
  const [term, setTerm] = useState('');

  if (!config) return null;
  const excluded = config.excludedModels;

  const vendors = [
    ...new Set(
      (catalog?.records ?? [])
        .filter((r) => r.provider === 'openrouter' && r.id.includes('/'))
        .map((r) => r.id.split('/')[0]!),
    ),
  ].sort();

  const add = (raw: string) => {
    const terms = raw
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 1 && !excluded.includes(t));
    if (terms.length) void saveConfig({ excludedModels: [...excluded, ...terms] });
    setTerm('');
  };
  const remove = (t: string) =>
    void saveConfig({ excludedModels: excluded.filter((x) => x !== t) });

  return (
    <>
      <div className="field-row">
        <label>exclude</label>
        <select
          value=""
          title="Vodo never auto-routes to matching models (manual picking still works)"
          onChange={(e) => {
            if (e.target.value) add(e.target.value);
          }}
        >
          <option value="">exclude a vendor…</option>
          {vendors.map((v) => (
            <option key={v} value={v} disabled={excluded.includes(v)}>
              {v}
            </option>
          ))}
        </select>
        <input
          className="grow"
          placeholder="or type: glm, kimi, fable… (Enter to add)"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add(term);
          }}
        />
      </div>
      {excluded.length > 0 && (
        <div className="attachment-row" style={{ marginBottom: 10 }}>
          {excluded.map((t) => (
            <span key={t} className="attachment-chip">
              {t}
              <button className="chip-x" title="Allow again" onClick={() => remove(t)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function UpdatesSection() {
  const updateInfo = useStore((s) => s.updateInfo);
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
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
      <div className="field-row">
        <label>automatic</label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={config?.autoUpdate ?? true}
            onChange={(e) => void saveConfig({ autoUpdate: e.target.checked })}
          />
          check and download updates in the background
        </label>
      </div>
      <p className="hint">
        {config?.autoUpdate ?? true
          ? 'Updates download in the background and install on restart — settings and keys are kept.'
          : 'Automatic updates are off — use "Check for updates" whenever you want; installing keeps all your settings and keys.'}
      </p>
    </section>
  );
}

/**
 * Context windows a local server can be pinned to. The ceiling is the model's
 * trained context (128k–256k on current Gemma/Qwen), but the KV cache grows
 * with it — a window far past what the prompt needs buys nothing and can push
 * layers off the GPU.
 */
const CTX_CHOICES: Array<[number, string]> = [
  [0, 'ctx auto'],
  [4096, '4k'],
  [8192, '8k'],
  [16384, '16k'],
  [32768, '32k'],
  [65536, '64k'],
  [131072, '128k'],
  [262144, '256k'],
];

function ContextSelect({
  value,
  onChange,
}: {
  value: number;
  onChange: (tokens: number | undefined) => void;
}) {
  return (
    <select
      value={String(value)}
      title={
        'Context window for this server. Match your OLLAMA_CONTEXT_LENGTH — a value that differs ' +
        'from the loaded model reloads it on every request. Bigger windows need more VRAM for the ' +
        'KV cache; past what the prompt needs they only cost memory.'
      }
      onChange={(e) => onChange(Number(e.target.value) || undefined)}
    >
      {CTX_CHOICES.map(([tokens, label]) => (
        <option key={tokens} value={tokens}>
          {label}
        </option>
      ))}
    </select>
  );
}

/**
 * One named extra local server (Ollama box or llama.cpp llama-server).
 * The name becomes the "@name" suffix in that server's model ids — that suffix
 * is how an agent pins its model to one specific GPU/box.
 */
function EndpointRow({
  ep,
  urlPlaceholder,
  onChange,
  onRemove,
}: {
  ep: LocalEndpoint;
  urlPlaceholder: string;
  onChange: (next: LocalEndpoint) => void;
  onRemove: () => void;
}) {
  const [name, setName] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const curName = name ?? ep.name;
  const curUrl = url ?? ep.url;
  const dirty = curName !== ep.name || curUrl !== ep.url;
  const ctx = ep.contextTokens ?? 0;
  return (
    <div className={`field-row${ep.enabled ? '' : ' provider-off'}`}>
      <input
        className="endpoint-name"
        value={curName}
        placeholder="name"
        title='Short name for this server — its models appear as "model@name"'
        onChange={(e) => setName(e.target.value)}
      />
      <button
        type="button"
        className={`provider-toggle ${ep.enabled ? 'on' : 'off'}`}
        title="Off keeps the URL but excludes this server"
        onClick={() => onChange({ ...ep, enabled: !ep.enabled })}
      >
        {ep.enabled ? 'On' : 'Off'}
      </button>
      <input value={curUrl} placeholder={urlPlaceholder} onChange={(e) => setUrl(e.target.value)} />
      <ContextSelect value={ctx} onChange={(t) => onChange({ ...ep, contextTokens: t })} />
      <button
        disabled={!dirty}
        onClick={() => {
          onChange({ ...ep, name: curName.trim(), url: curUrl.trim() });
          setName(null);
          setUrl(null);
        }}
      >
        Save
      </button>
      <button type="button" className="ghost" title="Remove this server" onClick={onRemove}>
        ×
      </button>
    </div>
  );
}

export function Settings() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const [ollamaUrl, setOllamaUrl] = useState<string | null>(null);
  const [lmstudioUrl, setLmstudioUrl] = useState<string | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);

  if (!config) return <div className="empty-state">Loading…</div>;

  const ollamaExtras = config.ollamaExtraEndpoints ?? [];
  const llamacppEps = config.llamacppEndpoints ?? [];
  const nextName = (list: LocalEndpoint[]): string => {
    let i = 2;
    while (list.some((e) => e.name === `gpu${i}`)) i++;
    return `gpu${i}`;
  };

  return (
    <div className="settings settings-full">
      <h1>Settings</h1>
      <div className="settings-grid">
      <section>
        <h2>API keys</h2>
        <p className="hint">
          Keys are encrypted with your OS keychain and never leave this machine except to call the
          provider you configured. Use On/Off to keep credentials saved while excluding that provider
          from auto-routing and chat — turn it back on any time. For xAI, Grok login and the API key
          share one On/Off switch (signing in is not a separate always-on channel).
        </p>
        <KeyRow provider="anthropic" />
        <KeyRow provider="openai" />
        <KeyRow provider="openrouter" />
        <XaiProviderRow />
        <KeyRow provider="nvidia" />
      </section>

      <section>
        <h2>Local model servers</h2>
        <div
          className={`field-row${(config.disabledProviders ?? []).includes('ollama') ? ' provider-off' : ''}`}
        >
          <label>Ollama</label>
          <button
            type="button"
            className={`provider-toggle ${(config.disabledProviders ?? []).includes('ollama') ? 'off' : 'on'}`}
            title="Turn Ollama off without forgetting its URL"
            onClick={() => {
              const cur = config.disabledProviders ?? [];
              const off = cur.includes('ollama');
              void saveConfig({
                disabledProviders: off
                  ? cur.filter((p) => p !== 'ollama')
                  : [...cur, 'ollama'],
              });
            }}
          >
            {(config.disabledProviders ?? []).includes('ollama') ? 'Off' : 'On'}
          </button>
          <input
            value={ollamaUrl ?? config.ollamaBaseUrl}
            onChange={(e) => setOllamaUrl(e.target.value)}
          />
          <ContextSelect
            value={config.ollamaContextTokens ?? 0}
            onChange={(t) => void saveConfig({ ollamaContextTokens: t })}
          />
          <button
            disabled={ollamaUrl === null || ollamaUrl === config.ollamaBaseUrl}
            onClick={() => void saveConfig({ ollamaBaseUrl: ollamaUrl ?? config.ollamaBaseUrl })}
          >
            Save
          </button>
          <button
            type="button"
            className="ghost"
            title="Add another Ollama server — one per GPU/box on your LAN"
            onClick={() =>
              void saveConfig({
                ollamaExtraEndpoints: [
                  ...ollamaExtras,
                  { name: nextName(ollamaExtras), url: '', enabled: true },
                ],
              })
            }
          >
            +
          </button>
        </div>
        {ollamaExtras.map((ep, i) => (
          <EndpointRow
            key={i}
            ep={ep}
            urlPlaceholder="http://192.168.1.20:11434"
            onChange={(next) =>
              void saveConfig({
                ollamaExtraEndpoints: ollamaExtras.map((e, j) => (j === i ? next : e)),
              })
            }
            onRemove={() =>
              void saveConfig({ ollamaExtraEndpoints: ollamaExtras.filter((_, j) => j !== i) })
            }
          />
        ))}
        <div
          className={`field-row${(config.disabledProviders ?? []).includes('lmstudio') ? ' provider-off' : ''}`}
        >
          <label>LM Studio</label>
          <button
            type="button"
            className={`provider-toggle ${(config.disabledProviders ?? []).includes('lmstudio') ? 'off' : 'on'}`}
            title="Turn LM Studio off without forgetting its URL"
            onClick={() => {
              const cur = config.disabledProviders ?? [];
              const off = cur.includes('lmstudio');
              void saveConfig({
                disabledProviders: off
                  ? cur.filter((p) => p !== 'lmstudio')
                  : [...cur, 'lmstudio'],
              });
            }}
          >
            {(config.disabledProviders ?? []).includes('lmstudio') ? 'Off' : 'On'}
          </button>
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
        <div
          className={`field-row${(config.disabledProviders ?? []).includes('llamacpp') ? ' provider-off' : ''}`}
        >
          <label>llama.cpp</label>
          <button
            type="button"
            className={`provider-toggle ${(config.disabledProviders ?? []).includes('llamacpp') ? 'off' : 'on'}`}
            title="Turn llama.cpp off without forgetting its servers"
            onClick={() => {
              const cur = config.disabledProviders ?? [];
              const off = cur.includes('llamacpp');
              void saveConfig({
                disabledProviders: off
                  ? cur.filter((p) => p !== 'llamacpp')
                  : [...cur, 'llamacpp'],
              });
            }}
          >
            {(config.disabledProviders ?? []).includes('llamacpp') ? 'Off' : 'On'}
          </button>
          <span className="hint" style={{ flex: 1, margin: 0 }}>
            llama-server boxes — OpenAI wire, URL ends in /v1
          </span>
          <button
            type="button"
            className="ghost"
            title="Add a llama.cpp server — usually one model on one GPU"
            onClick={() =>
              void saveConfig({
                llamacppEndpoints: [
                  ...llamacppEps,
                  { name: nextName(llamacppEps), url: '', enabled: true },
                ],
              })
            }
          >
            +
          </button>
        </div>
        {llamacppEps.map((ep, i) => (
          <EndpointRow
            key={i}
            ep={ep}
            urlPlaceholder="http://192.168.1.20:8080/v1"
            onChange={(next) =>
              void saveConfig({
                llamacppEndpoints: llamacppEps.map((e, j) => (j === i ? next : e)),
              })
            }
            onRemove={() =>
              void saveConfig({ llamacppEndpoints: llamacppEps.filter((_, j) => j !== i) })
            }
          />
        ))}
        <p className="hint">
          No keys needed — local servers are picked up automatically when they are running. Off
          keeps the URL but excludes the server from auto-routing. + adds more servers (one per
          GPU/box on your LAN): their models appear as <code>model@name</code>, and an agent whose
          model is pinned to <code>llama3:70b@gpu2</code> always runs on that box — a full GPU per
          agent. llama.cpp endpoints speak the OpenAI API and usually serve one model each.
        </p>
      </section>

      <McpSection />
      <VisionSection />
      <ImageModelSection />
      <VoiceSection />
      <TelegramSection />

      <UpdatesSection />

      <section>
        <h2>Vodo (default agent)</h2>
        <p className="hint">
          You talk to Vodo; Vodo picks the right model for each job — cheap and local for simple
          work, the big brains only when the task earns them.
        </p>
        <div className="route-modes">
          {(
            [
              ['auto', 'Auto', 'cheapest adequate model per message'],
              ['agents', 'My agents first', 'hand the job to your best-matching agent; Auto as fallback'],
              ['agents-only', 'My agents only', 'always one of your agents — hints pick first, best fit otherwise'],
              ['off', 'Off', 'always use the selected model'],
            ] as const
          ).map(([mode, label, hint]) => (
            <label key={mode} className={`route-mode ${config.routeMode === mode ? 'active' : ''}`}>
              <input
                type="radio"
                name="routeMode"
                checked={config.routeMode === mode}
                onChange={() => void saveConfig({ routeMode: mode })}
              />
              <strong>{label}</strong>
              <span className="hint">{hint}</span>
            </label>
          ))}
        </div>
        <div className="field-row">
          <label>tier</label>
          <select
            className="grow"
            value={config.routeTier}
            title="How Vodo trades cost against capability when picking models"
            onChange={(e) =>
              void saveConfig({ routeTier: e.target.value as AppConfig['routeTier'] })
            }
          >
            <option value="cheap">1 · cheapest capable model</option>
            <option value="balanced">2 · mid-priced, most capable</option>
            <option value="best">3 · best for the job — price no object</option>
          </select>
        </div>
        <ExcludedModels />
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
    </div>
  );
}
