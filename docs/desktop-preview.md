# Desktop preview workflow (Vo-Coder itself)

When someone asks to **preview**, **start the app**, or **open Vo-Coder** from
this repo, launch the **native Electron shell**. A browser tab or a Vite-only
renderer URL is **not** a valid substitute.

## Why

Vo-Coder is an Electron app. The UI talks to main-process IPC (sessions,
membank, tools, terminal, project preview, secrets). Serving
`apps/desktop/src/renderer` alone shows a hollow page with no backend — and can
even collide with another project's dev server on port 5173.

## One command

From the monorepo root:

```bash
npm run preview
```

What it does:

1. Optionally clears a previous agent-started preview (`--restart` / `--stop`).
2. Sets `VO_USERDATA` to a temp isolated profile
   (`%TEMP%/vo-coder-dev-preview/userdata`) so the dev shell does not fight the
   installed app's single-instance lock or corrupt real `userData`.
3. Runs `npm run dev` → `@vo-coder/desktop` → `electron-vite dev -w`.
4. Leaves the process detached; a **native window** opens.

### Flags

| Flag | Meaning |
|------|---------|
| *(none)* | Start Electron with isolated profile |
| `--real` | Use normal userData (fails if another Vo-Coder holds the lock) |
| `--stop` | Stop previous agent-started preview only |
| `--restart` | Stop previous, then start fresh |

Examples:

```bash
npm run preview -- --restart
npm run preview -- --real
npm run preview -- --stop
```

Logs / pid: `%TEMP%/vo-coder-dev-preview/` (`preview.log`, `preview.pid`).

## Agent checklist (do this, don't improvise)

When the user says things like "start a preview", "open the app", "let me see
it":

1. **Run** `npm run preview -- --restart` via the workspace runner with
   `background: true` is **not** required — the script detaches itself. A normal
   foreground `ws_run` of `npm run preview` is fine (it exits after spawn).
2. **Confirm** an Electron/`electron-vite` process is up (or that the window
   appeared). Report pid + log path.
3. **Never**:
   - `npx vite` / `vite.preview.config` / open `http://127.0.0.1:5173` as "the app"
   - treat another project's dev server on 5173 as Vo-Coder
   - only build without launching unless the user asked for a build/dist

### In-app project preview (different thing)

Inside the running Vo-Coder window, **Preview** can host a *user project's* UI
via `PreviewManager` (starts that project's `dev`/`start` server in a sandboxed
`WebContentsView`). That is for projects open *in* Vo-Coder — not how we preview
Vo-Coder itself.

## Related

- Main process entry: `apps/desktop/src/main/index.ts` (`VO_USERDATA` override)
- Dev script: root `npm run dev` / `apps/desktop` `electron-vite dev -w`
- Script implementation: `scripts/preview-desktop.mjs`
