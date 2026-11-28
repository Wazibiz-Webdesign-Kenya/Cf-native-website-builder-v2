# Review: correcting a converted draft during recovery

**Date:** 2026-11-28
**Reviewer:** AI-assisted manual review (Claude Code). `morabeza-cso` was not available; this is a substitute, not a `/morabeza-cso` pass.

## Verdict

No blocking finding.

## Checked

- The lock opens only when the draft's governed generation is the Site's latest and its latest Build is FAILED, DEGRADED or HUMAN_REVIEW_REQUIRED. A generation without a Build, or with a running one, stays locked (tested).
- The editor page and the API use the same function, `isDraftRecoveryOpen`.
- A draft edit cannot change the Reference (tested). Build Mode is not an editable field.
- The earlier Onboarding Submission is unchanged after an edit and recovery (tested).
- Recovery still runs the canonical validation and the publish checks.
- The route keeps its existing Access guard. No migration.
- Fixed along the way: the editor save script read two inputs that the page never rendered, so Save threw before sending. A test now checks that every field the script reads without a guard exists on the page.

## Watch item

- An edit that lands while a recovery start is in flight only affects the draft. The submission is frozen from the payload read by that start.
