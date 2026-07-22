## Testing Strategy

Test points live at every module connection point — that is the payoff of the
block structure. A block without a test hook is not done.

<!-- when: answers.skillLevel == "beginner" -->
- Start with **one test per block** that exercises its contract end to end. Copy the pattern; don't study testing theory first.
- Run the suite before every commit. A red test is information, not failure.
<!-- /when -->
<!-- when: answers.skillLevel == "intermediate" -->
- Unit tests per block contract + integration tests where blocks join. Aim for fast feedback (whole suite under a minute).
- Fixture/golden-file tests beat mocks when the block talks to an external format.
<!-- /when -->
<!-- when: answers.skillLevel == "advanced" -->
- Unit + integration + a thin end-to-end smoke path. Property-based tests where invariants exist.
- Contract tests at block boundaries so refactors inside a block can't break consumers silently.
<!-- /when -->
<!-- when: answers.projectType == "backend-service" -->
- Service note: every endpoint gets a request/response test; run integration tests against the containerized service, not an in-process approximation, before release.
<!-- /when -->
<!-- when: answers.projectType == "data-processing" -->
- Data note: keep small representative input fixtures in the repo; test transforms on them and assert on full output snapshots.
<!-- /when -->
