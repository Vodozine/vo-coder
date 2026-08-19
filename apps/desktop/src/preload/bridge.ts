import { ipcRenderer } from 'electron';
import { CLIENT_CHANNELS, IPC } from '../shared/ipc-contract';
import { decodeWire, encodeWire } from '../shared/wire';

/**
 * Channels whose result carries a URL the HOST can reach and this machine
 * cannot. The preview pane is served by a dev server on the host's own
 * localhost; handed that address verbatim, a front end would load its own
 * localhost and show nothing, or worse, show a different project.
 */
const PREVIEW_URL_RESULTS: ReadonlySet<string> = new Set<string>([
  IPC.previewStartDev,
  // No previewStartStatic here: this edition has no static server to rewrite
  // the address of. Pro carries one, which is the only line by which these two
  // copies of this file differ.
  IPC.previewState,
  IPC.previewDetect,
]);

/**
 * Point a host-local preview URL back through the host's one open port, where
 * the server proxies it (and its hot-reload socket) to the real dev server.
 * Anything that is not host-local — a real website — is left alone.
 */
function rewritePreviewUrls<T>(value: T, httpBase: string): T {
  if (!value || typeof value !== 'object') return value;
  const out = value as Record<string, unknown>;
  const url = out['url'];
  if (typeof url === 'string' && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/)/i.test(url)) {
    const path = new URL(url).pathname.replace(/^\//, '');
    return { ...out, url: `${httpBase}/preview/${path}` } as T;
  }
  return value;
}

/**
 * How `window.vo` reaches the main process.
 *
 * In the normal case that is Electron IPC, and this file changes nothing about
 * it. When the app is a remote front end, the same calls have to reach a main
 * process on a different machine — so the API object is written once against
 * this interface, and only the thing underneath it swaps.
 *
 * The point of doing it here rather than writing a second copy of the API is
 * that a second copy would drift. There are ~200 methods; the first one somebody
 * adds to one file and not the other is a bug nobody sees until a panel is dead
 * in remote mode only.
 */
/**
 * Answers a question the host has put to this machine — today, "which file?".
 * Registered by the renderer, because only the renderer can draw a picker.
 */
/**
 * How the link is doing, for the window to show.
 *
 * A front end that cannot reach its backend used to render "Loading..." and
 * nothing else — recoverable once Settings stayed reachable, but still a
 * guessing game as to WHY. Refused certificate, wrong key, nothing
 * listening and mismatched editions all looked identical.
 */
export interface LinkState {
  connected: boolean;
  error: string | null;
}

let linkState: LinkState = { connected: false, error: null };
const linkWatchers = new Set<(s: LinkState) => void>();

export function currentLinkState(): LinkState {
  return { ...linkState };
}

export function onLinkState(cb: (s: LinkState) => void): () => void {
  linkWatchers.add(cb);
  return () => {
    linkWatchers.delete(cb);
  };
}

function setLinkState(next: LinkState): void {
  linkState = next;
  for (const w of linkWatchers) w({ ...next });
}

export type HostAsk = (kind: string, payload: unknown) => Promise<unknown>;

let hostAsk: HostAsk | null = null;

/** The renderer hands over its picker once, at startup. */
export function setHostAsk(fn: HostAsk): void {
  hostAsk = fn;
}

export interface Bridge {
  /**
   * Generic so each call site keeps the return type the VoApi interface
   * declares for it — `ipcRenderer.invoke` hands back `any`, which silently
   * fits anything, and a bare `unknown` here would break all ~200 of them.
   */
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  on(channel: string, cb: (payload: unknown) => void): () => void;
}

/** Electron IPC, exactly as before. */
export function localBridge(): Bridge {
  return {
    invoke: <T,>(channel: string, ...args: unknown[]) =>
      ipcRenderer.invoke(channel, ...args) as Promise<T>,
    on: (channel, cb) => {
      const listener = (_event: unknown, payload: unknown): void => cb(payload);
      ipcRenderer.on(channel, listener);
      return () => {
        ipcRenderer.removeListener(channel, listener);
      };
    },
  };
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** Wire messages. Kept boring — this is a protocol two versions must agree on. */
type ClientMessage =
  | { type: 'auth'; token: string; edition: string }
  | { type: 'answer'; id: number; value: unknown }
  | { type: 'invoke'; id: number; channel: string; args: unknown[] };
type ServerMessage =
  | { type: 'ready' }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: string }
  | { type: 'event'; channel: string; payload: unknown }
  | { type: 'ask'; id: number; kind: string; payload: unknown };

/**
 * Talks to a host over a socket, and to the local main process for the handful
 * of channels that must not leave this machine (see CLIENT_CHANNELS).
 *
 * Two behaviours worth knowing about:
 *
 *  - Calls made before the socket is up are queued, not failed. The renderer
 *    asks for the config on its very first line, long before a LAN round trip
 *    can finish, and a front end that rendered "no config" for half a second
 *    on every start would be its own bug.
 *
 *  - In-flight calls are REJECTED on a drop, never replayed. Reconnecting is
 *    automatic, but a chatSend that may or may not have reached the host must
 *    not be sent twice — a duplicated turn costs money and confuses the agent.
 *    Events need no replay: the host pushes to whoever is attached, so the
 *    stream resumes by itself.
 */
export function remoteBridge(url: string, token: string, edition: string): Bridge {
  /** Same host and port as the socket — the preview proxy shares the listener. */
  const httpBase = url.replace(/^ws/, 'http').replace(/\/+$/, '');
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const pending = new Map<number, Pending>();
  /** Calls made while the socket is down, replayed once it is ready. */
  const queue: Array<() => void> = [];
  let socket: WebSocket | null = null;
  let ready = false;
  let seq = 0;
  let retry = 0;
  /**
   * Has this bridge EVER been ready?
   *
   * Queueing calls until the socket is up is right for a blip — the renderer
   * asks for config on its first line and a LAN round trip takes a moment.
   * It is wrong forever: a front end pointed at a backend that is off, or
   * gone, or was switched to local, would sit on "Loading..." with nothing
   * on screen to say why, and a restart would do it all again.
   */
  let everReady = false;
  let firstAttempt = Date.now();

  /** Set once we have decided the backend is not coming. */
  let stuck: string | null = null;
  const send = (msg: ClientMessage): void => socket?.send(JSON.stringify(msg));

  const failAllPending = (why: string): void => {
    for (const { reject } of pending.values()) reject(new Error(why));
    pending.clear();
  };

  const connect = (): void => {
    const ws = new WebSocket(url);
    socket = ws;

    ws.onopen = () => {
      // Authenticate before anything else. The host answers 'ready' or closes;
      // the token never goes in the URL, where proxies and logs would keep it.
      // The edition goes with it so a mismatch is refused once, here, instead
      // of showing panels backed by channels the other end does not have.
      send({ type: 'auth', token, edition });
    };

    ws.onmessage = (ev: MessageEvent) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === 'ready') {
        ready = true;
        setLinkState({ connected: true, error: null });
        everReady = true;
        retry = 0;
        stuck = null;
        firstAttempt = Date.now();
        for (const run of queue.splice(0)) run();
        return;
      }
      if (msg.type === 'result') {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.ok) p.resolve(decodeWire(msg.value));
        else p.reject(new Error(msg.error));
        return;
      }
      if (msg.type === 'event') {
        const payload = decodeWire(msg.payload);
        for (const cb of listeners.get(msg.channel) ?? []) cb(payload);
        return;
      }
      if (msg.type === 'ask') {
        const id = msg.id;
        const reply = (value: unknown): void =>
          socket?.send(JSON.stringify({ type: 'answer', id, value: encodeWire(value) }));
        // No picker registered yet means the page has not finished starting.
        // Answering null reads as a cancel on the host, which every caller
        // already handles — better than leaving it waiting on nothing.
        if (!hostAsk) {
          reply(null);
          return;
        }
        void hostAsk(msg.kind, decodeWire(msg.payload))
          .then(reply)
          .catch(() => reply(null));
      }
    };

    const dropped = (ev?: CloseEvent): void => {
      if (socket !== ws) return;
      ready = false;
      socket = null;
      // Some refusals will never become acceptances: a key that is wrong stays
      // wrong, and an edition that does not match will not change by itself.
      // Retrying those forever hides the reason behind a reconnect loop, so
      // say it once and stop.
      const permanent = ev?.code === 4401 || ev?.code === 4403;
      const why =
        ev?.code === 4401
          ? 'The main computer refused the key.'
          : ev?.code === 4403
            ? `Editions do not match — ${ev.reason || 'the two ends are different builds'}.`
            : everReady
              ? 'Lost the connection to the main computer.'
              : // Never connected at all, which is a different problem and needs a
                // different sentence: a dropped link is usually temporary, a link
                // that never formed is usually a setting.
                `Could not reach ${url.slice(6)}. Check that computer is set to Main, that the key matches, and that both are the same edition. If it was reinstalled, press Forget beside its identity in Settings and connect again.`;
      setLinkState({ connected: false, error: why });
      failAllPending(why);
      // Never connected, and long enough that this is not a slow start:
      // fail what is waiting so the window can say so instead of hanging.
      if (!everReady && Date.now() - firstAttempt > 8000) {
        const queued = queue.splice(0);
        if (queued.length) {
          console.error(`[remote] ${why} Giving up on ${queued.length} queued call(s).`);
        }
        stuck = why;
      }
      if (permanent) {
        console.error(`[remote] ${why} Not retrying.`);
        return;
      }
      // Back off to a few seconds so a host that is off does not turn into a
      // busy loop, but stay quick early on — a restart should feel seamless.
      retry = Math.min(retry + 1, 5);
      setTimeout(connect, retry * 1000);
    };
    ws.onclose = dropped;
    ws.onerror = () => ws.close();
    // onclose carries the code; onerror does not, so the reason comes from there.
  };
  connect();

  /** One call down the socket, queued if the link is not up yet. */
  const overTheWire = <T,>(channel: string, args: unknown[]): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = (): void => {
        const id = ++seq;
        pending.set(id, {
          resolve: (v) =>
            resolve(
              PREVIEW_URL_RESULTS.has(channel) ? rewritePreviewUrls(v as T, httpBase) : (v as T),
            ),
          reject,
        });
        send({ type: 'invoke', id, channel, args: encodeWire(args) as unknown[] });
      };
      if (ready) run();
      // Already decided the backend is not coming: fail now rather than
      // joining a queue nobody is going to drain.
      else if (stuck) reject(new Error(stuck));
      else queue.push(run);
    });

  return {
    invoke: <T,>(channel: string, ...args: unknown[]) => {
      // Window chrome never crosses the wire, connected or not.
      if (CLIENT_CHANNELS.has(channel)) return ipcRenderer.invoke(channel, ...args) as Promise<T>;
      // A real file must not go through the JSON envelope: it base64s the
      // bytes and refuses past 8 MB, which is exactly the size of the things
      // people drag in. POST it to the same listener instead — streamed, and
      // with no size that matters.
      if (channel === IPC.hostFileUpload) {
        const [name, bytes] = args as [string, ArrayBuffer];
        return fetch(
          `${httpBase}/upload?name=${encodeURIComponent(name)}&key=${encodeURIComponent(token)}`,
          { method: "POST", body: bytes },
        )
          .then((r) => r.json())
          .then((r) => r as T)
          .catch((e: unknown) => ({
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          }) as T);
      }
      // A film must not come down the socket. Ask for an address instead, and
      // let the player fetch the parts it wants when it wants them — which is
      // also the only way seeking works: dropping the playhead at ten minutes
      // should not mean downloading the first ten.
      if (channel === IPC.videoRead) {
        return overTheWire<{ ok: boolean; id?: string; mimeType?: string; error?: string }>(
          IPC.mediaUrl,
          args,
        ).then(
          (r) =>
            (r.ok && r.id
              ? { ok: true, url: `${httpBase}/media/${r.id}`, mimeType: r.mimeType }
              : { ok: false, error: r.error ?? 'Could not reach that file.' }) as T,
        );
      }
      return overTheWire<T>(channel, args);
    },
    on: (channel, cb) => {
      if (CLIENT_CHANNELS.has(channel)) return localBridge().on(channel, cb);
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(cb);
      return () => {
        set.delete(cb);
      };
    },
  };
}
