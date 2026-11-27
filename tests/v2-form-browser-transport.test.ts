import { describe, expect, it } from "vitest";
import { env as providedEnv } from "cloudflare:test";
import { Hono } from "hono";
import type { Env } from "../src/env.d";
import { preflightForm, submitForm } from "../src/routes/v2.form-submit";
import { startSiteGeneration, createInitialBuild } from "../src/domain/lifecycle";
import { composeLeadEmailText, normalizeLooseFormFields, parseBrowserFormPayload, upsertSiteConfiguration } from "../src/domain/form-service";
import { PLATFORM_SITE_SCRIPT } from "../src/domain/platform-site-script";
import { canonicalStructuredFacts } from "./helpers/canonical-facts";

// Browser-transport regression (2026-11-24): generated sites posted urlencoded
// from another origin to a JSON-only, CORS-less endpoint, with extra fields
// the strict contract rejected and an optional email it required.

const env = providedEnv as unknown as Env;
const ORIGIN = "https://tibz.example";

function app(): Hono<{ Bindings: Env }> {
  const a = new Hono<{ Bindings: Env }>();
  a.post("/api/v2/forms/submit", submitForm);
  a.on("OPTIONS", "/api/v2/forms/submit", preflightForm);
  return a;
}

async function site(): Promise<string> {
  const started = await startSiteGeneration(env, {
    payload: {
      buildMode: "REFERENCE_BOUND",
      facts: { businessName: "Tibz", contactEmail: "hello@tibz.example", ...canonicalStructuredFacts() },
      reference: { screenshotR2Key: `references/uploads/bt-${Math.random().toString(36).slice(2)}.png` },
    },
  });
  await createInitialBuild(env, { siteGenerationId: started.siteGenerationId });
  await upsertSiteConfiguration(env, { siteId: started.siteId, formDestination: "owner@tibz.example", allowedOrigins: [ORIGIN] });
  return started.siteId;
}

describe("form browser transport", () => {
  it("answers the CORS preflight", async () => {
    const res = await app().request("https://f.example/api/v2/forms/submit", { method: "OPTIONS", headers: { Origin: ORIGIN } }, env);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("content-type");
  });

  it("accepts a plain urlencoded post with extra fields and redirects back", async () => {
    const siteId = await site();
    const body = new URLSearchParams({ siteFormId: `site:${siteId}`, name: "Amina", phone: "0722000111", email: "", "event-type": "Wedding", "preferred-date": "2026-12-12", message: "Viewing please" });
    const res = await app().request(
      "https://f.example/api/v2/forms/submit",
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", Origin: ORIGIN, Referer: `${ORIGIN}/contact`, "CF-Connecting-IP": "203.0.113.50" }, body },
      env
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/contact?form=sent#enquiry`);
    const row = await env.DB.prepare("SELECT visitor_message, visitor_phone, visitor_email FROM form_submissions WHERE site_id = ?").bind(siteId).first<{ visitor_message: string; visitor_phone: string; visitor_email: string }>();
    expect(row?.visitor_message).toContain("Event type: Wedding");
    expect(row?.visitor_message).toContain("Preferred date: 2026-12-12");
    expect(row?.visitor_phone).toBe("0722000111");
    expect(row?.visitor_email).toBe("");
  });

  it("returns CORS headers on a JSON submission", async () => {
    const siteId = await site();
    const res = await app().request(
      "https://f.example/api/v2/forms/submit",
      { method: "POST", headers: { "content-type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.51" }, body: JSON.stringify({ siteFormId: `site:${siteId}`, name: "A", email: "a@b.example", message: "hi" }) },
      env
    );
    expect(res.status).toBe(202);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("still rejects delivery-control fields and requires email or phone", () => {
    expect(() => parseBrowserFormPayload(normalizeLooseFormFields({ siteFormId: "site:x", name: "A", email: "a@b.example", message: "m", recipient: "evil@x.example" }))).toThrow(/must not control delivery/);
    expect(() => parseBrowserFormPayload(normalizeLooseFormFields({ siteFormId: "site:x", name: "A", email: "", message: "m" }))).toThrow(/email/);
    expect(parseBrowserFormPayload(normalizeLooseFormFields({ siteFormId: "site:x", name: "A", phone: "07", message: "m" })).fields.phone).toBe("07");
  });

  it("puts phone and email in the delivered email body", () => {
    const text = composeLeadEmailText({ name: "Amina", email: "", phone: "0722", message: "Hi" });
    expect(text).toContain("Phone / WhatsApp: 0722");
    expect(text).not.toContain("Email:");
  });

  it("platform script is syntactically valid ES and prefills WhatsApp links", () => {
    expect(() => new Function(PLATFORM_SITE_SCRIPT)).not.toThrow();
    expect(PLATFORM_SITE_SCRIPT).toContain("wa.me/");
    expect(PLATFORM_SITE_SCRIPT).toContain("stopImmediatePropagation");
    // Escapes must survive the template literal (a stray "\s" becomes "s").
    expect(PLATFORM_SITE_SCRIPT).toContain("replace(/\\s+/g");
    expect(PLATFORM_SITE_SCRIPT).toContain("header .brand");
  });
});
