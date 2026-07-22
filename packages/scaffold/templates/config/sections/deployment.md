## Production Deployment

<!-- when: answers.projectType == "library" -->
- "Deployment" is publishing: version with semver, tag releases, generate a changelog, publish from CI only.
<!-- /when -->
<!-- when: answers.projectType != "library" -->
<!-- when: answers.virtualization == "docker" -->
- Deploy the image you tested — build once, promote the same artifact through staging to production.
- Keep container config in env vars; the image itself is environment-agnostic.
<!-- /when -->
<!-- when: answers.virtualization == "hypervisor" -->
- Production runs on its own VM, provisioned like staging. Deploy by replacing the app artifact, not by mutating the machine in place.
<!-- /when -->
<!-- when: answers.virtualization == "none" -->
- Direct deployment: script it end to end (build → verify → copy → restart) so a release is one command, and keep the previous build alongside for instant rollback.
<!-- /when -->
<!-- /when -->
