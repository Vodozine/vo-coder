import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ModelPicker } from '../components/ModelPicker';
import { PairingCode } from '../components/PairingCode';
import type { McpRegistryEntry } from '@vo-coder/core';
import type { AgentSpec } from '@vo-coder/providers';
import {
  HOMELAB_AGENT_ID,
  HOMELAB_SYSTEM_PROMPT,
  homelabAgentSpec,
} from '../../../shared/homelab';
import { AUTO_AGENT_MAX_CAP, DEFAULT_AUTO_AGENT_PROMPT } from '../../../shared/auto-agents';
import type {
  AppConfig,
  LocalEndpoint,
  McpOauthEvent,
  RemoteInfo,
  RemoteSettings,
  TelegramInfo,
  VoiceSettings,
} from '../../../shared/ipc-contract';
import { DEFAULT_REMOTE_PORT, mcpOauthLabelForUrl } from '../../../shared/ipc-contract';
import { ZoomButtons } from '../components/ZoomButtons';
import { Icon, type IconName } from '../components/Icon';
import { useStore } from '../state/store';

// One <id>.png per SettingsTile id (see assets/settings-icons). Static imports —
// Vite hashes each and hands back its URL; tileIcon(id) maps a tile to its icon.
import iconKeys from '../assets/settings-icons/keys.png';
import iconLocal from '../assets/settings-icons/local.png';
import iconRules from '../assets/settings-icons/rules.png';
import iconMcp from '../assets/settings-icons/mcp.png';
import iconSkills from '../assets/settings-icons/skills.png';
import iconVision from '../assets/settings-icons/vision.png';
import iconImage from '../assets/settings-icons/image.png';
import iconVideo from '../assets/settings-icons/video.png';
import iconVoice from '../assets/settings-icons/voice.png';
import iconSpending from '../assets/settings-icons/spending.png';
import iconTelegram from '../assets/settings-icons/telegram.png';
import iconUpdates from '../assets/settings-icons/updates.png';
import iconHomelab from '../assets/settings-icons/homelab.png';
import iconGeneric from '../assets/settings-icons/generic.png';
import iconVodo from '../assets/settings-icons/vodo.png';
import iconDisplay from '../assets/settings-icons/display.png';
const TILE_ICONS: Record<string, string> = {
  keys: iconKeys, local: iconLocal, rules: iconRules, mcp: iconMcp, connections: iconMcp, skills: iconSkills,
  vision: iconVision, image: iconImage, video: iconVideo, voice: iconVoice,
  spending: iconSpending, telegram: iconTelegram, updates: iconUpdates, homelab: iconHomelab,
  generic: iconGeneric, vodo: iconVodo, display: iconDisplay,
};
const tileIcon = (id: string): string | undefined => TILE_ICONS[id];

const PROVIDERS = ['anthropic', 'ollama', 'lmstudio', 'llamacpp', 'openai', 'openrouter', 'xai', 'zai', 'nvidia'];
// Appended as a statement: the array line above may not be edited by shared
// commits (scripts/edition-patterns.mjs scans added lines).
PROVIDERS.push('claude-code');
PROVIDERS.push('gemini');
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

/**
 * Claude Code as a provider — no key row, because there is no key: it runs the
 * user's installed CLI under their own login. What this row offers instead is
 * the On/Off gate, a path override for unusual installs, and a Check button so
 * a broken setup fails HERE with a version string or a reason, not mid-chat.
 */
function ClaudeCodeRow() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const [path, setPath] = useState<string | null>(null);
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [checking, setChecking] = useState(false);

  const providerOff = (config?.disabledProviders ?? []).includes('claude-code');
  const setEnabled = (on: boolean) => {
    const cur = config?.disabledProviders ?? [];
    void saveConfig({
      disabledProviders: on
        ? cur.filter((p) => p !== 'claude-code')
        : cur.includes('claude-code')
          ? cur
          : [...cur, 'claude-code'],
    });
  };

  const runCheck = async () => {
    setChecking(true);
    try {
      const r = await window.vo.claudeCliCheck();
      setCheck(
        r.ok
          ? { ok: true, text: `${r.version ?? 'found'} — ${r.path ?? ''}` }
          : { ok: false, text: r.error ?? 'not found' },
      );
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <div className={`field-row provider-key-row${providerOff ? ' provider-off' : ''}`}>
        <label>claude-code</label>
        <button
          type="button"
          className={`provider-toggle ${providerOff ? 'off' : 'on'}`}
          title={
            providerOff
              ? 'Claude Code agents are off — click to enable'
              : 'Claude Code agents are on — click to disable'
          }
          onClick={() => setEnabled(providerOff)}
        >
          {providerOff ? 'Off' : 'On'}
        </button>
        <input
          className="grow"
          value={path ?? config?.claudeCliPath ?? ''}
          placeholder="path to the claude binary (empty = find it automatically)"
          onChange={(e) => setPath(e.target.value)}
          onBlur={() => {
            if (path !== null && path !== (config?.claudeCliPath ?? '')) {
              void saveConfig({ claudeCliPath: path.trim() });
            }
          }}
        />
        <button type="button" onClick={() => void runCheck()} disabled={checking}>
          {checking ? 'Checking…' : 'Check'}
        </button>
      </div>
      {check && (
        <p className={`hint${check.ok ? '' : ' error-text'}`}>
          {check.ok ? `✓ ${check.text}` : check.text}
        </p>
      )}
      <details className="hint-more">
        <summary>claude-code: your installed Claude Code as an agent</summary>
        <p className="hint">
          Runs the <code>claude</code> CLI you already have, under its own login — nothing is
          billed through Vo-Coder and no key is stored. Make an agent whose provider is{' '}
          <code>claude-code</code> and hire it like any other: chat with it, give it missions,
          seat it in groups. It edits files in the chat&apos;s folder with its own tools, and the
          Preview code view shows the changes live. Best used for agents; Vodo himself should
          stay on a regular model so he keeps his coordination tools.
        </p>
      </details>
    </>
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
    if (!entry.install && !entry.remoteUrl) return;
    const required = (entry.install?.envVars ?? []).filter((v) => v.isRequired);
    if (required.some((v) => !envValues[v.name]?.trim()) && !envOpen) {
      setEnvOpen(true);
      return;
    }
    setState('adding');
    const name = suggestName(entry, taken);
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries(envValues)) if (v.trim()) vars[k] = v.trim();
    // Remote (HTTP) entry → add by url; local entry → add by command. Any typed
    // values are HTTP headers for a remote server, process env for a local one.
    const cfg = entry.remoteUrl
      ? { name, url: entry.remoteUrl, ...(Object.keys(vars).length ? { headers: vars } : {}) }
      : {
          name,
          command: entry.install!.command,
          args: entry.install!.args,
          ...(Object.keys(vars).length ? { env: vars } : {}),
        };
    const status = await window.vo.mcpAdd(cfg);
    await saveConfig({}); // re-pull config (mcpAdd wrote the server list in main)
    await refreshMcp();
    if (status.connected) {
      setState('added');
      setDetail(`connected as "${name}" — ${status.toolCount} tools`);
    } else {
      setState('failed');
      setDetail(
        status.error ??
          (entry.remoteUrl
            ? `added as "${name}" — if it needs a token, hit Headers on its row and add Authorization=Bearer <token>, then Connect`
            : 'could not connect (it stays in your server list to retry)'),
      );
    }
  };

  return (
    <div className="registry-result">
      <div className="registry-head">
        <div className="registry-info">
          <strong>{entry.displayName}</strong>
          <span className="meta">{entry.description || entry.name}</span>
          {entry.install ? (
            <code className="registry-cmd">
              {entry.install.command} {entry.install.args.join(' ')}
            </code>
          ) : entry.remoteUrl ? (
            <code className="registry-cmd">remote · {entry.remoteUrl}</code>
          ) : null}
        </div>
        {entry.install || entry.remoteUrl ? (
          <button
            className={state === 'added' ? 'ghost' : 'send'}
            disabled={state === 'adding' || state === 'added'}
            onClick={() => void add()}
          >
            {state === 'adding' ? 'Adding…' : state === 'added' ? 'Added ✓' : 'Add'}
          </button>
        ) : (
          entry.homepage && (
            <button
              className="ghost"
              title="Open the server's page"
              onClick={() => entry.homepage && void window.vo.openExternal(entry.homepage)}
            >
              page ↗
            </button>
          )
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

function McpSection({ embedded }: { embedded?: boolean } = {}) {
  const config = useStore((s) => s.config);
  const mcpStatus = useStore((s) => s.mcpStatus);
  const saveConfig = useStore((s) => s.saveConfig);
  const mcpConnect = useStore((s) => s.mcpConnect);
  const mcpDisconnect = useStore((s) => s.mcpDisconnect);
  const refreshMcp = useStore((s) => s.refreshMcp);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');
  const [editingEnv, setEditingEnv] = useState<string | null>(null);
  const [envDraft, setEnvDraft] = useState('');
  // In-app OAuth sign-in ("Sign in with GitHub"): one flow at a time, shown as a
  // banner with the device code while we poll in the background.
  const [oauth, setOauth] = useState<{
    serverName: string;
    userCode?: string;
    verificationUri?: string;
    busy?: boolean;
    error?: string;
  } | null>(null);

  useEffect(() => {
    return window.vo.onMcpOauth((ev: McpOauthEvent) => {
      if (ev.state === 'connected') {
        setOauth((cur) => (cur?.serverName === ev.serverName ? null : cur));
        void refreshMcp();
      } else if (ev.state === 'error') {
        setOauth((cur) =>
          cur?.serverName === ev.serverName ? { ...cur, busy: false, error: ev.message } : cur,
        );
      } else if (ev.state === 'signed_out') {
        setOauth((cur) => (cur?.serverName === ev.serverName ? null : cur));
        void refreshMcp();
      }
    });
  }, [refreshMcp]);

  if (!config) return null;

  // env is entered as KEY=VALUE lines (like a .env file) and parsed to a record;
  // the launcher passes it to the MCP server process (client-manager's env).
  const parseEnv = (text: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    return out;
  };
  const envToText = (e?: Record<string, string>): string =>
    Object.entries(e ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

  const add = async () => {
    const parsed = parseEnv(env);
    const cmd = command.trim();
    // A URL means a REMOTE (Streamable HTTP) server — e.g. GitHub's hosted MCP.
    // Its KEY=VALUE lines are request headers (Authorization=Bearer <token>).
    const remote = /^https?:\/\//i.test(cmd);
    const cfg = remote
      ? {
          name: name.trim(),
          url: cmd,
          ...(Object.keys(parsed).length ? { headers: parsed } : {}),
        }
      : {
          name: name.trim(),
          command: cmd,
          args: args.trim() ? args.trim().split(/\s+/) : [],
          ...(Object.keys(parsed).length ? { env: parsed } : {}),
        };
    await saveConfig({ mcpServers: [...config.mcpServers, cfg] });
    setName('');
    setCommand('');
    setArgs('');
    setEnv('');
    await mcpConnect(cfg.name);
  };

  const saveEnv = async (serverName: string) => {
    const parsed = parseEnv(envDraft);
    const has = Object.keys(parsed).length > 0;
    await saveConfig({
      mcpServers: config.mcpServers.map((s) =>
        s.name !== serverName
          ? s
          : s.url
            ? { ...s, headers: has ? parsed : undefined } // remote → HTTP headers
            : { ...s, env: has ? parsed : undefined }, // local → process env
      ),
    });
    setEditingEnv(null);
    // Reconnect so the server picks up the new environment / headers.
    await mcpDisconnect(serverName).catch(() => {});
    await mcpConnect(serverName);
  };

  const remove = async (serverName: string) => {
    await mcpDisconnect(serverName).catch(() => {});
    await saveConfig({
      mcpServers: config.mcpServers.filter((s) => s.name !== serverName),
    });
    await refreshMcp();
  };

  const signIn = async (serverName: string) => {
    setOauth({ serverName, busy: true });
    const res = await window.vo.mcpOauthBegin(serverName);
    if (!res.ok) {
      setOauth({ serverName, error: res.error ?? 'Could not start sign-in.' });
      return;
    }
    setOauth({ serverName, userCode: res.userCode, verificationUri: res.verificationUri, busy: true });
  };

  // One-click GitHub: add the official hosted server if it isn't there yet, then
  // start the sign-in. No token to paste — this is the whole point of the OAuth app.
  const connectGithub = async () => {
    const existing = config.mcpServers.find((s) => mcpOauthLabelForUrl(s.url) === 'GitHub');
    let serverName = existing?.name;
    if (!serverName) {
      const taken = new Set(config.mcpServers.map((s) => s.name));
      serverName = 'github';
      for (let i = 2; taken.has(serverName); i++) serverName = `github-${i}`;
      await window.vo.mcpAdd({ name: serverName, url: 'https://api.githubcopilot.com/mcp/' });
      await saveConfig({});
    }
    await signIn(serverName);
  };

  const githubConnected = config.mcpServers.some(
    (s) =>
      mcpOauthLabelForUrl(s.url) === 'GitHub' &&
      !!mcpStatus.find((st) => st.name === s.name)?.connected,
  );

  return (
    <section>
      {!embedded && (
        <>
          <h2>MCP servers</h2>
          <p className="hint">
            Tools for your agents — search below and add with one click; the harness runs and
            connects them for you. Advanced: add any server manually by command.
          </p>
        </>
      )}
      <McpFinder />
      <div className="mcp-server">
        <div className="field-row">
          <span className={`status-dot ${githubConnected ? 'on' : 'off'}`} />
          <label>GitHub</label>
          <span className="meta grow">
            Repos, issues &amp; pull requests — sign in with your GitHub account, no token to paste.
          </span>
          {githubConnected ? (
            <span className="hint">✓ Signed in</span>
          ) : (
            <button disabled={!!oauth?.busy} onClick={() => void connectGithub()}>
              {oauth?.busy ? 'Signing in…' : 'Sign in with GitHub'}
            </button>
          )}
        </div>
      </div>
      {oauth && (
        <div className="mcp-server">
          {oauth.error ? (
            <span className="hint error-text">{oauth.error}</span>
          ) : oauth.userCode ? (
            <p className="hint">
              {oauth.verificationUri ? 'GitHub opened in your browser' : 'Opening GitHub…'} — enter
              this code and approve, then it connects itself:{' '}
              <code className="perm-tool">{oauth.userCode}</code>{' '}
              <button
                className="ghost"
                onClick={() => void navigator.clipboard?.writeText(oauth.userCode ?? '')}
              >
                Copy
              </button>{' '}
              <span className="meta">waiting for approval…</span>
            </p>
          ) : (
            <span className="hint">Starting sign-in…</span>
          )}
        </div>
      )}
      {config.mcpServers.map((s) => {
        const status = mcpStatus.find((st) => st.name === s.name);
        const remote = !!s.url;
        const oauthLabel = mcpOauthLabelForUrl(s.url);
        const varCount = Object.keys((remote ? s.headers : s.env) ?? {}).length;
        return (
          <div key={s.name} className="mcp-server">
            <div className="field-row">
              <span className={`status-dot ${status?.connected ? 'on' : 'off'}`} />
              <label>{s.name}</label>
              <span className="meta grow">
                {s.url ?? s.command} {s.args?.join(' ')}
                {varCount ? ` · ${varCount} ${remote ? 'headers' : 'env'}` : ''}
                {status?.connected ? ` — ${status.toolCount} tools` : ''}
                {status?.error ? ` — ${status.error}` : ''}
              </span>
              <button
                className={`ghost${editingEnv === s.name ? ' thinking-on' : ''}`}
                title={
                  remote
                    ? 'Set request headers (e.g. Authorization: Bearer <token>)'
                    : 'Set environment variables the server needs (API keys, client id/secret)'
                }
                onClick={() => {
                  setEditingEnv(editingEnv === s.name ? null : s.name);
                  setEnvDraft(envToText(remote ? s.headers : s.env));
                }}
              >
                {remote ? 'Headers' : 'Env'}
              </button>
              {status?.connected ? (
                <button className="ghost" onClick={() => void mcpDisconnect(s.name)}>
                  Disconnect
                </button>
              ) : oauthLabel ? (
                <button
                  disabled={oauth?.serverName === s.name && oauth?.busy}
                  onClick={() => void signIn(s.name)}
                >
                  {oauth?.serverName === s.name && oauth?.busy
                    ? 'Signing in…'
                    : `Sign in with ${oauthLabel}`}
                </button>
              ) : (
                <button onClick={() => void mcpConnect(s.name)}>Connect</button>
              )}
              <button className="ghost" onClick={() => void remove(s.name)}>
                Remove
              </button>
            </div>
            {editingEnv === s.name && (
              <div className="mcp-env-edit">
                <textarea
                  rows={3}
                  placeholder={
                    remote
                      ? 'Header=value per line — e.g. Authorization=Bearer ghp_xxxxx'
                      : 'KEY=VALUE per line — e.g. REDDIT_CLIENT_ID=xxxxx'
                  }
                  value={envDraft}
                  onChange={(e) => setEnvDraft(e.target.value)}
                />
                <div className="field-row">
                  <span className="meta grow">
                    Stored in your local config; the server reconnects on save.
                  </span>
                  <button className="ghost" onClick={() => setEditingEnv(null)}>
                    Cancel
                  </button>
                  <button onClick={() => void saveEnv(s.name)}>
                    Save {remote ? 'headers' : 'env'}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      <div className="field-row">
        <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          placeholder="command — or a remote URL (https://…)"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
        />
        <input
          className="grow"
          placeholder="args (local command only)"
          value={args}
          onChange={(e) => setArgs(e.target.value)}
        />
        <button disabled={!name.trim() || !command.trim()} onClick={() => void add()}>
          Add
        </button>
      </div>
      <textarea
        className="mcp-env-add"
        rows={2}
        placeholder="env / headers (optional) — KEY=VALUE per line. Local: REDDIT_CLIENT_ID=… · Remote: Authorization=Bearer <token>"
        value={env}
        onChange={(e) => setEnv(e.target.value)}
      />
      <p className="hint">
        Remote (HTTP) servers work too — paste the server URL in the command box. Browse hundreds at{' '}
        <a href="https://mcpservers.org/" target="_blank" rel="noreferrer">
          mcpservers.org
        </a>
        . GitHub&apos;s hosted server is <code>https://api.githubcopilot.com/mcp/</code> with an{' '}
        <code>Authorization=Bearer &lt;PAT&gt;</code> header.
      </p>
    </section>
  );
}

/**
 * The Connections tile: a launcher grid of pressable icons — one per outside
 * account or tool an agent can use. Nothing is expanded by default; pressing a
 * tile opens just that connection's controls in the drawer below. Two honest
 * kinds, shown by a corner tag: Vo-Coder built-in (Gmail, Telegram) and MCP.
 */
interface ConnTile {
  id: string;
  name: string;
  icon: IconName;
  tag: string;
  on: boolean;
  sub: string;
  detail: ReactNode;
}

function ConnectionsSection() {
  const config = useStore((s) => s.config);
  const mcpStatus = useStore((s) => s.mcpStatus);
  const [open, setOpen] = useState<string | null>(null);
  const [gmail, setGmail] = useState<{ connected: boolean; email?: string }>({ connected: false });
  const [tg, setTg] = useState<TelegramInfo | null>(null);

  useEffect(() => {
    void window.vo.googleOauthStatus().then(setGmail);
    return window.vo.onGoogleOauth((ev) => {
      if (ev.state === 'connected') setGmail({ connected: true, email: ev.email });
      else if (ev.state === 'signed_out') setGmail({ connected: false });
    });
  }, []);
  useEffect(() => {
    void window.vo.telegramInfo().then(setTg);
    return window.vo.onTelegramChanged(setTg);
  }, []);

  if (!config) return null;
  const mcpCount = mcpStatus.filter((s) => s.connected).length;
  const tgOn = !!tg?.polling || (tg?.paired?.length ?? 0) > 0;

  const tiles: ConnTile[] = [
    {
      id: 'gmail',
      name: 'Gmail',
      icon: 'mail',
      tag: 'Built-in',
      on: gmail.connected,
      sub: gmail.connected ? (gmail.email ?? 'connected') : 'connect',
      detail: <GmailSection embedded />,
    },
    {
      id: 'telegram',
      name: 'Telegram',
      icon: 'send',
      tag: 'Built-in',
      on: tgOn,
      sub: tg?.polling ? 'connected' : (config.telegramPaired?.length ? 'paired' : 'connect'),
      detail: <TelegramSection embedded />,
    },
    {
      id: 'mcp',
      name: 'MCP servers',
      icon: 'plug',
      tag: 'MCP',
      on: mcpCount > 0,
      sub: mcpCount > 0 ? `${mcpCount} connected` : 'add tools',
      detail: <McpSection embedded />,
    },
  ];
  const active = tiles.find((t) => t.id === open);

  return (
    <section className="connections">
      <h2>Connections</h2>
      <p className="hint">
        Accounts and tools your agents can use. Press one to connect it or manage it.
      </p>
      <div className="conn-grid">
        {tiles.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`conn-tile${open === t.id ? ' active' : ''}${t.on ? ' on' : ''}`}
            onClick={() => setOpen(open === t.id ? null : t.id)}
          >
            <span className="conn-tile-tag">{t.tag}</span>
            <span className="conn-tile-icon">
              <Icon name={t.icon} size={24} />
            </span>
            <span className="conn-tile-name">{t.name}</span>
            <span className="conn-tile-sub">
              {t.on && <span className="conn-dot" />}
              {t.sub}
            </span>
          </button>
        ))}
      </div>
      {active && (
        <div className="conn-detail">
          <div className="conn-detail-head">
            <span className="conn-icon">
              <Icon name={active.icon} size={18} />
            </span>
            <strong>{active.name}</strong>
            <button
              type="button"
              className="ghost conn-detail-close"
              aria-label="Close"
              onClick={() => setOpen(null)}
            >
              ×
            </button>
          </div>
          {active.detail}
        </div>
      )}
    </section>
  );
}

function GmailSection({ embedded }: { embedded?: boolean } = {}) {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const saveSecret = useStore((s) => s.saveSecret);
  const secretStatus = useStore((s) => s.secretStatus);
  const [clientId, setClientId] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const [status, setStatus] = useState<{ connected: boolean; email?: string }>({ connected: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.vo.googleOauthStatus().then(setStatus);
    return window.vo.onGoogleOauth((ev) => {
      if (ev.state === 'connected') {
        setStatus({ connected: true, email: ev.email });
        setBusy(false);
        setError(null);
      } else if (ev.state === 'signed_out') {
        setStatus({ connected: false });
        setBusy(false);
        if (ev.message) setError(ev.message);
      } else if (ev.state === 'error') {
        setBusy(false);
        setError(ev.message ?? 'Sign-in failed.');
      }
    });
  }, []);

  if (!config) return null;
  const effClientId = clientId ?? config.googleOauthClientId ?? '';
  const secretSaved = !!secretStatus['google-oauth-secret'];

  const connect = async () => {
    setBusy(true);
    setError(null);
    if (clientId !== null) await saveConfig({ googleOauthClientId: clientId.trim() });
    if (secret.trim()) {
      await saveSecret('google-oauth-secret', secret.trim());
      setSecret('');
    }
    const res = await window.vo.googleOauthBegin();
    if (!res.ok) {
      setBusy(false);
      setError(res.error ?? 'Could not start sign-in.');
    }
    // On success the browser opens; the 'connected' event flips status.
  };

  const body = (
    <>
      <p className="hint">
        Sign in with your Google account and every agent gets real Gmail tools — search, read, send.
        It runs in the background; connect once.
      </p>
      {status.connected ? (
        <div className="field-row">
          <span className="status-dot on" />
          <span className="hint grow">
            ✓ Connected{status.email ? ` as ${status.email}` : ''} — agents have gmail_search,
            gmail_read, gmail_send.
          </span>
          <button className="ghost" onClick={() => void window.vo.googleOauthSignOut()}>
            Sign out
          </button>
        </div>
      ) : (
        <>
          <div className="field-row">
            <label>Client ID</label>
            <input
              className="grow"
              placeholder="…apps.googleusercontent.com"
              value={effClientId}
              onChange={(e) => setClientId(e.target.value)}
            />
          </div>
          <div className="field-row">
            <label>Client secret</label>
            <input
              className="grow"
              type="password"
              placeholder={secretSaved ? 'saved — paste to replace' : 'GOCSPX-…'}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </div>
          <div className="field-row">
            <span className="hint grow">
              {error ? (
                <span className="error-text">{error}</span>
              ) : (
                'Opens Google in your browser to approve.'
              )}
            </span>
            <button
              disabled={busy || !effClientId.trim() || !(secret.trim() || secretSaved)}
              onClick={() => void connect()}
            >
              {busy ? 'Connecting…' : 'Connect Gmail'}
            </button>
          </div>
        </>
      )}
      <details className="hint">
        <summary>Where do the Client ID and secret come from?</summary>
        <p>
          They&apos;re your own Google OAuth <strong>Desktop</strong> client (bring-your-own, so
          there&apos;s no shared app to verify). In Google Cloud: create a project, enable the Gmail
          API, add yourself (and anyone else) as a <em>test user</em>, then make a Desktop OAuth
          client and paste its ID + secret here. First sign-in shows an &quot;unverified app&quot;
          screen — click Advanced → continue; it&apos;s your own app. While unverified, Google
          expires the login about weekly, so you&apos;ll reconnect now and then.
        </p>
      </details>
    </>
  );
  return embedded ? (
    body
  ) : (
    <section>
      <h2>Gmail</h2>
      {body}
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
const IMAGE_PROVIDER_LABELS: Record<string, string> = {
  custom: 'custom (OpenAI-image API)',
  a1111: 'local (A1111 / Forge / SD.Next)',
  fal: 'fal.ai (aggregator)',
  replicate: 'Replicate (aggregator)',
};

function ImageModelSection() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const saveSecret = useStore((s) => s.saveSecret);
  const secretStatus = useStore((s) => s.secretStatus);
  const [provider, setProvider] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');

  if (!config) return null;
  const IMAGE_PROVIDERS = ['xai', 'gemini', 'openrouter', 'openai', 'custom', 'a1111', 'fal', 'replicate'] as const;
  const effProvider = provider ?? config.imageModel?.provider ?? 'xai';
  const effModel = model ?? config.imageModel?.model ?? '';
  const isCustom = effProvider === 'custom';
  const isLocal = effProvider === 'a1111';
  const isAgg = effProvider === 'fal' || effProvider === 'replicate';
  const hasBase = isCustom || isLocal;
  const needsKey = isCustom || isAgg;
  const freeModel = hasBase || isAgg;
  const keyName = isCustom ? 'image-custom' : effProvider;
  const effBase = baseUrl ?? config.imageModel?.baseUrl ?? (isLocal ? 'http://127.0.0.1:7860' : '');
  const keySaved = !!secretStatus[keyName];
  const shouldSave = isLocal ? !!effBase : isCustom ? !!effBase && !!effModel : !!effModel;

  const save = async () => {
    if (needsKey && keyInput.trim()) {
      await saveSecret(keyName, keyInput.trim());
      setKeyInput('');
    }
    await saveConfig({
      imageModel: shouldSave
        ? { provider: effProvider, model: effModel, ...(hasBase && effBase ? { baseUrl: effBase } : {}) }
        : null,
    });
  };

  const modelPlaceholder = isLocal
    ? 'model / checkpoint (optional)'
    : effProvider === 'fal'
      ? 'fal model, e.g. fal-ai/flux/schnell'
      : effProvider === 'replicate'
        ? 'replicate model, e.g. black-forest-labs/flux-schnell'
        : 'model id (e.g. black-forest-labs/FLUX.1-schnell)';

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
          <code>google/gemini-3-pro-image-preview</code> (Pro; best detail, best at readable
          lettering) or <code>google/gemini-3.1-flash-image</code> (nearly as good, cheaper).{' '}
          <strong>gpt-image-1</strong> is the closest alternative; <strong>Flux</strong> suits
          painterly ornament; <strong>Grok Imagine</strong> is free with a Grok subscription. Bring
          your own host with <strong>custom</strong> (any OpenAI-images endpoint),{' '}
          <strong>local</strong> (your own Stable Diffusion), or the <strong>fal.ai</strong> /{' '}
          <strong>Replicate</strong> aggregators (FLUX, SDXL and hundreds more, by model id).
        </p>
      </details>
      <div className="field-row">
        <label>provider</label>
        <select
          value={effProvider}
          onChange={(e) => {
            setProvider(e.target.value);
            setModel('');
            setBaseUrl(null);
          }}
        >
          {IMAGE_PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {IMAGE_PROVIDER_LABELS[p] ?? p}
            </option>
          ))}
        </select>
        {freeModel ? (
          <input
            className="grow"
            placeholder={modelPlaceholder}
            value={effModel}
            onChange={(e) => setModel(e.target.value)}
          />
        ) : (
          <ModelPicker
            provider={effProvider}
            value={effModel}
            onChange={setModel}
            placeholder="pick an image model"
            filter="image"
          />
        )}
        <button disabled={!shouldSave} onClick={() => void save()}>
          Save
        </button>
      </div>
      {hasBase && (
        <div className="field-row">
          <label>{isLocal ? 'server URL' : 'base URL'}</label>
          <input
            className="grow"
            placeholder={isLocal ? 'http://127.0.0.1:7860' : 'https://api.together.ai/v1'}
            value={effBase}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>
      )}
      {needsKey && (
        <div className="field-row">
          <label>API key</label>
          <input
            className="grow"
            type="password"
            placeholder={keySaved ? 'saved — paste to replace' : `${effProvider} API key`}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
          />
        </div>
      )}
      {(hasBase || isAgg) && (
        <p className="hint">
          {isLocal
            ? 'Point at a local Stable Diffusion server started with --api (AUTOMATIC1111, Forge or SD.Next) — no key needed.'
            : isCustom
              ? 'Any OpenAI-images-compatible endpoint (Together AI, DeepInfra, LocalAI, an OpenAI proxy). Base URL is the …/v1 root.'
              : 'Paste a model id from the provider — they host hundreds (FLUX, SDXL, Ideogram, Recraft…). Your key is on their dashboard.'}
        </p>
      )}
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
  veo: [
    { id: 'veo-3.1-generate-preview', note: 'Veo 3.1 — newest; runs on your Gemini key' },
    { id: 'veo-3.0-generate-001', note: 'Veo 3 — stable; runs on your Gemini key' },
  ],
  fal: [],
  replicate: [],
  openai: [
    { id: 'sora-2', note: 'Sora 2 — fast, for iterating (API ends 24 Sep 2026)' },
    { id: 'sora-2-pro', note: 'Sora 2 Pro — higher fidelity (API ends 24 Sep 2026)' },
  ],
};
const VIDEO_PROVIDER_LABELS: Record<string, string> = {
  veo: 'Google Veo (Gemini key)',
  fal: 'fal.ai (aggregator)',
  replicate: 'Replicate (aggregator)',
  openai: 'OpenAI Sora (ends Sep 2026)',
};

function VideoModelSection() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const saveSecret = useStore((s) => s.saveSecret);
  const secretStatus = useStore((s) => s.secretStatus);
  const [provider, setProvider] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');

  if (!config) return null;
  const effProvider = provider ?? config.videoModel?.provider ?? 'xai';
  const known = VIDEO_MODELS[effProvider] ?? [];
  const isAgg = effProvider === 'fal' || effProvider === 'replicate';
  const effModel = model ?? config.videoModel?.model ?? known[0]?.id ?? '';
  const keySaved = !!secretStatus[effProvider];
  const dirty =
    effProvider !== (config.videoModel?.provider ?? '') || effModel !== (config.videoModel?.model ?? '');
  const canSave = !!effModel && (dirty || (isAgg && !!keyInput.trim()));

  const save = async () => {
    if (isAgg && keyInput.trim()) {
      await saveSecret(effProvider, keyInput.trim());
      setKeyInput('');
    }
    await saveConfig({
      videoModel: effModel ? { provider: effProvider, model: effModel } : null,
    });
  };

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
          <strong>Grok Imagine</strong> is cheap and free with a Grok subscription.{' '}
          <strong>Veo 3</strong> runs on your existing Gemini key — no extra signup. The{' '}
          <strong>fal.ai</strong> and <strong>Replicate</strong> aggregators reach Kling, Luma,
          Hunyuan, Wan, Pika and more by model id. <strong>Sora 2</strong> needs an OpenAI key and
          its API shuts down <strong>24 September 2026</strong> — treat it as end-of-life.
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
              {VIDEO_PROVIDER_LABELS[p] ?? p}
            </option>
          ))}
        </select>
        {isAgg ? (
          <input
            className="grow"
            placeholder={
              effProvider === 'fal'
                ? 'fal model, e.g. fal-ai/kling-video/v2/master/text-to-video'
                : 'replicate model, e.g. kwaivgi/kling-v2.1'
            }
            value={effModel}
            onChange={(e) => setModel(e.target.value)}
          />
        ) : (
          <select className="grow" value={effModel} onChange={(e) => setModel(e.target.value)}>
            {known.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
            {!known.some((m) => m.id === effModel) && effModel && (
              <option value={effModel}>{effModel}</option>
            )}
          </select>
        )}
        <button disabled={!canSave} onClick={() => void save()}>
          Save
        </button>
        {config.videoModel && (
          <button className="ghost" onClick={() => void saveConfig({ videoModel: null })}>
            Off
          </button>
        )}
      </div>
      {isAgg && (
        <div className="field-row">
          <label>API key</label>
          <input
            className="grow"
            type="password"
            placeholder={keySaved ? 'saved — paste to replace' : `${effProvider} API key`}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
          />
        </div>
      )}
      <p className="hint">
        {isAgg
          ? 'Paste a text-to-video model id from the provider; your key is on their dashboard.'
          : effProvider === 'veo'
            ? 'Veo uses your Gemini key (Settings → API keys) — no extra signup.'
            : (known.find((m) => m.id === effModel)?.note ??
              (config.videoModel ? '' : 'Off — video_generate will tell the agent to come here first.'))}
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
function TelegramSection({ embedded }: { embedded?: boolean } = {}) {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const [info, setInfo] = useState<TelegramInfo | null>(null);
  const [pairCode, setPairCode] = useState<string | null>(null);

  useEffect(() => {
    void window.vo.telegramInfo().then(setInfo);
    return window.vo.onTelegramChanged(setInfo);
  }, []);

  if (!config) return null;

  const body = (
    <>
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
    </>
  );
  return embedded ? (
    body
  ) : (
    <section>
      <h2>Telegram remote</h2>
      {body}
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

/**
 * One Settings card. Collapsed it is a uniform tile in the grid — name + a
 * one-line live status — so the whole page fits on a screen with nothing to
 * scroll. Clicking it opens the section's full editor in a centered panel over
 * the grid (the tall ones — Voice, Local servers, Vodo — scroll inside the
 * panel, never the page). The section JSX is passed as children and only
 * mounts while open. Esc / click-away close (handled by the parent).
 */
function SettingsTile({
  id,
  name,
  description,
  summary,
  openTile,
  setOpenTile,
  children,
}: {
  id: string;
  name: string;
  description: string;
  summary?: string;
  openTile: string | null;
  setOpenTile: (id: string | null) => void;
  children: ReactNode;
}) {
  const open = openTile === id;
  return (
    <>
      <button
        type="button"
        className={`settings-tile${open ? ' active' : ''}`}
        onClick={() => setOpenTile(id)}
      >
        <span className="settings-tile-head">
          {tileIcon(id) && (
            <span className="settings-tile-icon">
              <img src={tileIcon(id)} alt="" draggable={false} />
            </span>
          )}
          <span className="settings-tile-name">{name}</span>
        </span>
        <span className="settings-tile-desc">{description}</span>
        {summary ? <span className="settings-tile-summary">{summary}</span> : null}
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpenTile(null)}>
          <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="settings-panel-close"
              aria-label="Close"
              onClick={() => setOpenTile(null)}
            >
              ×
            </button>
            <div className="settings-panel-body">{children}</div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Auto agents — the hands Vodo hires when a group needs more people than the
 * user has built. He picks the NAME (pioneer pool) and writes the ROLE into the
 * task; everything else about a hire is set here, once.
 */
function AutoAgentsSection() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const saveAgents = useStore((s) => s.saveAgents);
  const [prompt, setPrompt] = useState<string | null>(null);

  if (!config) return null;
  const d = config.autoAgents;
  const hires = config.agents.filter((a) => a.auto);
  const effPrompt = prompt ?? d.systemPrompt;
  const patch = (p: Partial<typeof d>) => void saveConfig({ autoAgents: { ...d, ...p } });

  return (
    <section>
      <h2>Auto agents</h2>
      <p className="hint">
        When a group needs more hands than you have agents, Vodo hires one instead of stopping.
        Each hire is named after a computing pioneer, built from the defaults below, and told its
        role in the task he writes — so he never runs out of people.
      </p>

      <div className="field-row">
        <label>limit</label>
        <input
          type="number"
          min={0}
          max={AUTO_AGENT_MAX_CAP}
          value={d.max}
          onChange={(e) => patch({ max: Math.max(0, Math.min(AUTO_AGENT_MAX_CAP, Number(e.target.value) || 0)) })}
        />
        <span className="hint grow">
          most hires that may exist at once (0 turns hiring off, max {AUTO_AGENT_MAX_CAP}) —{' '}
          {hires.length} hired now
        </span>
        {hires.length > 0 && (
          <button
            className="ghost"
            title="Delete every hired agent (their chats stay)"
            onClick={() => void saveAgents(config.agents.filter((a) => !a.auto))}
          >
            Release all
          </button>
        )}
      </div>

      <div className="field-row">
        <label>model</label>
        <select
          value={d.provider}
          onChange={(e) => patch({ provider: e.target.value, model: '' })}
        >
          <option value="">(let Vodo route)</option>
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        {d.provider ? (
          <ModelPicker
            provider={d.provider}
            value={d.model}
            onChange={(m) => patch({ model: m })}
            placeholder="pick a model for hires"
          />
        ) : (
          <span className="hint grow">
            no fixed model — each hire is routed like any agent without one
          </span>
        )}
      </div>

      <div className="field-row">
        <label>master prompt</label>
        <span className="hint grow">who a hire is before it gets its role</span>
        <button
          className="ghost"
          onClick={() => {
            setPrompt(DEFAULT_AUTO_AGENT_PROMPT);
            patch({ systemPrompt: DEFAULT_AUTO_AGENT_PROMPT });
          }}
        >
          Reset to default
        </button>
        <button
          disabled={prompt === null || prompt === d.systemPrompt}
          onClick={() => patch({ systemPrompt: effPrompt })}
        >
          Save
        </button>
      </div>
      <textarea
        className="system-prompt"
        rows={6}
        value={effPrompt}
        onChange={(e) => setPrompt(e.target.value)}
      />

      <div className="field-row">
        <label>memory</label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={d.memory}
            onChange={(e) => patch({ memory: e.target.checked })}
          />
          give hires the project memory (off = they work from the brief they are given)
        </label>
      </div>

      <div className="field-row">
        <label>tools · mcp</label>
        <span className="hint grow">which MCP servers a hire may drive</span>
      </div>
      {config.mcpServers.length === 0 ? (
        <p className="hint">
          No MCP servers yet — add some under <strong>Connections</strong>. Hires always have the
          built-in web and workspace (ws_*) tools.
        </p>
      ) : (
        <div className="homelab-tools">
          {config.mcpServers.map((s) => (
            <label key={s.name} className="checkbox">
              <input
                type="checkbox"
                checked={d.mcpServers.includes(s.name)}
                onChange={(e) =>
                  patch({
                    mcpServers: e.target.checked
                      ? [...d.mcpServers, s.name]
                      : d.mcpServers.filter((n) => n !== s.name),
                  })
                }
              />
              {s.name} <span className="meta">{s.url ?? s.command}</span>
            </label>
          ))}
        </div>
      )}
      {hires.length > 0 && (
        <p className="hint">
          Hired so far: {hires.map((a) => a.name).join(', ')}. They are ordinary agents — edit or
          delete any of them in the Agents tab.
        </p>
      )}
    </section>
  );
}

/**
 * Mr Homelab's settings. He is hidden from the Agents list (he owns his own
 * tab and stays out of routing), so this tile IS his editor: enable the tab,
 * edit his master prompt, and pick which MCP servers he may drive. Edits upsert
 * the real `homelab` agent, creating it on first change if it doesn't exist yet.
 */
function HomelabSection() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const saveAgents = useStore((s) => s.saveAgents);
  const [prompt, setPrompt] = useState<string | null>(null);

  if (!config) return null;
  const agent = config.agents.find((a) => a.id === HOMELAB_AGENT_ID);
  const savedPrompt = agent?.systemPrompt ?? HOMELAB_SYSTEM_PROMPT;
  const effPrompt = prompt ?? savedPrompt;
  const effMcp = new Set(agent?.mcpServers ?? ['infra']);
  const memoryOn = agent?.memory !== false;

  const patchHomelab = async (patch: Partial<AgentSpec>) => {
    const exists = config.agents.some((a) => a.id === HOMELAB_AGENT_ID);
    const agents = exists
      ? config.agents.map((a) => (a.id === HOMELAB_AGENT_ID ? { ...a, ...patch } : a))
      : [...config.agents, homelabAgentSpec(patch)];
    await saveAgents(agents);
  };

  return (
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
        A dedicated infrastructure agent with his own chat and his own model picker in that tab. He
        stays out of ordinary auto-routing, but Vodo can seat him on a group project&apos;s
        infrastructure part.
      </p>

      <div className="field-row">
        <label>master prompt</label>
        <span className="hint grow">what he is and how he works — his system prompt</span>
        <button
          className="ghost"
          onClick={() => {
            setPrompt(HOMELAB_SYSTEM_PROMPT);
            void patchHomelab({ systemPrompt: HOMELAB_SYSTEM_PROMPT });
          }}
        >
          Reset to default
        </button>
        <button
          disabled={prompt === null || prompt === savedPrompt}
          onClick={() => void patchHomelab({ systemPrompt: effPrompt })}
        >
          Save
        </button>
      </div>
      <textarea
        className="system-prompt"
        rows={8}
        value={effPrompt}
        onChange={(e) => setPrompt(e.target.value)}
      />

      <div className="field-row">
        <label>tools · mcp</label>
        <span className="hint grow">which MCP servers he may drive</span>
      </div>
      {config.mcpServers.length === 0 ? (
        <p className="hint">
          No MCP servers yet — add some under <strong>Connections → MCP</strong>. The bundled{' '}
          <strong>infra</strong> server covers Proxmox.
        </p>
      ) : (
        <div className="homelab-tools">
          {config.mcpServers.map((s) => (
            <label key={s.name} className="checkbox">
              <input
                type="checkbox"
                checked={effMcp.has(s.name)}
                onChange={(e) => {
                  const next = new Set(effMcp);
                  if (e.target.checked) next.add(s.name);
                  else next.delete(s.name);
                  void patchHomelab({ mcpServers: [...next] });
                }}
              />
              {s.name} <span className="meta">{s.url ?? s.command}</span>
            </label>
          ))}
        </div>
      )}
      <p className="hint">He also has the built-in web and workspace (ws_*) tools everywhere.</p>

      <div className="field-row">
        <label>memory</label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={memoryOn}
            onChange={(e) => void patchHomelab({ memory: e.target.checked })}
          />
          remember the estate between his chats (recommended)
        </label>
      </div>

      <details className="hint-more">
        <summary>what he covers</summary>
        <p className="hint">
          Hypervisors and VMs, containers, NAS and storage, networking, DNS and proxies, backups,
          monitoring, the GPUs your local models run on.
        </p>
      </details>
    </section>
  );
}

export function Settings() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const secretStatus = useStore((s) => s.secretStatus);
  const mcpStatus = useStore((s) => s.mcpStatus);
  const [ollamaUrl, setOllamaUrl] = useState<string | null>(null);
  const [lmstudioUrl, setLmstudioUrl] = useState<string | null>(null);
  const [flmUrl, setFlmUrl] = useState<string | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [openTile, setOpenTile] = useState<string | null>(null);
  const [version, setVersion] = useState('');
  useEffect(() => {
    void window.vo.appVersion().then(setVersion);
  }, []);
  const [gmail, setGmail] = useState<{ connected: boolean; email?: string }>({ connected: false });
  useEffect(() => {
    void window.vo.googleOauthStatus().then(setGmail);
    return window.vo.onGoogleOauth((ev) => {
      if (ev.state === 'connected') setGmail({ connected: true, email: ev.email });
      else if (ev.state === 'signed_out') setGmail({ connected: false });
    });
  }, []);
  // Esc closes the open panel — the modal convention everywhere else in the app.
  useEffect(() => {
    if (!openTile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenTile(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openTile]);

  /**
   * Settings stays usable when the config does not arrive.
   *
   * Everything here reads the backend’s config — except the Remote panel,
   * which is deliberately answered by THIS machine. That matters most in the
   * one case that used to be unrecoverable: a front end pointed at a backend
   * that is off, or gone, or was switched to local. The config never arrives,
   * every panel folds, and the only control that could fix it folded with
   * them — leaving editing config.json by hand as the only way out.
   *
   * So when there is no config, show the one panel that does not need it.
   */
  if (!config) {
    return (
      <div className="settings">
        <p className="hint">
          Waiting for the main computer. If it is off, or this window should not be a remote
          at all, switch it back below — that setting belongs to this computer and works
          whether or not anything answers.
        </p>
        <RemoteSection />
      </div>
    );
  }

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

  // One-line status per card, shown on the collapsed tile.
  const has = (p: string): boolean => !!secretStatus[p];
  const keyCount = ['anthropic', 'openai', 'openrouter', 'xai', 'zai', 'gemini', 'nvidia'].filter(
    has,
  ).length;
  const mcpConnected = mcpStatus.filter((s) => s.connected).length;
  const localOn = (['ollama', 'lmstudio', 'flm', 'llamacpp'] as const).filter(
    (p) => !(config.disabledProviders ?? []).includes(p),
  ).length;
  const modelOf = (m?: { model?: string } | null): string | null => m?.model ?? null;
  const voiceSummary =
    config.voice.tts === 'none'
      ? `${config.voice.stt} · no voice`
      : `${config.voice.stt} · ${config.voice.tts}`;
  const spendingSummary = config.spending.enabled
    ? `on · $${config.spending.perTransactionMax}/$${config.spending.dailyMax}`
    : 'off';
  const genericSummary =
    (config.genericDir || '').split(/[\\/]/).filter(Boolean).pop() ?? 'default';
  const builtinOn =
    (gmail.connected ? 1 : 0) + ((config.telegramPaired?.length ?? 0) > 0 ? 1 : 0);
  const connectionsSummary = `${builtinOn} built-in · ${mcpConnected} MCP`;
  const autoAgentSummary = config.autoAgents.max
    ? `${config.agents.filter((a) => a.auto).length} of ${config.autoAgents.max} hired`
    : 'hiring off';

  return (
    <div className="settings settings-full">
      <h1>Settings</h1>
      <div className="settings-grid">
      <SettingsTile id="keys" name="API keys" description="Cloud provider keys, in your OS keychain" summary={`${keyCount} configured`} openTile={openTile} setOpenTile={setOpenTile}>
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
        <KeyRow provider="gemini" placeholder="paste Google AI Studio API key" />
        <details className="hint-more">
          <summary>gemini: a free key from your Google account</summary>
          <p className="hint">
            Get a key at <code>aistudio.google.com/apikey</code> — sign in with your Google
            account and it&apos;s free (the free tier needs no card and no billing). Paste it here
            and Gemini works in agents like any other provider: it can be Vodo, coordinate
            groups, run missions. It shows as free, since the free tier bills nothing. (Note:
            this is the API key, not the retired &quot;sign in with Google&quot; CLI login.)
          </p>
        </details>
        <ClaudeCodeRow />
      </section>
      </SettingsTile>

      <SettingsTile id="local" name="Local model servers" description="Ollama, LM Studio, llama.cpp, NPU — one row per box" summary={`${localOn} on`} openTile={openTile} setOpenTile={setOpenTile}>
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
      </SettingsTile>

      <SettingsTile id="rules" name="Your rules" description="Standing rules every agent obeys" summary="every agent, every turn" openTile={openTile} setOpenTile={setOpenTile}>
        <GlobalRulesSection />
      </SettingsTile>
      <SettingsTile id="connections" name="Connections" description="Accounts & tools your agents can use — Gmail, Telegram, MCP" summary={connectionsSummary} openTile={openTile} setOpenTile={setOpenTile}>
        <ConnectionsSection />
      </SettingsTile>
      <SettingsTile id="skills" name="Skills" description="Packaged know-how agents read on demand" summary="packaged know-how" openTile={openTile} setOpenTile={setOpenTile}>
        <SkillsSection />
      </SettingsTile>
      <SettingsTile id="vision" name="Vision model" description="Describes images for text-only models" summary={modelOf(config.visionModel) ?? 'not set'} openTile={openTile} setOpenTile={setOpenTile}>
        <VisionSection />
      </SettingsTile>
      <SettingsTile id="image" name="Image model" description="Generates pictures in chat" summary={modelOf(config.imageModel) ?? 'not set'} openTile={openTile} setOpenTile={setOpenTile}>
        <ImageModelSection />
      </SettingsTile>
      <SettingsTile id="video" name="Video model" description="Renders clips for video_generate" summary={modelOf(config.videoModel) ?? 'off'} openTile={openTile} setOpenTile={setOpenTile}>
        <VideoModelSection />
      </SettingsTile>
      <SettingsTile id="voice" name="Voice" description="Speech in, speech out" summary={voiceSummary} openTile={openTile} setOpenTile={setOpenTile}>
        <VoiceSection />
      </SettingsTile>
      <SettingsTile id="spending" name="Spending" description="Whether agents may spend, and the caps" summary={spendingSummary} openTile={openTile} setOpenTile={setOpenTile}>
        <SpendingSection />
      </SettingsTile>
      <SettingsTile id="updates" name="Updates" description="Version and auto-update" summary={version || 'auto'} openTile={openTile} setOpenTile={setOpenTile}>
        <RemoteSection />
        <UpdatesSection />
      </SettingsTile>

      <SettingsTile id="autoagents" name="Auto agents" description="The hands Vodo hires when a group needs more people" summary={autoAgentSummary} openTile={openTile} setOpenTile={setOpenTile}>
        <AutoAgentsSection />
      </SettingsTile>
      <SettingsTile id="homelab" name="Mr Homelab" description="A dedicated infrastructure agent tab" summary={config.homelabEnabled ? 'shown' : 'hidden'} openTile={openTile} setOpenTile={setOpenTile}>
        <HomelabSection />
      </SettingsTile>

      <SettingsTile id="generic" name="Generic folder" description="Where folder-less chats write" summary={genericSummary} openTile={openTile} setOpenTile={setOpenTile}>
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
      </SettingsTile>

      <SettingsTile id="vodo" name="Vodo (default agent)" description="How Vodo routes, and his prompt" summary={`${config.routeMode} · ${config.routeTier}`} openTile={openTile} setOpenTile={setOpenTile}>
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
      </SettingsTile>
      <SettingsTile id="display" name="Display" description="Zoom and appearance" summary="zoom & appearance" openTile={openTile} setOpenTile={setOpenTile}>
        <DisplaySection />
      </SettingsTile>
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

/**
 * The role this app booted with. The preload picks its transport when the
 * window is created, so switching role only takes effect on reload — this is
 * what the panel compares against to say so honestly, rather than appearing to
 * switch and then behaving like it did not.
 */
let bootRole: RemoteSettings['role'] | null = null;

/** A shared secret for the link. 24 bytes, base64url — no padding to mis-copy. */
function newRemoteToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function RemoteSection() {
  /**
   * Read straight from THIS machine, not through the shared config.
   *
   * Everything else in Settings belongs to the computer Vodo runs on, and a
   * front end editing it is exactly right. This panel is the one exception:
   * it says which end of the wire this window is, which is a fact about the
   * computer it is running on. Through the ordinary config a connected laptop
   * would be shown the DESKTOP's answer — and pressing "Off" would switch the
   * desktop off and strand the laptop with nothing to reconnect to.
   */
  const [remote, setRemote] = useState<RemoteSettings | null>(null);
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [pairAddress, setPairAddress] = useState('');

  useEffect(() => {
    // remoteInfo asks the HOST whether it is serving, so on a front end with
    // nothing to talk to it never answers. Caught rather than left to reject:
    // this panel is the way OUT of exactly that situation, and it has to render
    // whether or not anything is listening.
    void window.vo.remoteInfo().then(setInfo).catch(() => setInfo(null));
    return window.vo.onRemoteChanged(setInfo);
  }, []);
  useEffect(() => {
    void window.vo.remoteSettingsGet().then((r) => {
      setRemote(r);
      if (bootRole === null) bootRole = r.role;
    });
  }, []);

  if (!remote) return null;
  const role = remote.role;
  /**
   * Which address the pairing code carries.
   *
   * A machine has several — a LAN address, a tailnet one, sometimes a
   * container bridge — and only the person looking knows which one the phone
   * can actually reach. Defaulting to the first and letting them tap another
   * beats guessing, and beats showing several codes nobody can tell apart.
   */
  const addressList = (info?.addresses ?? []).map(
    (a) => `${a}:${remote.listen.port || DEFAULT_REMOTE_PORT}`,
  );
  const pairFor = addressList.includes(pairAddress) ? pairAddress : addressList[0];
  const patch = (p: Partial<RemoteSettings>) => {
    setRemote({ ...remote, ...p });
    void window.vo.remoteSettingsSet(p).then(setRemote);
  };
  const needsRestart = bootRole !== null && bootRole !== role;

  return (
    <section>
      <h2>Remote</h2>
      <p className="hint">
        Run Vodo on one computer and drive him from another on the same network. The machine he
        runs on owns everything — the files he edits, the commands he runs, the keys he uses. The
        front end is just the window you look through, so it can be a laptop, and he can be a
        desktop or a container.
      </p>

      <div className="field-row">
        <label>this computer</label>
        <select
          value={role}
          onChange={(e) => {
            const next = { ...remote, role: e.target.value as RemoteSettings['role'] };
            setRemote(next);
            // Applied by reloading this window: the preload picks its transport
            // when it loads, so it comes back on the other side. No restart.
            void window.vo.remoteApplyRole({ role: next.role });
          }}
        >
          <option value="local">Off — Vodo runs here, in this window</option>
          <option value="host">Main — Vodo runs here and serves other machines</option>
          <option value="client">Remote — a front end for the main computer</option>
        </select>
      </div>

      {needsRestart && (
        <p className="hint">
          ⟳ Switching this window over…
        </p>
      )}
      <div className="field-row">
        <label>second window</label>
        <button
          title="Open another window on the other side, so both are up at once"
          onClick={() => void window.vo.openWindowAs(role === 'client' ? 'local' : 'client')}
        >
          Open a {role === 'client' ? 'local' : 'remote'} window too
        </button>
        <span className="meta grow">
          Two windows, one app — each picks its own side when it opens.
        </span>
      </div>

      {role === 'host' && (
        <>
          <div className="field-row">
            <label>port</label>
            <input
              type="number"
              value={remote.listen.port || DEFAULT_REMOTE_PORT}
              onChange={(e) =>
                patch({
                  listen: { ...remote.listen, port: Number(e.target.value) || DEFAULT_REMOTE_PORT },
                })
              }
            />
            <span className="meta grow">
              {info?.listening
                ? `● listening — ${info.clients} front end${info.clients === 1 ? '' : 's'} attached`
                : info?.lastError
                  ? `⚠ ${info.lastError}`
                  : remote.listen.token
                    ? 'not listening yet'
                    : 'needs a key'}
            </span>
          </div>
          <div className="field-row">
            <label>key</label>
            <input
              type="text"
              value={remote.listen.token}
              placeholder="press Make a key"
              onChange={(e) => patch({ listen: { ...remote.listen, token: e.target.value } })}
            />
            <button onClick={() => patch({ listen: { ...remote.listen, token: newRemoteToken() } })}>
              Make a key
            </button>
            <button
              disabled={!remote.listen.token}
              onClick={() => {
                void navigator.clipboard?.writeText(remote.listen.token);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div className="field-row">
            <label>encryption</label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={remote.listen.tls !== false}
                onChange={(e) => patch({ listen: { ...remote.listen, tls: e.target.checked } })}
              />
              encrypt the link
            </label>
            <span className="meta grow">
              {remote.listen.tls === false
                ? '⚠ plain — only on a tailnet or a network you own'
                : 'on — desktop front ends pin this computer’s identity'}
            </span>
          </div>
          {remote.listen.tls === false && (
            <p className="hint">
              Off for one reason: phones. The companion app cannot accept a certificate this
              computer signed for itself, and neither Android nor iOS will let it be told to.
              Plain, the key still guards the door — what is gone is secrecy from anyone already
              on the wire, which is why this belongs inside Tailscale or on your own LAN and
              nowhere else.
            </p>
          )}
          <div className="field-row">
            <label>address</label>
            <div className="checkbox-row grow">
              {(info?.addresses ?? []).length === 0 ? (
                <span className="hint">no network address found</span>
              ) : (
                (info?.addresses ?? []).map((a) => {
                  const full = `${a}:${remote.listen.port || DEFAULT_REMOTE_PORT}`;
                  return (
                    <code
                      key={a}
                      className="perm-tool"
                      title="Show the pairing code for this address"
                      style={{
                        cursor: 'pointer',
                        outline: full === pairAddress ? '1px solid var(--accent)' : 'none',
                      }}
                      onClick={() => setPairAddress(full)}
                    >
                      {full}
                    </code>
                  );
                })
              )}
            </div>
          </div>
          {!!remote.listen.token && !!pairFor && (
            <div className="field-row" style={{ alignItems: 'flex-start' }}>
              <label>phone</label>
              <div style={{ display: 'flex', gap: '14px', alignItems: 'center' }}>
                <PairingCode
                  address={pairFor}
                  token={remote.listen.token}
                  tls={remote.listen.tls !== false}
                />
                <span className="meta" style={{ maxWidth: '280px' }}>
                  Point the companion app at this. It carries the address and the key together,
                  so nothing has to be typed on a phone.
                  {(info?.addresses ?? []).length > 1 && (
                    <>
                      {' '}
                      Showing <code>{pairFor}</code> — tap another address above to switch.
                    </>
                  )}
                  {remote.listen.tls !== false && (
                    <>
                      {' '}
                      <strong>The link is still encrypted, which a phone cannot accept</strong> —
                      untick it above or the app will scan this and then fail to connect.
                    </>
                  )}
                </span>
              </div>
            </div>
          )}
          {info?.fingerprint && (
            <div className="field-row">
              <label>identity</label>
              <code className="perm-tool grow" style={{ fontSize: '11px', wordBreak: 'break-all' }}>
                {info.fingerprint}
              </code>
            </div>
          )}
          <p className="hint">
            Type one of those addresses and the key into the other machine&apos;s{' '}
            <strong>Remote</strong> setting. The link is encrypted, and the other machine
            remembers this computer&apos;s <strong>identity</strong> the first time it connects —
            if it ever changes, it refuses rather than asking. You can compare it above.
          </p>
          <p className="hint">
            Worth being plain about what this is: anything holding the key can run commands and
            edit files <em>on this computer</em>, the same as sitting at it. Only hand it to
            machines you own, and make a new key if one gets loose.
          </p>
        </>
      )}

      {role === 'client' && (
        <>
          <div className="field-row">
            <label>main computer</label>
            <input
              type="text"
              value={remote.connect.url}
              placeholder={`192.168.1.20:${DEFAULT_REMOTE_PORT}`}
              onChange={(e) => patch({ connect: { ...remote.connect, url: e.target.value.trim() } })}
            />
          </div>
          <div className="field-row">
            <label>key</label>
            <input
              type="password"
              value={remote.connect.token}
              placeholder="paste the key from the main computer"
              onChange={(e) => patch({ connect: { ...remote.connect, token: e.target.value.trim() } })}
            />
          </div>
          <div className="field-row">
            <label>identity</label>
            <code className="perm-tool grow" style={{ fontSize: '11px', wordBreak: 'break-all' }}>
              {remote.connect.fingerprint || 'learned on the first connection'}
            </code>
            {remote.connect.fingerprint && (
              <button
                title="Forget it, and learn the main computer's identity again on the next connection"
                onClick={() => patch({ connect: { ...remote.connect, fingerprint: '' } })}
              >
                Forget
              </button>
            )}
          </div>
          <p className="hint">
            Both come from the main computer&apos;s <strong>Remote</strong> setting. While this is
            on, your own disk is invisible to Vodo — projects, folders and files all live on the
            main computer, and dragging a file onto a chat sends a copy over.
          </p>
          <p className="hint">
            The link is encrypted. The main computer&apos;s <strong>identity</strong> is
            remembered the first time you connect, and after that a different one is refused —
            so compare it against what the other machine shows if you want to be sure. Press
            Forget only if you deliberately reinstalled over there.
          </p>
        </>
      )}
    </section>
  );
}
