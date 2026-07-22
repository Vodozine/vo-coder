## Staging / Pre-Production Validation

<!-- when: answers.virtualization == "hypervisor" -->
- Stage on a dedicated VM<!-- when: answers.hypervisorKind --> on {{answers.hypervisorKind}}<!-- /when --> that mirrors production. Provision it from this config via the infrastructure MCP; never hand-configure.
- Promotion rule: nothing reaches production that didn't run in staging first, including migrations.
<!-- /when -->
<!-- when: answers.virtualization == "docker" -->
- Staging is the production compose file pointed at staging data. Same images, different env — configuration is the only variable.
<!-- /when -->
<!-- when: answers.virtualization == "none" -->
- No virtualization available: your staging path is a clean checkout + full test suite + a manual smoke script. Write that smoke script now and keep it current.
<!-- /when -->
