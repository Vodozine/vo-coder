## Development Environment Setup

<!-- when: answers.devOs == "windows" -->
- Windows dev machine: prefer PowerShell-compatible scripts, or provide both `.ps1` and `.sh` variants.
- Watch for path separators and line endings — set `.gitattributes` with `* text=auto eol=lf` early.
<!-- /when -->
<!-- when: answers.devOs == "linux" -->
- Linux dev machine: capture required system packages in a bootstrap script so a fresh machine can be productive in one command.
<!-- /when -->
<!-- when: answers.devOs == "macos" -->
- macOS dev machine: capture Homebrew dependencies in a `Brewfile` so setup is one `brew bundle` away.
<!-- /when -->
<!-- when: answers.virtualization == "docker" -->
- A `Dockerfile` (and `compose.yaml` if there are services) defines the canonical runtime — "works in the container" is the bar, not "works on my machine".
<!-- /when -->
<!-- when: answers.virtualization == "hypervisor" -->
- Dev/staging VMs live on your hypervisor<!-- when: answers.hypervisorKind --> ({{answers.hypervisorKind}})<!-- /when -->. Let the infrastructure MCP provision them from this config rather than hand-building.
<!-- /when -->
<!-- when: answers.virtualization == "none" -->
- Local-only development: document every manual setup step in the README the moment you perform it — future-you is the deployment target.
<!-- /when -->
