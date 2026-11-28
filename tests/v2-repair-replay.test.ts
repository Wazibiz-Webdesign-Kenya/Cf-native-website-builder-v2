// The Workflow engine replays run() from the top: successful steps return their
// recorded output, everything outside a step executes again against whatever
// D1 holds NOW. Live evidence 2026-11-28 (build b655023f): after repair round
// 1 created Build Version 2, a replay read "latest version = 2" as the entry
// version and ran the full Builder on the repair version. Its output was
// structurally broken and the working version 1 was abandoned.

import { describe, expect, it } from "vitest";
import { env as providedEnv } from "cloudflare:test";
import type { Env } from "../src/env.d";
import { startSiteGeneration } from "../src/domain/lifecycle";
import { runBuildPipeline } from "../src/domain/build-pipeline";
import { createInitialBuild } from "../src/domain/lifecycle";
import { createSimpleScripts, persistSimpleScreenshot, SIMPLE_SCRIPTS_BUSINESS, type SimpleScriptsOptions } from "./helpers/simple-scripts";
import { canonicalStructuredFacts } from "./helpers/canonical-facts";

const env = providedEnv as unknown as Env;

const EVICTION = "simulated isolate eviction";

async function startBuild(name: string): Promise<{ siteGenerationId: string; buildId: string }> {
  const screenshotKey = `references/replay/${name}.png`;
  await persistSimpleScreenshot(env, screenshotKey);
  const started = await startSiteGeneration(env, {
    payload: {
      buildMode: "REFERENCE_BOUND",
      facts: {
        businessName: SIMPLE_SCRIPTS_BUSINESS,
        contactEmail: "ops@rankforge.example",
        businessType: "SEO agency",
        businessDescription: "An SEO agency in Nairobi helping Kenyan businesses grow.",
        ...canonicalStructuredFacts(),
      },
      reference: { screenshotR2Key: screenshotKey, url: "https://reference.example.com/" },
    },
  });
  const build = await createInitialBuild(env, { siteGenerationId: started.siteGenerationId });
  return { siteGenerationId: started.siteGenerationId, buildId: build.buildId };
}

/** One script set across both invocations, with call counters and ONE
 *  simulated eviction at the first call the predicate matches. */
function evictingScripts(options: SimpleScriptsOptions, evictAt: (userPrompt: string, calls: Counts) => boolean) {
  const calls: Counts = { builderHome: 0, visualQa: 0, repair: 0 };
  const scripts = createSimpleScripts(options);
  const inner = scripts.generate!;
  let evicted = false;
  const generate: typeof inner = async (system, user, attempt) => {
    const isBuilderHome = user.includes('Realize the "home" page');
    const isVisualQa = user.includes("Compare the CANDIDATE renders against the REFERENCE screenshots");
    const isRepair = user.includes("QA PACKAGE (complete repair brief)");
    if (isBuilderHome) calls.builderHome += 1;
    if (isVisualQa) calls.visualQa += 1;
    if (isRepair) calls.repair += 1;
    if (!evicted && evictAt(user, calls)) {
      evicted = true;
      throw new Error(EVICTION);
    }
    return inner(system, user, attempt);
  };
  return { deps: { ...scripts, generate, visionGenerate: generate }, calls, wasEvicted: () => evicted };
}

interface Counts {
  builderHome: number;
  visualQa: number;
  repair: number;
}

function engineSteps() {
  const cache = new Map<string, unknown>();
  return async <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
    if (cache.has(name)) return cache.get(name) as T;
    const result = await fn();
    cache.set(name, result);
    return result;
  };
}

async function versionsOf(buildId: string) {
  const rows = await env.DB.prepare("SELECT version_number FROM build_versions WHERE build_id = ? ORDER BY version_number")
    .bind(buildId)
    .all<{ version_number: number }>();
  return rows.results.map((row) => row.version_number);
}

const isRepairPrompt = (user: string) => user.includes("QA PACKAGE (complete repair brief)");

describe("engine replay during repair rounds", () => {
  it("an eviction inside the repair call resumes the REPAIR: the Builder never runs on the repair version", async () => {
    const ids = await startBuild("mid-repair");
    const { deps, calls, wasEvicted } = evictingScripts({ firstVisualQaFails: true }, (user) => isRepairPrompt(user));
    const step = engineSteps();
    await expect(runBuildPipeline(env, { ...ids, deps: { ...deps, step: step as never } })).rejects.toThrow(EVICTION);
    expect(wasEvicted()).toBe(true);

    const resumed = await runBuildPipeline(env, { ...ids, deps: { ...deps, step: step as never } });

    expect({ terminal: resumed.terminal, reasons: resumed.reasons }).toEqual({ terminal: "RELEASE_READY", reasons: [] });
    expect(calls.builderHome).toBe(1);
    expect(await versionsOf(ids.buildId)).toEqual([1, 2]);
  });

  it("a restart with NO step cache while the repair version is still empty repairs it, never rebuilds it", async () => {
    const ids = await startBuild("cold-restart");
    const { deps, calls } = evictingScripts({ firstVisualQaFails: true }, (user) => isRepairPrompt(user));
    await expect(runBuildPipeline(env, { ...ids, deps })).rejects.toThrow(EVICTION);

    const resumed = await runBuildPipeline(env, { ...ids, deps });

    expect({ terminal: resumed.terminal, reasons: resumed.reasons }).toEqual({ terminal: "RELEASE_READY", reasons: [] });
    expect(calls.builderHome).toBe(1);
    expect(await versionsOf(ids.buildId)).toEqual([1, 2]);
  });

  it("an eviction in the LAST allowed round still completes that round instead of reporting the budget spent", async () => {
    const ids = await startBuild("last-round");
    const { deps, calls } = evictingScripts(
      { visualQaOverallSequence: [60, 70, 80, 93] },
      (user, counts) => isRepairPrompt(user) && counts.repair === 3
    );
    const step = engineSteps();
    await expect(runBuildPipeline(env, { ...ids, deps: { ...deps, step: step as never } })).rejects.toThrow(EVICTION);

    const resumed = await runBuildPipeline(env, { ...ids, deps: { ...deps, step: step as never } });

    expect({ terminal: resumed.terminal, reasons: resumed.reasons }).toEqual({ terminal: "RELEASE_READY", reasons: [] });
    expect(calls.builderHome).toBe(1);
    expect(await versionsOf(ids.buildId)).toEqual([1, 2, 3, 4]);
  });

  it("an eviction after the pre-QA repair version exists resumes it instead of failing the Build", async () => {
    const ids = await startBuild("pre-qa");
    const { deps, calls, wasEvicted } = evictingScripts(
      { builderInventsCssSelectors: true, preQaRepairSucceeds: true },
      (user) => user.includes("Compare the CANDIDATE renders")
    );
    const step = engineSteps();
    await expect(runBuildPipeline(env, { ...ids, deps: { ...deps, step: step as never } })).rejects.toThrow(EVICTION);
    expect(wasEvicted()).toBe(true);

    const resumed = await runBuildPipeline(env, { ...ids, deps: { ...deps, step: step as never } });

    expect({ terminal: resumed.terminal, reasons: resumed.reasons }).toEqual({ terminal: "RELEASE_READY", reasons: [] });
    expect(calls.builderHome).toBe(1);
    expect(await versionsOf(ids.buildId)).toEqual([1, 2]);
  });
});

describe("a repair that breaks the page structure", () => {
  it("is rejected: no bundle is stored and the last working version stays the latest candidate", async () => {
    const ids = await startBuild("broken-repair");
    const scripts = createSimpleScripts({ allVisualQaFails: true });
    const inner = scripts.generate!;
    const generate: typeof inner = async (system, user, attempt) => {
      const reply = await inner(system, user, attempt);
      if (!isRepairPrompt(user)) return reply;
      const parsed = JSON.parse(reply.content) as { files: Array<{ content: string }> };
      parsed.files[0].content = parsed.files[0].content.replace("</section>", "");
      return { ...reply, content: JSON.stringify(parsed) };
    };

    const outcome = await runBuildPipeline(env, { ...ids, deps: { ...scripts, generate, visionGenerate: generate } });

    expect(outcome.terminal).toBe("HUMAN_REVIEW_REQUIRED");
    expect(outcome.reasons[0]).toContain("repair round 1 rejected: it broke the page structure");
    expect(outcome.reasons[0]).toContain("Build Version v1 remains the latest candidate");
    expect(outcome.reasons.join("; ")).toMatch(/home: <section> opened \d+x but closed \d+x/);
    expect(outcome.previewUrl).toContain("-v1.");
    expect(await versionsOf(ids.buildId)).toEqual([1, 2]);
    const bundles = await env.DB.prepare(
      "SELECT v.version_number AS n FROM build_stage_artifacts a JOIN build_versions v ON v.id = a.build_version_id WHERE a.build_id = ? AND a.kind = 'site_bundle'"
    )
      .bind(ids.buildId)
      .all<{ n: number }>();
    expect(bundles.results.map((row) => row.n)).toEqual([1]);
    const state = await env.DB.prepare("SELECT state FROM builds WHERE id = ?").bind(ids.buildId).first<{ state: string }>();
    expect(state?.state).toBe("HUMAN_REVIEW_REQUIRED");
  });
});
