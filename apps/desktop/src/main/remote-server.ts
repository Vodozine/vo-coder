import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import {
  createServer as createPlainServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { CrewUser, RemoteInfo, RemoteSettings } from '../shared/ipc-contract';
import { decodeWire, encodeWire } from '../shared/wire';
import { edition } from './edition';
import { hostCert } from './remote-tls';
import { addSink, invoke } from './ipc-registry';

/** Who holds a given key. Set by the app; without it there is simply no crew. */
let crewLookup: (key: string) => CrewUser | null = () => null;

export function setCrewLookup(fn: (key: string) => CrewUser | null): void {
  crewLookup = fn;
}

/** Where the preview pane is served on this machine, or null if nothing runs. */
let previewOrigin: () => string | null = () => null;

/**
 * Tell the server where to forward /preview requests. Set once at startup;
 * the preview module owns the answer because it owns the dev child.
 */
export function setPreviewOrigin(fn: () => string | null): void {
  previewOrigin = fn;
}

/**
 * Serves this machine's Vodo to front ends on the network.
 *
 * One listener does both jobs: WebSocket for calls and events, plain HTTP for
 * anything that wants byte ranges (media, later). One port means one thing to
 * type into the other machine, one firewall rule, and — when the host is a
 * container — one `-p` to publish.
 *
 * What this is, stated plainly because the code should not be coy about it:
 * an authenticated remote-code-execution service. Anything holding the key can
 * ask for a PTY. That is the feature. It is why an empty key refuses to listen
 * rather than defaulting to open, and why the check happens before a single
 * channel is reachable.
 */

let server: Server | null = null;
let wss: WebSocketServer | null = null;
let lastError: string | undefined;
/** Shown beside the key so the two ends can be compared by eye when pairing. */
let certFingerprint: string | undefined;
const clients = new Set<WebSocket>();
const watchers = new Set<() => void>();

/**
 * Everything under this path is the previewed site, not this app. Kept as one
 * prefix on the one open port so a container needs no extra publishing and a
 * desktop host needs no second firewall answer.
 */
export const PREVIEW_PREFIX = '/preview/';
export const MEDIA_PREFIX = '/media/';
export const UPLOAD_PATH = '/upload';

/** Where an uploaded file should land, and under what name. Set by the app. */
let uploadSink: ((name: string, token: string) => { path: string } | null) | null = null;

export function setUploadSink(fn: (name: string, token: string) => { path: string } | null): void {
  uploadSink = fn;
}

/** Resolve a media id to a file on this machine, or null if it means nothing. */
let mediaResolver: (id: string) => { path: string; mimeType: string } | null = () => null;

export function setMediaResolver(fn: (id: string) => { path: string; mimeType: string } | null): void {
  mediaResolver = fn;
}

/**
 * Serve one media file, honouring Range.
 *
 * Range is the whole point. A player handed a plain 200 MB body must download
 * all of it before it can show a frame, and cannot seek at all — drag the
 * scrubber and it starts again from the top. With Range it fetches the few
 * hundred KB around wherever you dropped the playhead, which is what makes a
 * timeline usable over a network rather than merely possible.
 *
 * The id IS the credential: unguessable, issued only after the path passed the
 * same allowed-roots check as reading the bytes directly. A <video> element
 * cannot send our auth header, so the address has to carry its own right.
 */
function serveMedia(id: string, range: string | undefined, res: ServerResponse): void {
  const hit = mediaResolver(id);
  if (!hit) {
    res.writeHead(404).end();
    return;
  }
  let size: number;
  try {
    size = statSync(hit.path).size;
  } catch {
    res.writeHead(404).end();
    return;
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(range ?? '');
  if (!m) {
    res.writeHead(200, {
      'content-type': hit.mimeType,
      'content-length': size,
      'accept-ranges': 'bytes',
    });
    createReadStream(hit.path).pipe(res);
    return;
  }

  // "bytes=-500" means the LAST 500, not the first — players use it to find
  // the moov atom at the end of an mp4 before they play anything.
  const suffix = m[1] === '';
  let start = suffix ? Math.max(0, size - Number(m[2] || 0)) : Number(m[1]);
  let end = suffix || m[2] === '' ? size - 1 : Number(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
    return;
  }
  end = Math.min(end, size - 1);
  start = Math.max(0, start);
  res.writeHead(206, {
    'content-type': hit.mimeType,
    'content-length': end - start + 1,
    'content-range': `bytes ${start}-${end}/${size}`,
    'accept-ranges': 'bytes',
  });
  createReadStream(hit.path, { start, end }).pipe(res);
}

/** Hand a hot-reload socket through to the dev server and get out of the way. */
function proxyUpgrade(
  url: string,
  headers: NodeJS.Dict<string | string[]>,
  socket: Duplex,
  head: Buffer,
): void {
  const target = previewOrigin();
  if (!target) {
    socket.destroy();
    return;
  }
  // Spelled out rather than spread from the URL: a URL's parts live on the
  // prototype as getters, so `...new URL(t)` is an empty object and the request
  // quietly goes to localhost:80 instead. The page still loads over plain HTTP,
  // so the only symptom is that hot reload never fires again.
  const t = new URL(target);
  const up = httpRequest({
    hostname: t.hostname,
    port: t.port,
    path: url.slice(PREVIEW_PREFIX.length - 1) || '/',
    headers: { ...headers, host: t.host },
  });
  up.end();
  up.on('upgrade', (upRes, upSocket, upHead) => {
    const lines = Object.entries(upRes.headers).map(([k, v]) => `${k}: ${String(v)}`);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);
    if (upHead.length) socket.unshift(upHead);
    if (head.length) upSocket.unshift(head);
    upSocket.pipe(socket).pipe(upSocket);
  });
  up.on('error', () => socket.destroy());
}

/** Constant-time compare of two secrets of any length. */
function tokenMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function changed(): void {
  for (const w of watchers) w();
}

/** Notified when a front end attaches or drops, so Settings can show it. */
export function onRemoteStatusChange(cb: () => void): () => void {
  watchers.add(cb);
  return () => {
    watchers.delete(cb);
  };
}

export function remoteStatus(addresses: string[]): RemoteInfo {
  return {
    addresses,
    listening: !!server?.listening,
    clients: clients.size,
    lastError,
    fingerprint: certFingerprint,
  };
}

export function stopRemoteHost(): void {
  for (const ws of clients) ws.close();
  clients.clear();
  wss?.close();
  server?.close();
  wss = null;
  server = null;
  changed();
}

export async function startRemoteHost(settings: RemoteSettings): Promise<void> {
  stopRemoteHost();
  lastError = undefined;

  if (!settings.listen.token) {
    // Not an error the user needs shouting about — they have simply not made a
    // key yet — but it must never fall through to listening without one.
    lastError = 'No key yet — make one before other machines can connect.';
    changed();
    return;
  }

  /**
   * The listener itself: encrypted by default, plain when the user has said
   * the network is already trusted.
   *
   * Encrypted means a certificate this machine signed for itself, which the
   * front end pins by fingerprint — see remote-tls.ts for why that beats a
   * certificate authority here. Plain exists for phones, which cannot be made
   * to accept a self-signed certificate; there is no fingerprint to show in
   * that mode, so it is cleared rather than left showing a stale one from
   * whenever TLS was last on.
   */
  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.url?.startsWith(PREVIEW_PREFIX)) {
      const target = previewOrigin();
      if (!target) {
        res.writeHead(503).end('No preview server is running.');
        return;
      }
      const upstream = httpRequest(
        `${target}${req.url.slice(PREVIEW_PREFIX.length - 1) || '/'}`,
        { method: req.method, headers: { ...req.headers, host: new URL(target).host } },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end('Preview server did not answer.');
      });
      req.pipe(upstream);
      return;
    }
    /**
     * Files coming IN, streamed to disk.
     *
     * The socket path base64s into a JSON envelope and refuses past 8 MB,
     * which makes dropping a real video or a zip of assets impossible. This
     * is the mirror of /media/: same listener, same key, opposite arrow, and
     * no size that matters because nothing is buffered whole.
     */
    if (req.method === 'POST' && req.url?.startsWith(UPLOAD_PATH)) {
      const q = new URL(req.url, "http://x");
      const target = uploadSink?.(q.searchParams.get("name") ?? "file", q.searchParams.get("key") ?? "");
      if (!target) {
        res.writeHead(403).end();
        return;
      }
      const out = createWriteStream(target.path);
      req.pipe(out);
      out.on("finish", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: target.path }));
      });
      out.on("error", (e: Error) => {
        res.writeHead(500).end(e.message);
      });
      return;
    }
    if (req.url?.startsWith(MEDIA_PREFIX)) {
      serveMedia(
        decodeURIComponent(req.url.slice(MEDIA_PREFIX.length).split('?')[0] ?? ''),
        req.headers.range,
        res,
      );
      return;
    }
    // Nothing else on this port is anybody's business.
    res.writeHead(404).end();
  };

  let http: Server;
  if (settings.listen.tls === false) {
    certFingerprint = undefined;
    http = createPlainServer(onRequest);
  } else {
    const tls = await hostCert();
    certFingerprint = tls.fingerprint;
    http = createTlsServer({ cert: tls.cert, key: tls.key }, onRequest);
  }

  const sockets = new WebSocketServer({ noServer: true });

  sockets.on('connection', (ws: WebSocket) => {
    let authed = false;
    let user: CrewUser | null = null;
    let detach: (() => void) | null = null;
    /** Questions this host has put to THIS front end, awaiting answers. */
    const asks = new Map<number, (value: unknown) => void>();
    let askSeq = 0;

    /**
     * Ask the front end that made the current call, and wait.
     *
     * No timeout on purpose: a file dialog is open until a person deals with
     * it, and people take as long as they take. A dropped socket is what ends
     * it — see the close handler, which answers every outstanding question
     * with null so no handler waits on a machine that has gone.
     */
    const ask = (kind: string, payload: unknown): Promise<unknown> =>
      new Promise((resolve) => {
        const id = ++askSeq;
        asks.set(id, resolve);
        ws.send(JSON.stringify({ type: 'ask', id, kind, payload: encodeWire(payload) }));
      });

    // An unauthenticated socket gets a few seconds and no channels. Without
    // this, opening a connection and saying nothing would hold a slot forever.
    const authDeadline = setTimeout(() => {
      if (!authed) ws.close(4401, 'auth timeout');
    }, 5000);

    ws.on('message', (raw) => {
      let msg: {
        type?: string;
        id?: number;
        channel?: string;
        args?: unknown[];
        token?: string;
        edition?: string;
        value?: unknown;
      };
      try {
        msg = JSON.parse(String(raw)) as typeof msg;
      } catch {
        return;
      }

      if (!authed) {
        // Nothing but auth is even parsed until the key checks out.
        if (msg.type !== 'auth' || typeof msg.token !== 'string') return;

        // The key IS the login. A crew member's key names them; the machine's
        // own token still works for a backend that has no crew yet, so an
        // install from before people existed keeps connecting.
        const person = crewLookup(msg.token);
        if (!person && !tokenMatches(msg.token, settings.listen.token)) {
          ws.close(4401, 'bad key');
          return;
        }
        // The two ends must be the same edition. A Pro front end on a Free
        // host would show Design and Video tabs backed by channels that do not
        // exist over here, and answer "Unknown channel" to every one of them.
        // Refusing once, with a sentence, beats failing per-panel forever.
        const mine = edition();
        if (msg.edition && msg.edition !== mine) {
          ws.close(4403, `this computer runs Vo-Coder ${mine === 'pro' ? 'Pro' : 'Free'}`);
          return;
        }
        authed = true;
        // Deliberately NOT taken from the auth frame: a name the client sends
        // is a name the client chose, and attribution has to be worth trusting.
        user = person;
        clearTimeout(authDeadline);
        clients.add(ws);
        detach = addSink((channel, payload) => {
          ws.send(JSON.stringify({ type: 'event', channel, payload: encodeWire(payload) }));
        });
        ws.send(JSON.stringify({ type: 'ready', you: person ? { name: person.name, admin: person.admin } : null }));
        changed();
        return;
      }

      // An answer to something this host asked the front end (a file picker).
      if (msg.type === 'answer' && typeof msg.id === 'number') {
        const waiting = asks.get(msg.id);
        if (waiting) {
          asks.delete(msg.id);
          waiting(decodeWire(msg.value));
        }
        return;
      }

      if (msg.type !== 'invoke' || typeof msg.id !== 'number' || typeof msg.channel !== 'string') {
        return;
      }
      const id = msg.id;
      void invoke(msg.channel, (decodeWire(msg.args ?? []) as unknown[]) ?? [], { ask, user })
        .then((value) =>
          ws.send(JSON.stringify({ type: 'result', id, ok: true, value: encodeWire(value) })),
        )
        .catch((err: unknown) => {
          // The front end is another copy of this app; it renders the message.
          const error = err instanceof Error ? err.message : String(err);
          ws.send(JSON.stringify({ type: 'result', id, ok: false, error }));
        });
    });

    const gone = (): void => {
      clearTimeout(authDeadline);
      detach?.();
      detach = null;
      // Anything this host was waiting on that front end for is never coming.
      // Answer null rather than leaving handlers parked forever on a machine
      // that has closed its lid.
      for (const resolve of asks.values()) resolve(null);
      asks.clear();
      if (clients.delete(ws)) changed();
    };
    ws.on('close', gone);
    ws.on('error', gone);
  });

  http.on('upgrade', (req, socket, head) => {
    // Hot reload is a websocket of the dev server's own. Miss this and the
    // preview still renders, so it looks like it works — it just never updates
    // again, which is a worse bug than a blank pane.
    if (req.url?.startsWith(PREVIEW_PREFIX)) {
      proxyUpgrade(req.url, req.headers, socket, head);
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit('connection', ws, req));
  });

  http.on('error', (err: Error) => {
    lastError = err.message;
    changed();
  });

  // 0.0.0.0, not localhost: bound to loopback this is unreachable from the LAN
  // and — inside a container — unreachable even with the port published.
  http.listen(settings.listen.port, '0.0.0.0', () => changed());

  server = http;
  wss = sockets;
}
