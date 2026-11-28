# Review: replay-safe repair rounds, repair structure guard, Builder prompt v12 (2026-11-28)

**This is a manual substitute review, not a `/morabeza-cso` pass.** That skill was not available in this session.

Scope: `src/simple-design/pipeline.ts`, `src/simple-design/site-repair.ts`, `src/domain/technical-preflight.ts`, `v2-docs/prompts/simple/02-website-builder.md` (decision 141).

| Area | Finding |
|---|---|
| Injection | The new entry-version query binds both values. No request input reaches it. |
| Secrets and exposure | None added. Rejection reasons contain only page ids and tag counts. |
| Spend and loops | No new model call, retry or round. A rejected repair ends the Build. The change removes an unplanned full Builder run on replay. |
| Immutability | Versions are still new rows. An existing version is adopted by number and never rewritten. A rejected repair stores no bundle, so one version number can be left empty. |
| Gates | Technical Preflight runs the same structure checks through one shared function. Nothing is relaxed. |

Known limits, not changed here:

- Events written outside durable steps (for example the Blueprint event) are written again on each replay, so the event timeline can repeat entries.
- The structure guard counts tags. It does not parse HTML, so a mis-nested but balanced document passes it and is left to rendering QA.
- A repair that is sound in structure but cannot be judged visually can still be the source of the next round.
- The prompt rules guide the model. The truth checks and the pixel contrast check remain the enforcement.
- A `console.log("DEBUG PREQA2 STACK")` from issue #14 remains in `pipeline.ts`.
