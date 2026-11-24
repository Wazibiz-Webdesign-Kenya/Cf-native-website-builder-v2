import { canonicalStructuredFacts } from "./helpers/canonical-facts";
import { describe, expect, it } from "vitest";
import { env as providedEnv } from "cloudflare:test";
import type { Env } from "../src/env.d";
import { startSiteGeneration, createInitialBuild } from "../src/domain/lifecycle";
import { importImagesForVersion, matchImportsToSlots, type FetchedImport } from "../src/domain/image-import";
import { getAcceptedImageMap } from "../src/domain/image-pipeline";
import { validateOnboardingSubmissionPayload } from "../src/domain/lifecycle-schema";
import type { ImageSlot } from "../src/domain/site-contracts";
import { encodePng } from "../src/lib/png-codec";

const env = providedEnv as unknown as Env;

function slot(overrides: Partial<ImageSlot> & { id: string }): ImageSlot {
  return { page: "home", semanticRole: "hero", blueprintRole: "role-hero", priority: "CRITICAL", orientation: "landscape", negativeSpaceForText: true, ...overrides };
}
const SLOTS: ImageSlot[] = [
  slot({ id: "home-hero" }),
  slot({ id: "about-hero", page: "about" }),
  slot({ id: "about-portrait", page: "about", priority: "NORMAL", orientation: "portrait" }),
];
function img(index: number, width: number, height: number, page?: FetchedImport["page"]): FetchedImport {
  return { index, url: `https://img.example/${index}.png`, bytes: new Uint8Array(), dimensions: { width, height }, ...(page ? { page } : {}) };
}

describe("matchImportsToSlots", () => {
  it("gives critical slots the conforming image and leaves unfit slots to generation", () => {
    const result = matchImportsToSlots(SLOTS, [img(0, 1600, 900), img(1, 1600, 900)], "IMPORTED_THEN_GENERATE");
    expect(result.map((r) => r.slotId).sort()).toEqual(["about-hero", "home-hero"]);
    expect(result.some((r) => r.slotId === "about-portrait")).toBe(false);
  });
  it("honours a page hint", () => {
    const result = matchImportsToSlots(SLOTS, [img(0, 1600, 900, "about"), img(1, 1600, 900, "home")], "IMPORTED_THEN_GENERATE");
    expect(result.find((r) => r.slotId === "home-hero")?.importIndex).toBe(1);
    expect(result.find((r) => r.slotId === "about-hero")?.importIndex).toBe(0);
  });
  it("IMPORTED_ONLY reuses images so every slot is filled", () => {
    const result = matchImportsToSlots(SLOTS, [img(0, 1600, 900)], "IMPORTED_ONLY");
    expect(result).toHaveLength(3);
    expect(result.filter((r) => r.reused).length).toBe(2);
  });
});

describe("importImagesForVersion", () => {
  async function build(imageImport?: unknown) {
    const started = await startSiteGeneration(env, {
      payload: {
        buildMode: "REFERENCE_BOUND",
        facts: { businessName: "Tibz", contactEmail: "hi@tibz.example", ...canonicalStructuredFacts() },
        reference: { screenshotR2Key: `references/uploads/ii-${Math.random().toString(36).slice(2)}.png` },
        ...(imageImport ? { imageImport } : {}),
      } as never,
    });
    const created = await createInitialBuild(env, { siteGenerationId: started.siteGenerationId });
    const row = await env.DB.prepare("SELECT onboarding_submission_id FROM site_generations WHERE id = ?").bind(started.siteGenerationId).first<{ onboarding_submission_id: string }>();
    return { ...created, submissionId: row!.onboarding_submission_id };
  }

  it("validates imageImport on the submission payload", () => {
    const base = { buildMode: "REFERENCE_BOUND", facts: { businessName: "T", contactEmail: "a@b.co", ...canonicalStructuredFacts() }, reference: { url: "https://x.example" } };
    expect(validateOnboardingSubmissionPayload({ ...base, imageImport: { policy: "IMPORTED_ONLY", images: [{ url: "https://a.example/1.jpg" }] } }).valid).toBe(true);
    expect(validateOnboardingSubmissionPayload({ ...base, imageImport: { policy: "IMPORTED_ONLY", images: [{ url: "http://a.example/1.jpg" }] } }).valid).toBe(false);
  });

  it("accepts fetched images as Accepted Images at zero cost, rejects bad ones, and is idempotent", async () => {
    const { buildId, buildVersionId, submissionId } = await build({
      policy: "IMPORTED_THEN_GENERATE",
      images: [{ url: "https://img.example/good.png" }, { url: "https://img.example/small.png" }, { url: "https://img.example/page.html" }],
    });
    const good = await encodePng({ width: 1600, height: 900, rgb: new Uint8Array(1600 * 900 * 3).fill(120) });
    const small = await encodePng({ width: 100, height: 100, rgb: new Uint8Array(100 * 100 * 3).fill(120) });
    const fetcher = async (url: string) =>
      url.endsWith("good.png") ? new Response(good, { headers: { "content-type": "image/png" } })
      : url.endsWith("small.png") ? new Response(small, { headers: { "content-type": "image/png" } })
      : new Response("<html>login</html>", { headers: { "content-type": "text/html" } });
    const run = () => importImagesForVersion(env, { submissionId, buildId, buildVersionId, buildVersionNumber: 1, slots: SLOTS, fetcher });

    const first = await run();
    expect(first.imported).toBe(1);
    expect(first.rejected.map((r) => r.index).sort()).toEqual([1, 2]);
    expect(first.assigned).toBe(1);
    expect(first.skipGeneration).toBe(false);
    expect((await getAcceptedImageMap(env, buildVersionId)).has("home-hero")).toBe(true);
    const spend = await env.DB.prepare("SELECT COALESCE(SUM(cost_usd),0) AS c FROM image_attempts WHERE build_id = ?").bind(buildId).first<{ c: number }>();
    expect(spend?.c).toBe(0);

    await run(); // retried workflow step converges
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM accepted_images WHERE build_version_id = ?").bind(buildVersionId).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("does nothing for a submission without imageImport", async () => {
    const { buildId, buildVersionId, submissionId } = await build();
    const result = await importImagesForVersion(env, { submissionId, buildId, buildVersionId, buildVersionNumber: 1, slots: SLOTS });
    expect(result.requested).toBe(0);
    expect(result.skipGeneration).toBe(false);
  });
});
