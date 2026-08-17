import { createServer } from 'node:http';
import { shell } from 'electron';

/**
 * The browser end of a desktop sign-in, run on the machine with the browser.
 *
 * Desktop OAuth works by redirecting to http://127.0.0.1:<port> and catching
 * the code there. That address means "the computer the browser is on" — so
 * when the browser is a laptop and the agent is a desktop, a listener opened
 * on the desktop catches nothing at all and the sign-in hangs until it times
 * out, with no clue as to why.
 *
 * So the front end opens the port, opens the browser, and hands the code back.
 * Only the code travels: the exchange, the refresh token and the account stay
 * on the machine Vodo runs on, which is where the mail tools need them.
 */

/** The caller's URL carries this where the port has to go. */
export const PORT_PLACEHOLDER = '__VO_PORT__';

const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

export function runOauthLoopback(
  authUrlTemplate: string,
): Promise<{ ok: boolean; code?: string; redirectUri?: string; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: { ok: boolean; code?: string; redirectUri?: string; error?: string }): void => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        /* already closing */
      }
      clearTimeout(timer);
      resolve(r);
    };

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const code = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      const state = url.searchParams.get('state');
      // Browsers ask for /favicon.ico off their own bat. Only the real
      // callback carries a code or an error.
      if (!code && !err) {
        res.writeHead(204).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end(
        `<!doctype html><html><body style="font-family:system-ui;background:#0b0b0d;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
         <div style="text-align:center"><h2>${err ? 'Sign-in failed' : 'Vo-Coder is connected'}</h2>
         <p>You can close this tab and go back to Vo-Coder.</p></div></body></html>`,
      );
      if (err || !code) {
        finish({ ok: false, error: err ?? 'Sign-in was cancelled.' });
        return;
      }
      // State is checked by the host, which generated it — this end only
      // carries it back untouched.
      finish({
        ok: true,
        code,
        redirectUri: `http://127.0.0.1:${port}`,
        ...(state ? {} : {}),
      });
    });

    let port = 0;
    const timer = setTimeout(
      () => finish({ ok: false, error: 'Sign-in timed out — try again.' }),
      FLOW_TIMEOUT_MS,
    );

    server.on('error', (e: Error) =>
      finish({ ok: false, error: `Could not open a local port: ${e.message}` }),
    );
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr !== 'object') {
        finish({ ok: false, error: 'Could not open a local port.' });
        return;
      }
      port = addr.port;
      // The host built the URL without knowing the port, because only this
      // machine can pick one that is free here.
      void shell.openExternal(authUrlTemplate.split(PORT_PLACEHOLDER).join(String(port)));
    });
  });
}
