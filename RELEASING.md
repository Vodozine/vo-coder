# Releasing Vo-Coder

Releases happen in **two phases**. A build is **never** published to GitHub until
it has been installed and tested locally and explicitly approved.

> **Current cadence:** we are iterating through `0.9.x` with local test builds
> only. The next version published to GitHub is **v1.0.0**. Keep bumping the
> local version for each test installer, but do not run Phase 2 until 1.0 is
> ready and approved.

## Phase 1 — Build a test version (local only, nothing on GitHub)

```powershell
# from repo root
npx tsc -b                              # compile workspace packages (dist/) first
npm run typecheck -w @vo-coder/desktop  # must be clean
npm test                                # must be green
npm run dist:test -w @vo-coder/desktop  # builds a testable installer, --publish never
```

The installer lands in `apps/desktop/release-local/`:

- `Vo-Coder Setup <version>.exe` — install this and test the actual change
- `Vo-Coder Setup <version>.exe.blockmap`
- `latest.yml`

Install it, confirm the change works, and check nothing else regressed.
`release-local/` is git-ignored, so the 100 MB+ artifacts never enter history.

> The version in `apps/desktop/package.json` should already be bumped before
> this step so the test installer carries the version you intend to ship.

## Phase 2 — Publish (only after the test build is approved)

Publish the **exact same artifacts** that were tested — do not rebuild between
testing and publishing, or the release won't match what was verified. Upload
straight from `release-local/`:

```powershell
$v = (Get-Content apps/desktop/package.json | ConvertFrom-Json).version
& "C:\Program Files\GitHub CLI\gh.exe" release create "v$v" `
  "apps/desktop/release-local/Vo-Coder Setup $v.exe" `
  "apps/desktop/release-local/Vo-Coder Setup $v.exe.blockmap" `
  "apps/desktop/release-local/latest.yml" `
  --repo Vodozine/vo-coder --title "Vo-Coder $v" --notes "…"
```

Publishing `latest.yml` + the installer is what makes the in-app auto-updater
offer the new version to already-installed copies.

## Rule of thumb

- `npm run dist:test` = safe, local, repeatable. Run it freely.
- `gh release create` = the point of no return. Only after a tested, approved build.
