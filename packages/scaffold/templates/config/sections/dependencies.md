## Dependency Management

<!-- when: answers.language == "javascript" -->
- Commit `package-lock.json`; install with `npm ci` in CI and fresh clones.
- Pin direct dependencies with exact or tilde ranges; review lockfile diffs in PRs.
<!-- /when -->
<!-- when: answers.language == "python" -->
- Declare dependencies in `pyproject.toml`; lock with your chosen tool (uv/poetry/pip-tools) and commit the lockfile.
- One virtual environment per project — never install into the system Python.
<!-- /when -->
<!-- when: answers.language == "rust" -->
- `Cargo.toml` + committed `Cargo.lock`. Run `cargo update` deliberately, not incidentally.
<!-- /when -->
<!-- when: answers.language == "go" -->
- `go.mod` + `go.sum` committed. Tidy with `go mod tidy` before every commit that touches imports.
<!-- /when -->
<!-- when: answers.language == "java" -->
- Use Maven or Gradle with locked/pinned versions; commit the wrapper so builds are reproducible.
<!-- /when -->
<!-- when: answers.language == "other" -->
- Whatever the {{languageLabel}} ecosystem uses, the rule is the same: a manifest for intent, a committed lockfile for reproducibility.
<!-- /when -->
<!-- when: answers.philosophy -->

Philosophy check — "{{answers.philosophy}}": audit every new dependency against
this before adding it. A dependency you can replace with 30 lines of your own
code usually should be.
<!-- /when -->
