## Monitoring and Observability

<!-- when: answers.skillLevel == "beginner" -->
- Log every error with enough context to reproduce it (inputs, not just the message). Structured logging can wait; useful logging cannot.
- Check the logs after each deploy — that habit is the whole practice at this stage.
<!-- /when -->
<!-- when: answers.skillLevel == "intermediate" -->
- Structured logs (JSON) with a request/job id threaded through block boundaries.
- Track the three basics: error rate, latency of the hot path, and a liveness signal.
<!-- /when -->
<!-- when: answers.skillLevel == "advanced" -->
- Structured logs + metrics + health endpoints; alert on symptoms (user-visible failures), not causes.
- Every block's contract failure mode should be observable — if a block can fail silently, its contract is incomplete.
<!-- /when -->
