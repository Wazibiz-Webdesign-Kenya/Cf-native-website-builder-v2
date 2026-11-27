#!/usr/bin/env node
// Manual Lighthouse audit through Google's PageSpeed Insights API.
//
//   node scripts/lighthouse-audit.mjs <url> [<url> ...] [--desktop]
//
// PRIVACY: running this sends each URL to Google, which then loads the page.
// Nothing in the build pipeline calls it. It reports only: it never blocks a
// release. Scores vary between runs, and a preview URL can score differently
// from the live Site (its canonical points at the Site Address).
// Set PSI_API_KEY if Google rate-limits requests made without a key.

import { pathToFileURL } from "node:url";

export const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];

export function buildRequestUrl(pageUrl, { strategy = "mobile", apiKey } = {}) {
  const endpoint = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  endpoint.searchParams.set("url", pageUrl);
  endpoint.searchParams.set("strategy", strategy);
  for (const category of CATEGORIES) endpoint.searchParams.append("category", category);
  if (apiKey) endpoint.searchParams.set("key", apiKey);
  return endpoint.toString();
}

/** Category scores (0-100, null when not scored) plus the failing audits. */
export function summarize(payload) {
  const result = payload?.lighthouseResult;
  if (!result?.categories) throw new Error("response carries no Lighthouse result");
  const scores = {};
  const failing = [];
  for (const id of CATEGORIES) {
    const category = result.categories[id];
    scores[id] = typeof category?.score === "number" ? Math.round(category.score * 100) : null;
    for (const ref of category?.auditRefs ?? []) {
      const audit = result.audits?.[ref.id];
      if (ref.weight > 0 && typeof audit?.score === "number" && audit.score < 0.9) {
        failing.push(`${id}: ${audit.title}`);
      }
    }
  }
  return { scores, failing };
}

async function main(args) {
  const strategy = args.includes("--desktop") ? "desktop" : "mobile";
  const urls = args.filter((arg) => !arg.startsWith("--"));
  if (urls.length === 0 || urls.some((url) => !/^https:\/\//.test(url))) {
    console.error("usage: node scripts/lighthouse-audit.mjs <https url> [...] [--desktop]");
    return 2;
  }
  let failed = false;
  for (const url of urls) {
    console.log(`\n${url} (${strategy})`);
    try {
      const response = await fetch(buildRequestUrl(url, { strategy, apiKey: process.env.PSI_API_KEY }));
      if (!response.ok) throw new Error(`PageSpeed Insights returned HTTP ${response.status}`);
      const { scores, failing } = summarize(await response.json());
      for (const [id, score] of Object.entries(scores)) console.log(`  ${id}: ${score ?? "not scored"}`);
      for (const line of failing) console.log(`  - ${line}`);
    } catch (error) {
      failed = true;
      console.error(`  audit failed: ${error.message}`);
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
