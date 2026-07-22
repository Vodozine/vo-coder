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
