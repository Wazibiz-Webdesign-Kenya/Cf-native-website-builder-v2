// A structured reply that ends early is valid JSON with its last sections
// missing (live Design Blueprint replies, 2026-11-28: every property present
// validated; the object was simply closed too soon, once with three keys one
// level too high). The ONE structural repair then completes it.

import { describe, expect, it } from "vitest";
import { env as providedEnv } from "cloudflare:test";
import { Type } from "@sinclair/typebox";
import type { Env } from "../src/env.d";
import { AiStageSchemaInvalidError, renestMisplacedKeys, runSchemaValidatedAiStage, type RawAiGenerate } from "../src/domain/ai-boundary";
import { startSiteGeneration, createInitialBuild } from "../src/domain/lifecycle";
import { canonicalStructuredFacts } from "./helpers/canonical-facts";

const env = providedEnv as unknown as Env;

const text = Type.String({ minLength: 1 });
const Schema = Type.Object(
  {
    title: text,
    chrome: Type.Object({ header: text, footer: text }, { additionalProperties: false }),
    pages: text,
    checklist: text,
  },
  { additionalProperties: false }
);
const COMPLETE = { title: "T", chrome: { header: "H", footer: "F" }, pages: "P", checklist: "C" };

async function run(replies: unknown[]) {
  const started = await startSiteGeneration(env, {
    payload: {
      buildMode: "ORIGINAL_DESIGN",
      facts: { businessName: "Completion", contactEmail: "a@completion.example", ...canonicalStructuredFacts() },
      creativeDirection: { direction: "Calm" },
    },
  });
  const build = await createInitialBuild(env, { siteGenerationId: started.siteGenerationId });
  const prompts: string[] = [];
  const generate: RawAiGenerate = async (_system, user) => {
    prompts.push(user);
    return { content: JSON.stringify(replies[prompts.length - 1]), provider: "test", model: "test" };
  };
  const result = runSchemaValidatedAiStage<typeof COMPLETE>(env, {
    stage: "simple-photo-catalog",
    schema: Schema,
    schemaVersion: "completion-test/1",
    userPrompt: "Produce the document.",
    buildId: build.buildId,
    buildVersionId: build.buildVersionId,
    buildVersionNumber: 1,
    generate,
  });
  return { result, prompts };
}

describe("structural completion of an early-ended reply", () => {
  it("moves a key written one level too high into its only home", () => {
    expect(renestMisplacedKeys(Schema, { title: "T", chrome: { header: "H" }, footer: "F" })).toEqual({ title: "T", chrome: { header: "H", footer: "F" } });
    // Unknown keys with no home, or one already filled, are left for validation to reject.
    const kept = { title: "T", chrome: { header: "H", footer: "F" }, footer: "other", mystery: 1 };
    expect(renestMisplacedKeys(Schema, kept)).toEqual(kept);
  });

  it("asks the one repair only for the missing sections and keeps the first reply's work", async () => {
    const { result, prompts } = await run([
      { title: "T", chrome: { header: "H" }, footer: "F" },
      { pages: "P", checklist: "C", title: "rewritten" },
    ]);
    const accepted = await result;
    expect(accepted.value).toEqual(COMPLETE);
    expect(accepted.attempts.map((attempt) => attempt.outcome)).toEqual(["invalid", "repaired"]);
    expect(prompts[1]).toContain("ONLY these top-level properties: pages, checklist");
    expect(prompts[1]).toContain('"header":"H"');
  });

  it("still fails after the one repair when the completion also ends early", async () => {
    const { result, prompts } = await run([{ title: "T", chrome: COMPLETE.chrome }, { pages: "P" }]);
    await expect(result).rejects.toBeInstanceOf(AiStageSchemaInvalidError);
    expect(prompts).toHaveLength(2);
  });

  it("redoes only the section that broke a constraint, showing the model what it wrote", async () => {
    const { result, prompts } = await run([
      { ...COMPLETE, chrome: { header: 5, footer: "F" } },
      { chrome: COMPLETE.chrome, pages: "rewritten" },
    ]);
    expect((await result).value).toEqual(COMPLETE);
    expect(prompts[1]).toContain("ONLY these top-level properties: chrome.");
    expect(prompts[1]).toContain("/chrome/header: Expected string");
    expect(prompts[1]).toContain('{"chrome":{"header":5,"footer":"F"}}');
  });

  it("asks for the whole document again when nothing in the reply is sound", async () => {
    const { result, prompts } = await run([{ title: 5 }, COMPLETE]);
    expect((await result).value).toEqual(COMPLETE);
    expect(prompts[1]).toContain("Return ONLY the corrected JSON object");
    expect(prompts[1]).not.toContain("ONLY these top-level properties");
  });
});
