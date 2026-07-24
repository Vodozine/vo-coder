# Releasing Vo-Coder

Releases happen in **two phases**. A build is **never** published to GitHub until
it has been installed and tested locally and explicitly approved.

> **Current flow (since v1.0.0):** publishing is tag-driven. Phase 1 stays the
> local gate; Phase 2 is `git tag vX.Y.Z && git push origin vX.Y.Z` — CI
> (`.github/workflows/release.yml`) builds Windows + macOS (x64 & arm64) +
> Linux and attaches everything to one draft release, which is then published.

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

Publishing is tag-driven — CI builds all three platforms so every release has
identical, reproducible artifacts (the local Phase-1 installer is the
verification gate, not the shipped bits):

```powershell
# version already bumped + committed
git tag "v$v"
git push origin master "v$v"
# CI (release.yml) builds Win/mac(x64+arm64)/Linux → one DRAFT release
# verify the draft has all assets, then:
& "C:\Program Files\GitHub CLI\gh.exe" release edit "v$v" --repo Vodozine/vo-coder `
  --draft=false --latest --title "Vo-Coder $v" --notes-file notes.md
```

Publishing the release (with `latest.yml`) is what makes the in-app
auto-updater offer the new version to already-installed copies.

## Rule of thumb

- `npm run dist:test` = safe, local, repeatable. Run it freely.
- Pushing a `v*` tag / `gh release edit --draft=false` = the point of no
  return. Only after a tested, approved build.
