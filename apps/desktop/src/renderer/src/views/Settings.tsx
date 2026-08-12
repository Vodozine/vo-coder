import { useCallback, useEffect, useRef, useState } from 'react';
import { ModelPicker } from '../components/ModelPicker';
import type { McpRegistryEntry } from '@vo-coder/core';
import type {
  AppConfig,
  LocalEndpoint,
  TelegramInfo,
  VoiceSettings,
} from '../../../shared/ipc-contract';
import { ZoomButtons } from '../components/ZoomButtons';
import { useStore } from '../state/store';

const PROVIDERS = ['anthropic', 'ollama', 'lmstudio', 'llamacpp', 'openai', 'openrouter', 'xai', 'zai', 'nvidia'];
/** Providers that can be flipped off without clearing credentials. */
const TOGGLEABLE_PROVIDERS = new Set(PROVIDERS);

function KeyRow({ provider, placeholder }: { provider: string; placeholder?: string }) {
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
            placeholder={
              hasKey ? `paste new key (replaces …${status})` : (placeholder ?? 'paste API key')
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


/**
 * Skills: packaged know-how (Claude-format SKILL.md folders or bare .md
 * how-tos) the agents read on demand through skill_read. Only the one-line
 * catalog rides the system prompt; Off keeps a skill installed but out of
 * the catalog.
 */
function SkillsSection() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const [skills, setSkills] = useState<
    Array<{ slug: string; name: string; description: string; files: string[] }>
  >([]);
  const [note, setNote] = useState('');
  const [url, setUrl] = useState('');
  const [fetching, setFetching] = useState(false);
  useEffect(() => {
    void window.vo.skillsList().then(setSkills);
  }, []);
  if (!config) return null;
  const disabled = new Set(config.disabledSkills ?? []);
  const refresh = () => void window.vo.skillsList().then(setSkills);
  const toggle = (slug: string) => {
    const next = disabled.has(slug)
      ? (config.disabledSkills ?? []).filter((s) => s !== slug)
      : [...(config.disabledSkills ?? []), slug];
    void saveConfig({ disabledSkills: next });
  };
  const add = async (kind: 'folder' | 'file') => {
    setNote('');
    const r = await window.vo.skillsImport(kind);
    if (r.ok) setNote(`imported "${r.name}"`);
    else if (r.error !== 'cancelled') setNote(r.error ?? 'import failed');
    refresh();
  };
  const addFromUrl = async () => {
    const target = url.trim();
    if (!target || fetching) return;
    setNote('');
    setFetching(true);
    const r = await window.vo.skillsImportUrl(target);
    setFetching(false);
    if (r.ok) {
      setNote(r.count && r.count > 1 ? `imported ${r.count}: ${r.name}` : `imported "${r.name}"`);
      setUrl('');
    } else {
      setNote(r.error ?? 'import failed');
    }
    refresh();
  };
  const remove = async (slug: string) => {
    await window.vo.skillsRemove(slug);
    refresh();
  };
  return (
    <section>
      <h2>Skills</h2>
      <p className="hint">
        Packaged know-how the agents read on demand — import skills made for Claude (a folder
        with SKILL.md inside) or any markdown how-to. Only a one-line catalog rides the prompt.
      </p>
      <details className="hint-more">
        <summary>how skills work here</summary>
        <p className="hint">
          Every agent sees the catalog (name + one line per skill) and calls skill_read when a
          task matches — the full instructions load only then. Foreign tool names are translated
          at read time (bash → ws_run, CLAUDE.md → VO-CODER.md), so skills written for other
          harnesses work without editing. Off keeps a skill installed but out of the catalog.
        </p>
      </details>
      {skills.map((s) => (
        <div key={s.slug} className="field-row">
          <span className={`status-dot ${disabled.has(s.slug) ? 'off' : 'on'}`} />
          <label>{s.name}</label>
          <span className="meta grow">
            {s.description}
            {s.files.length ? ` — ${s.files.length} bundled file(s)` : ''}
          </span>
          <button className="ghost" onClick={() => toggle(s.slug)}>
            {disabled.has(s.slug) ? 'On' : 'Off'}
          </button>
          <button className="ghost" onClick={() => void remove(s.slug)}>
            Remove
          </button>
        </div>
      ))}
      {skills.length === 0 && <p className="hint">No skills installed yet.</p>}
      <div className="field-row">
        <input
          className="grow"
          value={url}
          placeholder="Paste a GitHub link from your browser — repo, folder, or SKILL.md"
          title="github.com/owner/repo/tree/main/path/to/skill, a link to a SKILL.md, or just owner/repo"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addFromUrl();
          }}
        />
        <button disabled={!url.trim() || fetching} onClick={() => void addFromUrl()}>
          {fetching ? 'Fetching…' : 'Fetch'}
        </button>
      </div>
      <div className="field-row">
        <button onClick={() => void add('folder')}>Add skill folder…</button>
        <button onClick={() => void add('file')}>Add .md file…</button>
        {note && <span className="meta">{note}</span>}
      </div>
      <p className="hint">
        A skill is instructions your agents will follow — add ones you would be happy to read
        yourself. Point at a repo full of skills and each one inside comes in separately. Use the
        address-bar link: GitHub&apos;s copy button on a folder gives only the path inside the repo,
        which isn&apos;t enough to find it.
      </p>
    </section>
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
        Renders image_generate into the project&apos;s designs/ folder. Picture quality is
        entirely this model.
      </p>
      <details className="hint-more">
        <summary>which one to pick</summary>
        <p className="hint">
          Label art: Google&apos;s <strong>Nano Banana</strong> family on OpenRouter —{' '}
          <code>google/gemini-3-pro-image-preview</code> (Pro; best detail, by far the best at
          readable lettering) or <code>google/gemini-3.1-flash-image</code> (nearly as good, much
          cheaper). <strong>OpenAI gpt-image-1</strong> is the closest alternative;{' '}
          <strong>Flux</strong> suits painterly ornament; <strong>Grok Imagine</strong> comes free
          with a Grok subscription but is weakest on fine detail and text. Switching costs nothing.
        </p>
      </details>
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

/**
 * The video_generate tool's model. Deliberately NOT a ModelPicker: a provider's
 * /v1/models list is chat models, and video generators are a handful of known
 * ids on a different endpoint entirely — so they are named here rather than
 * hunted for in a list they never appear in.
 */
const VIDEO_MODELS: Record<string, Array<{ id: string; note: string }>> = {
  xai: [{ id: 'grok-imagine-video-1.5', note: 'Grok Imagine — 1-15s, up to 1080p, comes with a Grok subscription' }],
  openai: [
    { id: 'sora-2', note: 'Sora 2 — fast, for iterating' },
    { id: 'sora-2-pro', note: 'Sora 2 Pro — slower, higher fidelity' },
  ],
};

function VideoModelSection() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const [provider, setProvider] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);

  if (!config) return null;
  const effProvider = provider ?? config.videoModel?.provider ?? 'xai';
  const known = VIDEO_MODELS[effProvider] ?? [];
  const effModel = model ?? config.videoModel?.model ?? known[0]?.id ?? '';
  const dirty =
    effProvider !== (config.videoModel?.provider ?? '') || effModel !== (config.videoModel?.model ?? '');

  return (
    <section>
      <h2>Video model</h2>
      <p className="hint">
        Renders video_generate into the project folder and plays it in chat. Clips take minutes,
        not seconds — the agent waits, and Stop reaches it.
      </p>
      <details className="hint-more">
        <summary>which one to pick</summary>
        <p className="hint">
          <strong>Grok Imagine</strong> is the cheap one and it is included with a Grok
          subscription, so if you signed in with X it costs nothing extra. <strong>Sora 2</strong>{' '}
          bills per second and needs an OpenAI key — and OpenAI has announced the Videos API shuts
          down on <strong>24 September 2026</strong>, so treat it as the short-term option.
        </p>
      </details>
      <div className="field-row">
        <label>provider</label>
        <select
          value={effProvider}
          onChange={(e) => {
            setProvider(e.target.value);
            setModel(VIDEO_MODELS[e.target.value]?.[0]?.id ?? '');
          }}
        >
          {Object.keys(VIDEO_MODELS).map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select className="grow" value={effModel} onChange={(e) => setModel(e.target.value)}>
          {known.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
          {/* A model id we do not know about yet still has to be selectable. */}
          {!known.some((m) => m.id === effModel) && effModel && (
            <option value={effModel}>{effModel}</option>
          )}
        </select>
        <button
          disabled={!dirty}
          onClick={() =>
            void saveConfig({
              videoModel: effModel ? { provider: effProvider, model: effModel } : null,
            })
          }
        >
          Save
        </button>
        {config.videoModel && (
          <button className="ghost" onClick={() => void saveConfig({ videoModel: null })}>
            Off
          </button>
        )}
      </div>
      <p className="hint">
        {known.find((m) => m.id === effModel)?.note ??
          (config.videoModel ? '' : 'Off — video_generate will tell the agent to come here first.')}
      </p>
    </section>
  );
}

/**
 * The user's standing rules — the ones that follow them between projects. A
 * project's VO-CODER.md covers one folder; this covers all of them, and it is
 * the user's own file, so it opens in an editor rather than being written by
 * an agent on request.
 */
function GlobalRulesSection() {
  const openGlobalRules = useStore((s) => s.openGlobalRules);
  const [path, setPath] = useState('');
  const [lines, setLines] = useState<number | null>(null);

  useEffect(() => {
    void window.vo.globalRulesRead().then((r) => {
      setPath(r.path);
      setLines(r.text.split('\n').filter((l) => l.trim()).length);
    });
  }, []);

  return (
    <section>
      <h2>Your rules</h2>
      <p className="hint">
        Standing rules for every project — Vodo and every agent read them before working, folder or
        no folder. A project&apos;s own VO-CODER.md is narrower and wins where the two disagree.
      </p>
      <div className="field-row">
        <label>file</label>
        <input className="grow" value={path} readOnly />
        <button onClick={openGlobalRules}>Edit in Preview</button>
      </div>
      {lines !== null && (
        <p className="hint">
          {lines > 6
            ? `${lines} lines in force.`
            : 'Nothing set yet — the editor opens with a starting template.'}
        </p>
      )}
    </section>
  );
}

/**
 * Spending. The registry of places money may go — and the ONLY place a payee
 * can be named, which is the whole safety model: an agent picks from this list
 * and supplies an amount, so a web page it read cannot address a payment.
 */
function SpendingSection() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<'api' | 'checkout' | 'payout'>('api');
  const [url, setUrl] = useState('');
  const [payee, setPayee] = useState('');
  const [maxAmount, setMaxAmount] = useState('');

  if (!config) return null;
  const p = config.spending;
  const save = (patch: Partial<typeof p>) => void saveConfig({ spending: { ...p, ...patch } });

  const addMethod = () => {
    const id = `pay_${Date.now().toString(36)}`;
    save({
      methods: [
        ...p.methods,
        {
          id,
          label: label.trim() || 'Unnamed',
          kind,
          currency: p.currency,
          enabled: true,
          ...(kind === 'api' || kind === 'payout' ? { url: url.trim(), secretRef: id } : {}),
          ...(kind === 'payout' && payee.trim() ? { payee: payee.trim() } : {}),
          ...(maxAmount ? { maxAmount: Number(maxAmount) } : {}),
        },
      ],
    });
    setLabel('');
    setUrl('');
    setPayee('');
    setMaxAmount('');
    setAdding(false);
  };

  return (
    <section>
      <h2>Spending</h2>
      <p className="hint">
        Off unless you turn it on. When on, agents get one tool — spend through a method you
        registered here — and <strong>you confirm every single call</strong>. No mode, mission or
        group setting can waive that prompt.
      </p>
      <details className="hint-more">
        <summary>why it works this way</summary>
        <p className="hint">
          An agent reads web pages, repositories and issue trackers, and it cannot reliably tell an
          instruction from you apart from one written into something it read. So it never names a
          payee: it chooses from this list and supplies an amount and a reason. The caps below are
          checked <em>before</em> you are asked, so a confirm dialog is never the only thing between
          a mistake and the money — and every attempt is recorded whether it went through or not.
          Use a virtual card with its own low limit for anything on the other end of this; the
          issuer bounding the damage beats any code of mine being correct.
        </p>
      </details>
      <div className="field-row">
        <label>enabled</label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={p.enabled}
            onChange={(e) => save({ enabled: e.target.checked })}
          />
          agents may spend money
        </label>
      </div>
      {p.enabled && (
        <>
          <div className="field-row">
            <label>limits</label>
            <input
              type="number"
              min={0}
              value={p.perTransactionMax}
              title="Per transaction — anything above is refused, not prompted"
              onChange={(e) => save({ perTransactionMax: Number(e.target.value) })}
            />
            <span className="meta">per payment</span>
            <input
              type="number"
              min={0}
              value={p.dailyMax}
              title="Rolling 24 hours, across every method"
              onChange={(e) => save({ dailyMax: Number(e.target.value) })}
            />
            <span className="meta">per 24h</span>
            <input
              value={p.currency}
              size={4}
              onChange={(e) => save({ currency: e.target.value.toUpperCase().slice(0, 3) })}
            />
          </div>
          {p.methods.length > 0 && (
            <div className="agents-list">
              {p.methods.map((m) => (
                <div key={m.id} className={`agent-row${m.enabled ? '' : ' agent-row--off'}`}>
                  <div className="agent-info">
                    <strong>{m.label}</strong>
                    <span className="meta">
                      {m.kind}
                      {m.payee ? ` → ${m.payee}` : ''}
                      {m.url ? ` · ${m.url}` : ''}
                      {m.maxAmount ? ` · max ${m.maxAmount} ${m.currency}` : ''}
                    </span>
                  </div>
                  <div className="agent-actions">
                    <button
                      className={m.enabled ? 'ghost' : ''}
                      onClick={() =>
                        save({
                          methods: p.methods.map((x) =>
                            x.id === m.id ? { ...x, enabled: !x.enabled } : x,
                          ),
                        })
                      }
                    >
                      {m.enabled ? 'On' : 'Off'}
                    </button>
                    <button
                      className="ghost"
                      onClick={() => save({ methods: p.methods.filter((x) => x.id !== m.id) })}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {adding ? (
            <div className="agent-form form-grid">
              <div className="field-row">
                <label>label</label>
                <input
                  className="grow"
                  value={label}
                  placeholder="OpenRouter credits"
                  onChange={(e) => setLabel(e.target.value)}
                />
                <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                  <option value="api">api — charge an endpoint</option>
                  <option value="checkout">checkout — agent stops, you pay</option>
                  <option value="payout">payout — fixed recipient</option>
                </select>
              </div>
              {kind !== 'checkout' && (
                <div className="field-row">
                  <label>endpoint</label>
                  <input
                    className="grow"
                    value={url}
                    placeholder="https://api.example.com/v1/credits"
                    onChange={(e) => setUrl(e.target.value)}
                  />
                </div>
              )}
              {kind === 'payout' && (
                <div className="field-row">
                  <label>recipient</label>
                  <input
                    className="grow"
                    value={payee}
                    placeholder="who receives it — fixed here, never chosen by an agent"
                    onChange={(e) => setPayee(e.target.value)}
                  />
                </div>
              )}
              <div className="field-row">
                <label>max</label>
                <input
                  type="number"
                  min={0}
                  value={maxAmount}
                  placeholder="this method's own ceiling (optional)"
                  onChange={(e) => setMaxAmount(e.target.value)}
                />
              </div>
              <p className="hint">
                {kind === 'checkout'
                  ? 'Nothing is paid from here: the agent prepares it and stops.'
                  : 'After saving, add the credential under API keys using this method’s id — the token never goes in this form.'}
              </p>
              <div className="modal-actions">
                <button className="ghost" onClick={() => setAdding(false)}>
                  Cancel
                </button>
                <button className="send" disabled={!label.trim()} onClick={addMethod}>
                  Add method
                </button>
              </div>
            </div>
          ) : (
            <button onClick={() => setAdding(true)}>+ Add payment method</button>
          )}
        </>
      )}
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

/** Strip the backticks and quotes that ride along when an id is copied out of docs. */
function cleanId(raw: string): string {
  return raw.trim().replace(/^[`'"<]+|[`'">]+$/g, '').trim();
}

const OTHER = '__other__';

type InstalledVoice = { name: string; language?: string; gender?: string };

/**
 * The voices this machine actually has, read from the same speech engine that
 * will do the speaking. Nobody knows "Microsoft Zira Desktop" by heart, and a
 * name typed one character off is silently ignored by SAPI — so it is picked.
 * A machine with no speech engine gets the old text field back.
 */
function SystemVoicePicker({
  value,
  save,
}: {
  value: string;
  save: (patch: { systemVoice: string }) => void;
}) {
  const [voices, setVoices] = useState<InstalledVoice[] | null>(null);

  useEffect(() => {
    let live = true;
    void window.vo.voiceSystemVoices().then((list) => {
      if (live) setVoices(list);
    });
    return () => {
      live = false;
    };
  }, []);

  if (voices === null) {
    return (
      <select className="grow" disabled>
        <option>Reading installed voices…</option>
      </select>
    );
  }

  // No engine to ask (a Linux box without espeak, mostly) — typing a name is
  // still better than an empty list pretending there are none.
  if (voices.length === 0) {
    return (
      <input
        className="grow"
        placeholder="installed voice name (empty = default)"
        value={value}
        onChange={(e) => save({ systemVoice: e.target.value })}
      />
    );
  }

  // macOS ships ~100 voices across every locale, so they group by language,
  // with the one this app is running in first.
  const uiLang = navigator.language.split('-')[0]!.toLowerCase();
  const groups = new Map<string, InstalledVoice[]>();
  for (const v of voices) {
    const key = v.language ?? '';
    const list = groups.get(key);
    if (list) list.push(v);
    else groups.set(key, [v]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => {
    const rank = (l: string) => (l.split('-')[0]!.toLowerCase() === uiLang ? 0 : 1);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  const label = (v: InstalledVoice) => (v.gender ? `${v.name} — ${v.gender}` : v.name);
  const installed = voices.some((v) => v.name === value);

  return (
    <select
      className="grow"
      value={value}
      onChange={(e) => save({ systemVoice: e.target.value })}
      title="Voices installed on this machine — add more in the OS speech settings"
    >
      <option value="">System default</option>
      {/* A profile carried over from another machine keeps its choice visible
          rather than snapping back to the default without saying so. */}
      {value && !installed && <option value={value}>{value} (not installed here)</option>}
      {ordered.map(([lang, list]) =>
        lang ? (
          <optgroup key={lang} label={lang}>
            {list.map((v) => (
              <option key={v.name} value={v.name}>
                {label(v)}
              </option>
            ))}
          </optgroup>
        ) : (
          list.map((v) => (
            <option key={v.name} value={v.name}>
              {label(v)}
            </option>
          ))
        ),
      )}
    </select>
  );
}

/**
 * The custom speech endpoint, asked rather than guessed: the model list comes
 * from {base}/models and the voices from the server or from the model family.
 * Typing them by hand is what produced a 404 for a model id that existed —
 * the backticks came along with the copy.
 */
function CompatTtsFields({
  v,
  save,
}: {
  v: VoiceSettings;
  save: (patch: Partial<VoiceSettings>) => void;
}) {
  const secretStatus = useStore((s) => s.secretStatus);
  const [catalog, setCatalog] = useState<{ models: string[]; voicesFor: Record<string, string[]> }>({
    models: [],
    voicesFor: {},
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [freeModel, setFreeModel] = useState(false);
  const [freeVoice, setFreeVoice] = useState(false);
  const keyState = secretStatus['tts-custom'];

  const load = useCallback(async () => {
    if (!v.compatBaseUrl.trim()) return;
    setBusy(true);
    setError(null);
    const res = await window.vo.voiceCompatCatalog(v.compatBaseUrl);
    setBusy(false);
    if (!res.ok) {
      setCatalog({ models: [], voicesFor: {} });
      setError(res.error ?? 'Could not read the endpoint.');
      return;
    }
    setCatalog({ models: res.models, voicesFor: res.voicesFor });
    if (!res.models.length) setError('The endpoint lists no models.');
  }, [v.compatBaseUrl]);

  // Re-ask whenever the endpoint or the saved key changes — "accepted key"
  // is exactly the moment the lists become available.
  useEffect(() => {
    void load();
  }, [load, keyState]);

  const voices = catalog.voicesFor[cleanId(v.compatModel)] ?? [];
  const modelKnown = catalog.models.includes(cleanId(v.compatModel));
  const voiceKnown = voices.includes(cleanId(v.compatVoice));

  return (
    <>
      <p className="hint">
        Any OpenAI-compatible /audio/speech endpoint works: Groq (Orpheus voices), a local Kokoro
        or Chatterbox server, LiteLLM proxies… Key is optional — local servers usually need none.
      </p>
      <div className="field-row">
        <label>base URL</label>
        <input
          className="grow"
          placeholder="https://api.groq.com/openai/v1 or http://127.0.0.1:8880/v1"
          value={v.compatBaseUrl}
          onChange={(e) => save({ compatBaseUrl: e.target.value })}
          onBlur={(e) => save({ compatBaseUrl: cleanId(e.target.value) })}
        />
        <button className="ghost" disabled={busy} onClick={() => void load()}>
          {busy ? 'Reading…' : 'Refresh'}
        </button>
      </div>
      <div className="field-row">
        <label>model</label>
        {catalog.models.length > 0 && !freeModel ? (
          <select
            className="grow"
            value={modelKnown ? cleanId(v.compatModel) : OTHER}
            onChange={(e) => {
              if (e.target.value === OTHER) {
                setFreeModel(true);
                return;
              }
              // A voice belongs to its model — never carry one across.
              save({ compatModel: e.target.value, compatVoice: '' });
            }}
          >
            {!modelKnown && (
              <option value={OTHER}>{v.compatModel || 'pick a model'} (type my own)</option>
            )}
            {catalog.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            {modelKnown && <option value={OTHER}>type my own…</option>}
          </select>
        ) : (
          <input
            className="grow"
            placeholder="model (e.g. canopylabs/orpheus-v1-english, kokoro)"
            value={v.compatModel}
            onChange={(e) => save({ compatModel: e.target.value })}
            onBlur={(e) => save({ compatModel: cleanId(e.target.value) })}
          />
        )}
      </div>
      <div className="field-row">
        <label>voice</label>
        {voices.length > 0 && !freeVoice ? (
          <select
            className="grow"
            value={voiceKnown ? cleanId(v.compatVoice) : OTHER}
            onChange={(e) => {
              if (e.target.value === OTHER) {
                setFreeVoice(true);
                return;
              }
              save({ compatVoice: e.target.value });
            }}
          >
            {!voiceKnown && (
              <option value={OTHER}>{v.compatVoice || 'pick a voice'} (type my own)</option>
            )}
            {voices.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
            {voiceKnown && <option value={OTHER}>type my own…</option>}
          </select>
        ) : (
          <input
            className="grow"
            placeholder={
              catalog.models.length ? 'voice name for this model' : 'voice (e.g. daniel, af_bella)'
            }
            value={v.compatVoice}
            onChange={(e) => save({ compatVoice: e.target.value })}
            onBlur={(e) => save({ compatVoice: cleanId(e.target.value) })}
          />
        )}
      </div>
      {error && <p className="hint error-text">{error}</p>}
      {!error && catalog.models.length > 0 && (
        <p className="hint">
          {catalog.models.length} speech model{catalog.models.length === 1 ? '' : 's'} from this
          endpoint
          {voices.length
            ? ` · ${voices.length} voices for this model.`
            : // No list is not the same as no voices. A server that does not
              // publish /audio/voices (openedai-speech, most Piper wrappers)
              // has whatever names its own config gives it, and guessing them
              // from the model id produces a list where every entry fails.
              ' · it does not publish its voice names, so type the one you configured (piper: salka, bui…).'}
        </p>
      )}
      <KeyRow provider="tts-custom" />
    </>
  );
}

/**
 * Speak one sentence through whatever is configured right now. Every voice
 * fault so far has been found by sending a chat message and reading the red
 * line underneath it — this makes the same check one click, right beside the
 * settings that cause it.
 */
function TestVoiceButton() {
  const [state, setState] = useState<'idle' | 'busy' | 'ok'>('idle');
  const [error, setError] = useState<string | null>(null);
  const playerRef = useRef<HTMLAudioElement | null>(null);

  const test = async () => {
    setState('busy');
    setError(null);
    const result = await window.vo.voiceSpeak(
      'Vo-Coder speaking. If you can hear this, the voice you picked is working.',
    );
    if (!result.ok) {
      setState('idle');
      setError(result.error);
      return;
    }
    // 'native' means the system engine already spoke on its own.
    if (result.output.kind === 'audio') {
      const bytes = result.output.data;
      const blob = new Blob([bytes], { type: result.output.mimeType });
      const audio = new Audio(URL.createObjectURL(blob));
      // Held in a ref: a bare local can be collected mid-clip.
      playerRef.current = audio;
      audio.onerror = () =>
        setError(
          `The endpoint returned ${(bytes as ArrayBuffer).byteLength} bytes of ` +
            `${result.output.kind === 'audio' ? result.output.mimeType : ''} this machine could not decode.`,
        );
      void audio.play().catch((err: unknown) => {
        const e = err as { name?: string; message?: string };
        setError(
          e?.name === 'NotAllowedError'
            ? 'The window refused to play audio (autoplay policy).'
            : `Could not play it${e?.message ? `: ${e.message}` : ''}.`,
        );
      });
    }
    setState('ok');
    setTimeout(() => setState('idle'), 2500);
  };

  return (
    <>
      <button className="ghost" disabled={state === 'busy'} onClick={() => void test()}>
        {state === 'busy' ? 'Speaking…' : state === 'ok' ? 'Spoke ✓' : 'Test voice'}
      </button>
      {error && (
        <span className="hint error-text" style={{ margin: 0 }}>
          {error}
        </span>
      )}
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
        Hold the mic (or Ctrl+Space) to dictate; the Live toggle in Chat talks back.
      </p>
      <details className="hint-more">
        <summary>how the two differ, and what speed/pitch reach</summary>
        <p className="hint">
          Dictation inserts what you said into the composer and does not send it. Live chat speaks
          the answers aloud and can be interrupted at any time. <strong>Speed</strong> is the one
          control every OpenAI-compatible endpoint understands (Groq, OpenAI, Kokoro…) and is sent
          only when it is not 1. <strong>Pitch</strong> exists only on the offline system voice —
          no cloud speech API offers one — where it goes through SSML on Windows, an embedded
          command on macOS, and espeak&apos;s own flag on Linux.
        </p>
      </details>
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
        <input
          list="stt-langs"
          size={6}
          placeholder="auto"
          value={v.sttLanguage}
          title="The language YOU speak, as an ISO-639-1 code — is, en, da, de… Empty means auto-detect. Set it if you dictate in anything other than English: whisper.cpp's own default is English, so until now it was pushing every language through English rather than detecting one."
          onChange={(e) => save({ sttLanguage: e.target.value.trim().toLowerCase() })}
        />
        <datalist id="stt-langs">
          <option value="is">Icelandic</option>
          <option value="en">English</option>
          <option value="da">Danish</option>
          <option value="no">Norwegian</option>
          <option value="sv">Swedish</option>
          <option value="de">German</option>
          <option value="pl">Polish</option>
        </datalist>
      </div>
      {v.stt === 'openai' && (
        <div className="field-row">
          <label>server</label>
          <input
            className="grow"
            placeholder="https://api.openai.com/v1 — or your own, e.g. http://192.168.1.61:8000/v1"
            value={v.sttBaseUrl}
            title="Any OpenAI-compatible /audio/transcriptions endpoint. Your own server (speaches / faster-whisper on a GPU box) is the only way to run a model big enough for a language other than English at conversational speed — the same model on this laptop's CPU is several times slower than realtime. A local server needs no key."
            onChange={(e) => save({ sttBaseUrl: e.target.value })}
            onBlur={(e) => save({ sttBaseUrl: e.target.value.trim().replace(/\/+$/, '') })}
          />
        </div>
      )}
      {v.stt === 'whisper-local' && v.sttLanguage && v.sttLanguage !== 'en' && (
        <p className="hint">
          The bundled <code>ggml-base</code> model is multilingual but small, and a language
          further from English will be rough with it. If <strong>{v.sttLanguage}</strong> comes back
          garbled, a larger model in the same folder (<code>ggml-large-v3</code>) is a real step up
          — slower per phrase, since this runs on this machine&apos;s CPU.
        </p>
      )}
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
        {v.tts !== 'none' && <TestVoiceButton />}
      </div>
      {v.tts === 'system' && (
        <>
          <div className="field-row">
            <label>voice</label>
            <SystemVoicePicker value={v.systemVoice} save={save} />
          </div>
          <div className="field-row">
            <label>rate / pitch</label>
            <input
              type="range"
              className="grow"
              min={-10}
              max={10}
              step={1}
              title={`Speaking rate ${v.systemRate} (-10 slow … 10 fast)`}
              value={v.systemRate}
              onChange={(e) => save({ systemRate: Number(e.target.value) })}
            />
            <input
              type="range"
              className="grow"
              min={-10}
              max={10}
              step={1}
              title={`Pitch ${v.systemPitch ?? 0} (-10 low … 10 high)`}
              value={v.systemPitch ?? 0}
              onChange={(e) => save({ systemPitch: Number(e.target.value) })}
            />
            <span className="meta">
              {v.systemRate > 0 ? `+${v.systemRate}` : v.systemRate} /{' '}
              {(v.systemPitch ?? 0) > 0 ? `+${v.systemPitch}` : (v.systemPitch ?? 0)}
            </span>
          </div>
        </>
      )}
      {(v.tts === 'openai' || v.tts === 'compat') && (
        <div className="field-row">
          <label>speed</label>
          <input
            type="range"
            className="grow"
            min={0.5}
            max={2}
            step={0.05}
            title="1 = the voice's own pace. Sent only when it differs from 1."
            value={v.ttsSpeed ?? 1}
            onChange={(e) => save({ ttsSpeed: Number(e.target.value) })}
          />
          <span className="meta">{(v.ttsSpeed ?? 1).toFixed(2)}×</span>
          {(v.ttsSpeed ?? 1) !== 1 && (
            <button className="ghost" onClick={() => save({ ttsSpeed: 1 })}>
              Reset
            </button>
          )}
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
      {v.tts === 'compat' && <CompatTtsFields v={v} save={save} />}
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
          download updates in the background
        </label>
      </div>
      <p className="hint">
        {config?.autoUpdate ?? true
          ? 'Installs on restart — settings and keys are kept.'
          : 'Off — check whenever you like; installing keeps your settings and keys.'}
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
        'Context window for this server. "auto" measures each model on this box and picks the ' +
        'largest window that still fits entirely in VRAM — spilling even a few layers to the CPU ' +
        'costs roughly 20x throughput. A fixed value is sent unchanged, so match your ' +
        'OLLAMA_CONTEXT_LENGTH: a window that differs from the loaded model reloads it.'
      }
      onChange={(e) => onChange(Number(e.target.value) || undefined)}
    >
      {CTX_CHOICES.map(([tokens, label]) => (
        <option key={tokens} value={tokens}>
          {tokens === 0 ? 'auto (fit GPU)' : label}
        </option>
      ))}
    </select>
  );
}

/**
 * How long a model stays resident once idle. Loading costs tens of seconds on
 * real hardware, so this is the biggest single lever on how fast a chat feels.
 */
const KEEP_CHOICES: Array<[number | 'always', string]> = [
  [5, 'keep 5m'],
  [15, 'keep 15m'],
  [30, 'keep 30m'],
  [60, 'keep 1h'],
  [240, 'keep 4h'],
  ['always', 'always on'],
];

function KeepAliveSelect({
  value,
  onChange,
  disabled,
  title,
}: {
  value: number | 'always' | undefined;
  onChange: (keep: number | 'always') => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <select
      value={String(value ?? 30)}
      disabled={disabled}
      title={
        title ??
        'How long this server keeps a model in memory after the last message. "always on" stops ' +
          'it unloading while idle — it cannot stop another model evicting it when VRAM is needed.'
      }
      onChange={(e) => onChange(e.target.value === 'always' ? 'always' : Number(e.target.value))}
    >
      {KEEP_CHOICES.map(([v, label]) => (
        <option key={String(v)} value={String(v)}>
          {label}
        </option>
      ))}
    </select>
  );
}

/** VRAM the card has. Ollama's API never reports it, and auto-fit needs it. */
function VramInput({
  value,
  onChange,
}: {
  value: number | undefined;
  onChange: (gb: number | undefined) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value ? String(value) : '');
  return (
    <input
      className="endpoint-vram"
      value={shown}
      placeholder="VRAM GB"
      title={
        "This box's VRAM in GB. Ollama never reports a card's total memory, so without it " +
        '"auto" can only fit a window after a spill has revealed the ceiling the slow way.'
      }
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null) onChange(Number(draft) || undefined);
        setDraft(null);
      }}
    />
  );
}

/**
 * One named extra local server (Ollama box, llama.cpp llama-server, LM Studio).
 * The name becomes the "@name" suffix in that server's model ids — that suffix
 * is how an agent pins its model to one specific GPU/box.
 */
function EndpointRow({
  ep,
  urlPlaceholder,
  onChange,
  onRemove,
  /** llama-server owns its own residency; offering the control would be a lie. */
  residency = true,
  showVram = true,
  /** LM Studio chooses its own window and residency in its own UI — the whole
      tuning line would be a set of controls that do nothing. */
  tuning = true,
}: {
  ep: LocalEndpoint;
  urlPlaceholder: string;
  onChange: (next: LocalEndpoint) => void;
  onRemove: () => void;
  residency?: boolean;
  showVram?: boolean;
  tuning?: boolean;
}) {
  const [name, setName] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const curName = name ?? ep.name;
  const curUrl = url ?? ep.url;
  const dirty = curName !== ep.name || curUrl !== ep.url;
  const ctx = ep.contextTokens ?? 0;
  return (
    <div className={`endpoint${ep.enabled ? '' : ' provider-off'}`}>
      <div className="field-row">
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
        <input
          value={curUrl}
          placeholder={urlPlaceholder}
          onChange={(e) => setUrl(e.target.value)}
        />
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
      {tuning && (
        <EndpointTuning
          ctx={ctx}
          onCtx={(t) => onChange({ ...ep, contextTokens: t })}
          vramGb={showVram ? ep.vramGb : undefined}
          onVram={showVram ? (gb) => onChange({ ...ep, vramGb: gb }) : undefined}
          keepAlive={ep.keepAlive}
          onKeep={(k) => onChange({ ...ep, keepAlive: k })}
          residency={residency}
        />
      )}
    </div>
  );
}

/**
 * The per-server tuning line. Separated from the identity line above it
 * because nine controls on one row is unreadable at any panel width — and
 * because a bare "24" needs to say it means gigabytes.
 */
function EndpointTuning({
  ctx,
  onCtx,
  vramGb,
  onVram,
  keepAlive,
  onKeep,
  residency = true,
}: {
  ctx: number;
  onCtx: (tokens: number | undefined) => void;
  vramGb?: number;
  onVram?: (gb: number | undefined) => void;
  keepAlive: number | 'always' | undefined;
  onKeep: (keep: number | 'always') => void;
  residency?: boolean;
}) {
  return (
    <div className="endpoint-tune">
      <span>window</span>
      <ContextSelect value={ctx} onChange={onCtx} />
      {onVram && (
        <>
          <span>VRAM</span>
          <VramInput value={vramGb} onChange={onVram} />
          <span>GB</span>
        </>
      )}
      <span>keep</span>
      {residency ? (
        <KeepAliveSelect value={keepAlive} onChange={onKeep} />
      ) : (
        <em title="llama-server holds its model for the life of the process — residency is set at launch, not per request.">
          server-managed
        </em>
      )}
    </div>
  );
}

export function Settings() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const [ollamaUrl, setOllamaUrl] = useState<string | null>(null);
  const [lmstudioUrl, setLmstudioUrl] = useState<string | null>(null);
  const [flmUrl, setFlmUrl] = useState<string | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);

  if (!config) return <div className="empty-state">Loading…</div>;

  const ollamaExtras = config.ollamaExtraEndpoints ?? [];
  const llamacppEps = config.llamacppEndpoints ?? [];
  const lmstudioEps = config.lmstudioExtraEndpoints ?? [];
  const flmEps = config.flmExtraEndpoints ?? [];
  // Numbering starts at 2 because the unnamed primary server is number one.
  const nextName = (list: LocalEndpoint[], prefix = 'gpu'): string => {
    let i = 2;
    while (list.some((e) => e.name === `${prefix}${i}`)) i++;
    return `${prefix}${i}`;
  };

  return (
    <div className="settings settings-full">
      <h1>Settings</h1>
      <div className="settings-grid">
      <section>
        <h2>API keys</h2>
        <p className="hint">
          Encrypted with your OS keychain; they leave only to call the provider you configured.
        </p>
        <details className="hint-more">
          <summary>what On/Off does</summary>
          <p className="hint">
            Keeps the credentials saved while excluding that provider from auto-routing and chat —
            turn it back on any time. For xAI, Grok login and the API key share one switch
            (signing in is not a separate always-on channel).
          </p>
        </details>
        <KeyRow provider="anthropic" />
        <KeyRow provider="openai" />
        <KeyRow provider="openrouter" />
        <XaiProviderRow />
        <KeyRow provider="zai" placeholder="paste GLM Coding Plan key" />
        <details className="hint-more">
          <summary>zai: the Coding Plan key, not a credits key</summary>
          <p className="hint">
            A <strong>GLM Coding Plan</strong> issues its own key under{' '}
            <em>Coding Plan → Plan Overview</em> and usage draws that plan&apos;s quota, not
            pay-as-you-go credits. A platform/credits key is a different thing and is not
            interchangeable. Vo-Coder talks to the plan&apos;s coding endpoint.
          </p>
        </details>
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
        <EndpointTuning
          ctx={config.ollamaContextTokens ?? 0}
          onCtx={(t) => void saveConfig({ ollamaContextTokens: t })}
          vramGb={config.ollamaVramGb}
          onVram={(gb) => void saveConfig({ ollamaVramGb: gb })}
          keepAlive={config.ollamaKeepAlive}
          onKeep={(k) => void saveConfig({ ollamaKeepAlive: k })}
        />
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
            placeholder="http://192.168.1.20:1234"
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
          <button
            type="button"
            className="ghost"
            title="Add another LM Studio server — one per box; its models list as model@name"
            onClick={() =>
              void saveConfig({
                lmstudioExtraEndpoints: [
                  ...lmstudioEps,
                  { name: nextName(lmstudioEps, 'lm'), url: '', enabled: true },
                ],
              })
            }
          >
            +
          </button>
        </div>
        {lmstudioEps.map((ep, i) => (
          <EndpointRow
            key={i}
            ep={ep}
            urlPlaceholder="http://192.168.1.20:1234"
            tuning={false}
            onChange={(next) =>
              void saveConfig({
                lmstudioExtraEndpoints: lmstudioEps.map((e, j) => (j === i ? next : e)),
              })
            }
            onRemove={() =>
              void saveConfig({
                lmstudioExtraEndpoints: lmstudioEps.filter((_, j) => j !== i),
              })
            }
          />
        ))}
        <div
          className={`field-row${(config.disabledProviders ?? []).includes('flm') ? ' provider-off' : ''}`}
        >
          <label title="FastFlowLM — models running on an NPU">FLM (NPU)</label>
          <button
            type="button"
            className={`provider-toggle ${(config.disabledProviders ?? []).includes('flm') ? 'off' : 'on'}`}
            title="Turn FLM off without forgetting its URL"
            onClick={() => {
              const cur = config.disabledProviders ?? [];
              const off = cur.includes('flm');
              void saveConfig({
                disabledProviders: off ? cur.filter((p) => p !== 'flm') : [...cur, 'flm'],
              });
            }}
          >
            {(config.disabledProviders ?? []).includes('flm') ? 'Off' : 'On'}
          </button>
          <input
            value={flmUrl ?? config.flmBaseUrl}
            placeholder="http://127.0.0.1:52625"
            onChange={(e) => setFlmUrl(e.target.value)}
          />
          <button
            disabled={flmUrl === null || flmUrl === config.flmBaseUrl}
            onClick={() => void saveConfig({ flmBaseUrl: flmUrl ?? config.flmBaseUrl })}
          >
            Save
          </button>
          <button
            type="button"
            className="ghost"
            title="Add another FLM box — one per machine; its models list as model@name"
            onClick={() =>
              void saveConfig({
                flmExtraEndpoints: [...flmEps, { name: nextName(flmEps, 'npu'), url: '', enabled: true }],
              })
            }
          >
            +
          </button>
        </div>
        {flmEps.map((ep, i) => (
          <EndpointRow
            key={i}
            ep={ep}
            urlPlaceholder="http://192.168.1.20:52625"
            tuning={false}
            onChange={(next) =>
              void saveConfig({ flmExtraEndpoints: flmEps.map((e, j) => (j === i ? next : e)) })
            }
            onRemove={() =>
              void saveConfig({ flmExtraEndpoints: flmEps.filter((_, j) => j !== i) })
            }
          />
        ))}
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
            residency={false}
            showVram={false}
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
        <details className="hint-more">
          <summary>window, VRAM, keep, and one box per GPU</summary>
          <p className="hint">
            No keys needed — running servers are picked up automatically. <strong>+</strong> adds
            one per GPU/box: their models list as <code>model@name</code>, so an agent pinned to{' '}
            <code>llama3:70b@gpu2</code> always runs on that box. <strong>window</strong> auto-fits
            each model to the card&apos;s VRAM (spilling to CPU costs ~20× speed, silently) —{' '}
            <strong>VRAM</strong> tells it the card&apos;s size, which Ollama never reports.{' '}
            <strong>keep</strong> is how long a model stays loaded while idle.
          </p>
        </details>
      </section>

      <GlobalRulesSection />
      <McpSection />
      <SkillsSection />
      <VisionSection />
      <ImageModelSection />
      <VideoModelSection />
      <VoiceSection />
      <SpendingSection />
      <TelegramSection />

      <UpdatesSection />

      <section>
        <h2>Mr Homelab</h2>
        <div className="field-row">
          <label>tab</label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={!!config.homelabEnabled}
              onChange={(e) => void saveConfig({ homelabEnabled: e.target.checked })}
            />
            show the Mr Homelab tab (under Terminal)
          </label>
        </div>
        <p className="hint">
          A dedicated infrastructure agent with his own chat and his own model picker in that tab.
        </p>
        <details className="hint-more">
          <summary>what he covers</summary>
          <p className="hint">
            Hypervisors and VMs, containers, NAS and storage, networking, DNS and proxies,
            backups, monitoring, the GPUs your local models run on. Same chat as anywhere else:
            voice, Live, folders, attachments. Connect him to your gear with MCP servers — the
            bundled <strong>infra</strong> server covers Proxmox. He stays out of ordinary
            auto-routing so he never absorbs normal chat, but Vodo can put him on a{' '}
            <strong>group project</strong> when a job has an infrastructure part.
          </p>
        </details>
      </section>

      <section>
        <h2>Generic folder</h2>
        <div className="field-row">
          <label>location</label>
          <span className="meta grow" title={config.genericDir}>
            {config.genericDir || 'resolving…'}
          </span>
          <button
            onClick={() =>
              void (async () => {
                const dir = await window.vo.scaffoldPickDir();
                if (dir) await saveConfig({ genericDir: dir });
              })()
            }
          >
            Change…
          </button>
        </div>
        <p className="hint">
          Where folder-less chats write, so nothing ever fails for lack of a workspace. Real
          projects (and every group project) still get their own folder.
        </p>
      </section>

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
      <DisplaySection />
      </div>
    </div>
  );
}

/**
 * Whole-app zoom. Applied instantly through webFrame (no restart), persisted
 * in config so the next boot re-applies it. The preview overlay compensates
 * in main (previewBounds × zoomFactor), so nothing drifts. The same buttons
 * sit in the chat header, next to the provider picks.
 */
function DisplaySection() {
  return (
    <section>
      <h2>Display</h2>
      <div className="field-row">
        <label>UI zoom</label>
        <ZoomButtons showValue />
      </div>
      <p className="hint">
        Scales the whole interface — for small screens where the UI reads too fine.
      </p>
    </section>
  );
}
