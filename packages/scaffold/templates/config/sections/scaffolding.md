## Project Scaffolding

Design rule for every part of this codebase: **small, modular blocks with
explicit contracts** (inputs, outputs, side effects) and **a test hook at every
connection point**. Blocks never reach into each other's internals.

<!-- when: answers.language == "javascript" -->
```
src/
├── index.(ts|js)      # entry — wiring only, no business logic
├── modules/           # one folder per block; each block ships its own tests
└── shared/            # cross-block contracts: types, interfaces, schemas
```

- Every module exports a typed interface; consumers import the contract, not the implementation.
- Prefer plain functions over classes unless state genuinely lives in the block.
<!-- /when -->
<!-- when: answers.language == "python" -->
```
src/<package>/
├── __init__.py
├── modules/           # one package per block; tests live beside the code
└── contracts.py       # dataclasses / Protocols shared between blocks
```

- Type-hint every public function. Blocks communicate only through contracts.py.
- Use a src-layout so the package is importable the same way in tests and production.
<!-- /when -->
<!-- when: answers.language == "rust" -->
```
src/
├── main.rs / lib.rs   # entry — wiring only
└── <block>/mod.rs     # one module per block; unit tests in-module (#[cfg(test)])
```

- Public APIs per block are re-exported from lib.rs; everything else stays private.
<!-- /when -->
<!-- when: answers.language == "go" -->
```
cmd/<app>/main.go      # entry — wiring only
internal/<block>/      # one package per block, each with _test.go beside it
pkg/contracts/         # shared interfaces between blocks
```
<!-- /when -->
<!-- when: answers.language == "java" -->
```
src/main/java/<group>/<app>/
├── App.java           # entry — wiring only
└── <block>/           # one package per block; interfaces define contracts
src/test/java/...      # mirrors main, one test class per block
```
<!-- /when -->
<!-- when: answers.language == "other" -->
Apply the same shape in {{languageLabel}}: an entry point that only wires
blocks together, one directory/module per block, a shared contracts area, and
tests co-located with each block.
<!-- /when -->
<!-- when: answers.projectType == "cli" -->

CLI note: keep argument parsing in the entry layer only — the core logic must
stay importable as a library so it can be tested without spawning a process.
<!-- /when -->
<!-- when: answers.projectType == "library" -->

Library note: the public API surface is itself a contract — document every
exported symbol and treat breaking changes as version events.
<!-- /when -->
<!-- when: answers.targetPlatform == "cross-desktop" -->

Platform note (cross-platform desktop): pick the shell framework first
(Electron, Tauri, Qt, …) and keep ALL platform-specific code behind one
`platform/` block — the rest of the codebase must never ask which OS it is on.
Test packaging on every target OS early, not at release time.
<!-- /when -->
<!-- when: answers.targetPlatform == "windows-desktop" -->

Platform note (Windows desktop): decide the packaging story (installer vs
portable exe) in week one, and keep paths/registry/UAC access behind one
`platform/` block so the core stays testable.
<!-- /when -->
<!-- when: answers.targetPlatform == "macos-desktop" -->

Platform note (macOS desktop): unsigned apps trip Gatekeeper ("damaged /
unidentified developer") — plan for code signing or documented right-click →
Open instructions before sharing builds with anyone.
<!-- /when -->
<!-- when: answers.targetPlatform == "linux-desktop" -->

Platform note (Linux desktop): pick the distribution format early (AppImage,
Flatpak, deb/rpm) — it constrains how the app may read config paths and bundle
dependencies.
<!-- /when -->
<!-- when: answers.targetPlatform == "android" -->

Platform note (Android): builds go through the Android SDK / Gradle (Android
Studio recommended). Keep business logic out of Activities/UI classes so it can
be unit-tested on the JVM without an emulator.
<!-- /when -->
<!-- when: answers.targetPlatform == "ios" -->

Platform note (iOS): building and shipping requires a Mac with Xcode plus an
Apple Developer account for App Store distribution.
<!-- when: answers.devOs != "macos" -->
Heads-up: your development OS is not macOS — plan for a cloud Mac / CI service
(or a borrowed Mac) for builds, or consider a cross-platform framework.
<!-- /when -->
<!-- /when -->
<!-- when: answers.targetPlatform == "web" -->

Platform note (web): the app is whatever the browser downloads — define the
supported-browser baseline now, and keep server API contracts in `shared/` so
front end and back end cannot drift apart.
<!-- /when -->
