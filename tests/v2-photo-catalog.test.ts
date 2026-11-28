// Supplied photos are described before design (FDR decision 139), and what
// each really shows is the only thing the site may say about it.

import { describe, expect, it } from "vitest";
import { env as providedEnv } from "cloudflare:test";
import type { Env } from "../src/env.d";
import { startSiteGeneration, createInitialBuild } from "../src/domain/lifecycle";
import { runBuildPipeline } from "../src/domain/build-pipeline";
import { matchImportsToSlots, type FetchedImport } from "../src/domain/image-import";
import type { ImageSlot } from "../src/domain/site-contracts";
import { AiStageSchemaInvalidError, rejectedReplyKey, type RawAiGenerate } from "../src/domain/ai-boundary";
import {
  PhotoCatalogError,
  ensurePhotoCatalog,
  preferredImportsBySlot,
  renderPhotoCatalogForBlueprint,
} from "../src/simple-design/photo-catalog";
import { applyPhotoAlt } from "../src/domain/web-standards";
import { findServiceCountMismatches, findUnsupportedPromises } from "../src/simple-design/bundle-qa";
import { buildVersionSourceKey } from "../src/domain/artifact-keys";
import { getObject } from "../src/lib/assets";
import { encodePng } from "../src/lib/png-codec";
import { canonicalStructuredFacts } from "./helpers/canonical-facts";
import { createSimpleScripts } from "./helpers/simple-scripts";

const env = providedEnv as unknown as Env;
const CATALOG_PROMPT = /photo numbers are: ([\d, ]+)\./;

function describeReply(user: string, options: { skip?: number } = {}): string {
  const numbers = CATALOG_PROMPT.exec(user)![1]!.split(",").map((value) => Number(value.trim()));
  return JSON.stringify({
    photos: numbers
      .filter((number) => number !== options.skip)
      .map((number) => ({
        number,
        shows: `Supplied photo ${number}: a white entrance gate beside tall trees.`,
        alt: `Photo ${number} — a "white" gate & trees`,
        people: "none",
      })),
  });
}

const reply = (content: string) => ({ content, provider: "simple-script", model: "glm-5.3-flash" });

async function generationWithPhotos(count: number) {
  const images = [];
  for (let index = 0; index < count; index++) {
    const r2Key = `imports/drafts/catalog-${crypto.randomUUID()}/${index}.png`;
    await env.SITE_BUCKET.put(r2Key, await encodePng({ width: 800, height: 600, rgb: new Uint8Array(800 * 600 * 3).fill(40 + index) }));
    images.push({ r2Key });
  }
  const started = await startSiteGeneration(env, {
    payload: {
      buildMode: "ORIGINAL_DESIGN",
      facts: { businessName: "Gate Gardens", contactEmail: "hello@gate.example", ...canonicalStructuredFacts() },
      creativeDirection: { direction: "Calm photo-led garden venue" },
      imageImport: { policy: "IMPORTED_ONLY", images },
    },
  });
  const row = await env.DB.prepare("SELECT onboarding_submission_id AS id FROM site_generations WHERE id = ?")
    .bind(started.siteGenerationId)
    .first<{ id: string }>();
  return { siteGenerationId: started.siteGenerationId, submissionId: row!.id };
}

describe("photo catalog", () => {
  async function context(count: number) {
    const generation = await generationWithPhotos(count);
    const build = await createInitialBuild(env, { siteGenerationId: generation.siteGenerationId });
    return { ...generation, buildId: build.buildId, buildVersionId: build.buildVersionId, buildVersionNumber: 1 };
  }

  it("describes every photo in batches, once per submission, without dashes", async () => {
    const input = await context(5);
    const prompts: string[] = [];
    const generate: RawAiGenerate = async (_system, user) => {
      prompts.push(user);
      return reply(describeReply(user));
    };
    const catalog = (await ensurePhotoCatalog(env, { ...input, generate }))!;
    expect(prompts).toHaveLength(2);
    expect(catalog.photos.map((photo) => photo.number)).toEqual([1, 2, 3, 4, 5]);
    expect(catalog.photos[0]).toMatchObject({ orientation: "landscape", alt: 'Photo 1, a "white" gate & trees' });
    expect(renderPhotoCatalogForBlueprint(catalog)).toContain("[PHOTO 5] landscape");

    const again = await ensurePhotoCatalog(env, { ...input, generate });
    expect(prompts).toHaveLength(2);
    expect(again).toEqual(catalog);
  });

  it("fails closed when any photo goes undescribed", async () => {
    const input = await context(2);
    await expect(
      ensurePhotoCatalog(env, { ...input, generate: async (_system, user) => reply(describeReply(user, { skip: 2 })) })
    ).rejects.toBeInstanceOf(PhotoCatalogError);
  });

  it("keeps the raw reply of every rejected attempt for diagnosis", async () => {
    const input = await context(1);
    await expect(
      ensurePhotoCatalog(env, { ...input, generate: async () => reply('{"photos":[]} and then more') })
    ).rejects.toBeInstanceOf(AiStageSchemaInvalidError);
    const runs = await env.DB.prepare("SELECT run_id, attempt FROM ai_stage_runs WHERE build_id = ? ORDER BY attempt")
      .bind(input.buildId)
      .all<{ run_id: string; attempt: number }>();
    expect(runs.results).toHaveLength(2);
    for (const run of runs.results) {
      const body = await getObject(env, rejectedReplyKey(input.buildId, 1, "simple-photo-catalog", run.run_id, run.attempt));
      expect(await new Response(body).text()).toBe('{"photos":[]} and then more');
    }
  });

  it("binds the photo a slot was designed around, whatever its shape", () => {
    const slot = (id: string): ImageSlot => ({ id, page: "home", semanticRole: "r", blueprintRole: "r", priority: "CRITICAL", orientation: "portrait", negativeSpaceForText: false });
    const image = (index: number, width: number, height: number): FetchedImport => ({ index, url: `u${index}`, bytes: new Uint8Array(), dimensions: { width, height } });
    const preferred = preferredImportsBySlot([
      { slotId: "a", brief: "[PHOTO 2] the gate" },
      { slotId: "b", brief: "[photo 2] the gate again" },
      { slotId: "c", brief: "no tag" },
    ]);
    const assignments = matchImportsToSlots([slot("a"), slot("b"), slot("c")], [image(0, 600, 900), image(1, 900, 600)], "IMPORTED_ONLY", preferred);
    const bySlot = Object.fromEntries(assignments.map((entry) => [entry.slotId, entry.importIndex]));
    expect(bySlot).toMatchObject({ a: 1, b: 1, c: 0 });
  });

  it("writes supplied-photo alt text over the model's, keeping decorative uses empty", () => {
    const alt = new Map([["assets/images/a.webp", 'A "gate" & $1 trees']]);
    const html = `<img src="assets/images/a.webp" alt="A family picnic"><img src="assets/images/a.webp" alt=""><img src="assets/images/a.webp"><img src="assets/images/b.webp" alt="kept">`;
    const written = `alt="A &quot;gate&quot; &amp; $1 trees"`;
    expect(applyPhotoAlt(html, alt)).toBe(
      `<img src="assets/images/a.webp" ${written}><img src="assets/images/a.webp" alt=""><img src="assets/images/a.webp" ${written}><img src="assets/images/b.webp" alt="kept">`
    );
  });

  it("builds from what the photos show, end to end", async () => {
    const { siteGenerationId } = await generationWithPhotos(2);
    const scripts = createSimpleScripts();
    const seen: string[] = [];
    const scripted = (inner: RawAiGenerate): RawAiGenerate => async (system, user, attempt) => {
      seen.push(user);
      return CATALOG_PROMPT.test(user) ? reply(describeReply(user)) : inner(system, user, attempt);
    };
    const outcome = await runBuildPipeline(env, {
      siteGenerationId,
      deps: {
        ...scripts,
        ...(scripts.generate ? { generate: scripted(scripts.generate) } : {}),
        ...(scripts.visionGenerate ? { visionGenerate: scripted(scripts.visionGenerate) } : {}),
      },
    });
    expect(outcome.terminal).toBe("RELEASE_READY");

    expect(seen.findIndex((user) => CATALOG_PROMPT.test(user))).toBe(0);
    expect(seen[1]).toContain("SUPPLIED PHOTOGRAPHS");
    expect(seen[1]).toContain("a white entrance gate beside tall trees");
    const builder = seen.find((user) => user.includes('Realize the "home" page'))!;
    expect(builder).toContain("REAL PHOTO, shows: Supplied photo");
    expect(builder).toContain("PHOTO TRUTH (hard rule");
    expect(seen.find((user) => user.includes("Judge the CANDIDATE renders"))).toContain("SUPPLIED REAL PHOTOS");

    const home = await new Response(
      await getObject(env, buildVersionSourceKey(outcome.buildId, 1, "index.html"))
    ).text();
    const alts = [...home.matchAll(/<img\b[^>]*\salt="([^"]*)"/g)].map((match) => match[1]).filter(Boolean);
    expect(alts.length).toBeGreaterThan(0);
    for (const alt of alts) expect(alt).toMatch(/^Photo [12], a &quot;white&quot; gate &amp; trees$/);
  });
});

describe("unsupported claim checks", () => {
  const facts = { businessName: "Gate Gardens", contactEmail: "a@gate.example", ...canonicalStructuredFacts() };

  it("flags invented promises and customer claims, not ordinary invitations", () => {
    for (const claim of [
      "We reply personally to every enquiry.",
      "We will respond within 24 hours.",
      "Most of our guests come from Nairobi and Ngong.",
    ]) {
      expect(findUnsupportedPromises(claim, facts), claim).toHaveLength(1);
    }
    for (const fine of ["Send us a message and tell us your date.", "Ask us about your occasion.", "Our garden is open daily."]) {
      expect(findUnsupportedPromises(fine, facts), fine).toEqual([]);
    }
    const supplied = { ...facts, extraInformation: "We will respond within 24 hours." };
    expect(findUnsupportedPromises("We will respond within 24 hours.", supplied)).toEqual([]);
  });

  it("requires a counting heading to match the services supplied", () => {
    const count = facts.services.length;
    const words = ["", "one", "two", "three", "four", "five", "six", "seven", "eight"];
    expect(findServiceCountMismatches(`<h2>${words[count + 1]} ways to gather</h2>`, facts)).toHaveLength(1);
    expect(findServiceCountMismatches(`<h2>${words[count]} ways to gather</h2><h2>Ten minutes away</h2>`, facts)).toEqual([]);
  });
});
