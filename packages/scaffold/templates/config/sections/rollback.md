## Rollback Procedures

<!-- when: answers.skillLevel == "beginner" -->
- Git is your rollback: commit small and often; a bad release is `git revert` + redeploy.
- Before risky changes, note the last-known-good commit hash somewhere you'll find it under stress.
<!-- /when -->
<!-- when: answers.skillLevel != "beginner" -->
- Every deploy keeps the previous artifact ready to restore in one step; practice the restore before you need it.
- Database/data migrations ship with a down path, or with a documented reason why rolling forward is the only option.
<!-- /when -->
<!-- when: answers.virtualization == "hypervisor" -->
- VM snapshots before risky infrastructure changes — the infrastructure MCP can take and roll back snapshots on request.
<!-- /when -->
