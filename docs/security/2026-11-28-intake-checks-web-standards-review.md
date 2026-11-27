# Security and correctness review: intake checks, web standards, builder v11, gateway headers

**Date:** 2026-11-28
**Scope:** `f0095f2..` on `feat/intake-checks-web-standards`
**Reviewer:** AI-assisted manual review (Claude Code). The `morabeza-cso` skill was not available in this environment, so this is a **substitute, not a `/morabeza-cso` pass**. It is not an external audit.

## Verdict

No blocking finding.

## Checked

| Area | Result |
|---|---|
| Intake email confirmation | Requires the boolean `true`; a string is rejected (tested). It never skips the text checks. Both conversion and recovery pass through the same check before anything is frozen. The admin routes keep their existing Access guard. |
| Structured data injection | `<` is escaped in the JSON, so a Business Fact containing `</script>` stays inside the block (tested). `sameAs` accepts only `http(s)` URLs. Builder-written JSON-LD is removed. |
| Contact detail exposure | Email, phone and street address enter structured data only when the pages already show them. |
| Canonical, robots, sitemap | URLs come from the stored Site Address, not from browser input or model output. |
| Gateway headers | A header set by the origin wins. `set-cookie` is still removed. HSTS is 300 seconds with no `includeSubDomains` or preload. No script or style CSP. |
| Builder form contract | The phone-or-email contract matches the Form Service already in production. No delivery-control field was added. |
| Bundle QA additions | Warnings only: no new release blocker or mandatory gate. |
| Lighthouse script | Manual only; nothing in the pipeline calls it. Running it sends the audited URL to Google. HTTPS URLs only. |
| Secrets and personal data | Pattern scan of the added lines: no secrets; example-domain email addresses only. |
| Persistence | No migration added; the remote database reported none pending. |

## Fixed during review

- Structured data copied the meta description with HTML entities intact, so `&amp;` was published literally, and a visible street address containing `&` was not recognised. Both are now decoded in one pass, with a test.

## Watch items (not blocking)

- The intake checks match known phrases. Differently worded research notes pass, so operator review is still needed.
- Revision fact updates and direct submission routes do not run the intake checks.
- `scripts/lighthouse-audit.mjs` has no test in the repository.
- Raise the HSTS lifetime only after live Sites and forms are verified.

## Test evidence

- Typecheck passes on each commit.
- Full suite on this Windows machine, before the entity fix: 732 passed, 3 failed. The same three tests (lifecycle first Build, retention sweep protection, email retry sweep) fail on a clean copy of `f0095f2` on this machine, run for 90 seconds or more there, and pass in CI on that commit.
- The two `v2-qa-capture-marker` tests failed locally on this work because their module mock did not apply. The suite now spies on the adapter object.
- The CI run on the pull request is the full-suite record for the final tree.
