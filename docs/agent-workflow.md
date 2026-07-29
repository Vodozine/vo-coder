# Agent workflow notes (this repo)

Short, durable rules for agents working in the Vo-Coder monorepo.

## "Preview" / "start the app" / "open Vo-Coder"

**Always** launch the native Electron desktop shell:

```bash
npm run preview -- --restart
```

- Implementation: `scripts/preview-desktop.mjs`
- Spec: `docs/desktop-preview.md`
- Root scripts: `preview`, `preview:stop`, `preview:restart`

**Never** treat these as a Vo-Coder app preview:

- `npx vite` / any browser-only renderer server
- Opening `http://127.0.0.1:5173` (or similar) in a browser tab
- Another project's dev server that happens to own the same port

Isolated profile: `%TEMP%/vo-coder-dev-preview/userdata` via `VO_USERDATA`
(so dev does not fight the installed app's single-instance lock).

In-app **Preview** pane (user project UI inside Vo-Coder) is a different
feature — see `apps/desktop/src/main/preview.ts`.

## Verify after code changes

Prefer root scripts: `npm run typecheck`, `npm test`, `npm run lint`.

## Packaging / install packages (dogfooding)

**Do not run `dist`, `dist:test`, or `electron-builder` while this app is the
live shell working on this monorepo.** Packaging rewrites `apps/desktop/out/`
and dumps large trees under `release*` — that has crashed the running app and
harness mid-build.

Full rules: `docs/packaging.md`.

- Prefer an existing installer (e.g. `apps/desktop/release-1.2.7/Vo-Coder Setup 1.2.7.exe`).
- Produce artifacts only; **never** run the Setup `.exe` unless the user asked to install.
- Do not commit `apps/desktop/release-*` artifacts.

## Official GitHub release

Multi-platform installers are built by Actions on a `v*` tag push (not by packing
inside the dogfooded shell). See `docs/packaging.md` → Official multi-platform release.
