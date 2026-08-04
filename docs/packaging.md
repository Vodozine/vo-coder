# Packaging Vo-Coder (Windows install package)

## Dogfooding hazard — read this first

Vo-Coder is often open **on its own monorepo**. Packaging from inside that
session is dangerous:

1. **`electron-vite build` rewrites `apps/desktop/out/`**  
   If a dev shell (`npm run dev` / `npm run preview`) is running, that build
   fights the live main/preload/renderer bundles and can kill Electron mid-run.
   The agent harness dies with the app.

2. **`electron-builder` writes hundreds of MB** under
   `apps/desktop/release-*` / `release-local` (NSIS setup + `win-unpacked`).  
   CodeWatch used to ignore only a bare `release/` segment, so `release-local`
   and `release-1.2.5` were still watched — a flood of chokidar → IPC events
   while packing. That ignore is now `release[^/]*` (see `watcher.ts`).

3. **You asked for a package, not an install.**  
   Agents must only produce the installer artifact. Never run the Setup `.exe`
   or replace the running install unless the user explicitly asks to install.

**Rule:** when the user is using Vo-Coder to work on Vo-Coder, **do not run
`dist` / `dist:test` / `electron-builder` from the in-app agent.** Close the app
(or at least stop CodeWatch on this repo and any `npm run dev` shell), then pack
from an external terminal. Prefer pointing the user at an **already-built**
installer if one exists.

## Already-built Windows installer (current tree)

| Path | Notes |
|------|--------|
| `apps/desktop/release-1.2.7/Vo-Coder Setup 1.2.7.exe` | ~101.2 MB NSIS one-click setup for `@vo-coder/desktop` **1.2.7**. Built 2026-07-29. |
| `apps/desktop/release-1.2.6/Vo-Coder Setup 1.2.6.exe` | Prior 1.2.6 test build. |
| `apps/desktop/release-test/Vo-Coder Setup 1.2.5.exe` | Prior 1.2.5 test build (provider On/Off + saved-key row UI fix). |

Double-click that file yourself when you want to install/update. Incomplete
pack dirs (`release-local/`, `release-local/win-unpacked.tmp`) are leftovers from
interrupted or locked builds — safe to delete; they are not installers.

If `release-local` is EBUSY (asar locked by a prior pack), build to a fresh
output dir instead of fighting the lock:

```bash
npx electron-builder --config electron-builder.yml \
  --config.directories.output=release-1.2.7 --publish never \
  --project apps/desktop
```

(Requires `electron-vite build` to have run first so `apps/desktop/out/` is current.)

## Official multi-platform release (GitHub Actions)

Pushing a version tag triggers [`.github/workflows/release.yml`](../.github/workflows/release.yml):

1. Matrix builds on `windows-latest`, `macos-latest`, `ubuntu-latest`
2. Compiles workspace packages, bundles infra-mcp, builds Electron
3. `electron-builder --publish always` uploads artifacts to a GitHub Release
   (Windows NSIS, macOS DMG x64 + arm64, Linux AppImage)

```bash
# After master is pushed at the release version:
git tag v1.2.7
git push origin v1.2.7
```

In-app auto-update reads the public GitHub releases feed (`electron-builder.yml`
→ `publish.provider: github`). Publish the draft release once all three OS jobs
have uploaded if the workflow left it as draft.

Do **not** commit `apps/desktop/release*` artifacts (gitignored). CI builds are
the source of truth for distributed installers — including Windows: a CI-built
NSIS setup and a local build of the same commit produce identically-targeted
installers (verified 2026-08-04 by extracting and installing a CI 1.2.8
artifact).

### Windows install directory

The one-click per-user NSIS installer defaults to
`%LOCALAPPDATA%\Programs\<name>`, where `<name>` is the sanitized
**`package.json` `name`** of `apps/desktop`. `productName` only names the
setup exe, shortcuts, and the uninstall entry — it does not pick the folder.
Renaming the package therefore moves the install dir: builds before the
v1.2.8 rename (`@vo-coder/desktop`) installed to `Programs\@vo-coderdesktop`;
from v1.2.8 (`vo-coder`) the app lives in `Programs\vo-coder`. When the same
appId is already installed, the installer reuses the registered
`InstallLocation` under `HKCU\Software\<appId guid>` instead of the default.

## Commands (external terminal only)

From monorepo root, **with Vo-Coder closed** (or at least not running `dev` on
this tree):

```bash
# Local test NSIS package → apps/desktop/release-local/
npm run dist:test -w apps/desktop

# Default output dir (electron-builder.yml → directories.output: release)
npm run dist -w apps/desktop
```

`dist:test` is preferred for agent/local checks (`--publish never`, output
`release-local`). Do not commit `apps/desktop/release*` artifacts (gitignored).

## What the package includes

- Electron 43 app (`Vo-Coder.exe` / `.app` / AppImage)
- Bundled `out/**` in asar
- extraResources: infra-mcp, capability-data, scaffold-templates

See `apps/desktop/electron-builder.yml` and `apps/desktop/package.json` scripts
`dist`, `dist:dir`, `dist:test`.
