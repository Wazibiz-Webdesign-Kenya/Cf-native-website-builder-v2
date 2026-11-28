# Review: supplied photo catalog and truth gates

**Date:** 2026-11-28
**Reviewer:** AI-assisted manual review (Claude Code). `morabeza-cso` was not available; this is a substitute, not a `/morabeza-cso` pass.

## Verdict

No blocking finding.

## Checked

- **Photos sent to the model provider:** supplied photos now go to the same Z.AI multimodal model already used for page screenshots, downscaled to 1024 px where the Images binding is available. Supplied photos can show identifiable people.
- **Text inside a photo:** a photo could carry text written to steer the model. The reply is schema-bound with bounded lengths, alt text is attribute-escaped at assembly (tested), and the result reaches the other stages as descriptive data.
- **Fail closed:** an undescribed photo or invalid reply stops the Build for human review (tested).
- **Fetching:** the catalog reuses the existing import loader and its size, type and timeout limits.
- **Contrast measurement:** runs only against the Build's own preview. It adds screenshots to each mobile capture. If it cannot run, the capture records no result and logs a warning; it is not counted as measured.
- **Persistence:** no migration. The catalog is one immutable R2 object per submission.

## Verified against real pages

The contrast check, run in a real browser against the two failed Tibz previews of 2026-11-28, reported the invisible services headline, intro text and header wordmark, and reported nothing on the two pages that looked correct. A first version using full-page screenshots reported solid buttons falsely and was replaced.

## Watch items

- Captions are constrained and judged, not proven by code.
- Claim patterns catch known phrasings only.
- A contrast measurement that fails does not block a release.

## Addendum: rejected replies and structural completion (decision 140)

Same substitute review. No blocking finding. Rejected replies are stored under the Build's own R2 prefix; they can contain Business Facts, as accepted artifacts already do, and nothing reads them. Completion takes only the missing properties from the second reply and the merged object passes the unchanged schema and quality gates. The attempt ceiling stays two (tested).
