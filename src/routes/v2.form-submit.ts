import { Context } from "hono";
import type { Env } from "../env.d";
import { FormServiceError, acceptFormSubmission } from "../domain/form-service";

// Public browser endpoint of the central WAZIBIZ Form Service (issue #11).
//
// The browser sends only the public site/form identity plus visitor fields
// and an optional Turnstile token. Acceptance is answered ONLY after the
// platform has durably committed the Accepted Submission; Email Delivery is
// downstream with bounded server-side retry.
//
// Transport (2026-11-24 fix): generated sites post from another origin
// (https://{slug}.wazibiz.co.ke -> the Worker), so the endpoint must
//  - answer the CORS preflight,
//  - echo CORS headers (the Origin itself is still validated per Site in the
//    Form Service — the echo grants nothing the allowlist does not),
//  - accept JSON (script submit) AND urlencoded/multipart (plain HTML form
//    fallback when JavaScript is unavailable). A plain post gets a 303 back
//    to the page with ?form=sent|error instead of a raw JSON document.

function corsHeaders(origin: string | undefined): Record<string, string> {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
  };
}

export async function preflightForm(c: Context<{ Bindings: Env }>): Promise<Response> {
  const origin = c.req.header("Origin");
  if (!origin) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin),
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

/** Where a plain (non-script) form post should land afterwards: the page the
 *  visitor submitted from, only when it belongs to the validated Origin. */
function safeReturnUrl(c: Context, origin: string | undefined, outcome: "sent" | "error"): string | null {
  const referer = c.req.header("Referer");
  if (!origin || !referer) return null;
  try {
    const url = new URL(referer);
    if (url.origin !== origin) return null;
    url.searchParams.set("form", outcome);
    url.hash = "enquiry";
    return url.toString();
  } catch {
    return null;
  }
}

export async function submitForm(c: Context<{ Bindings: Env }>): Promise<Response> {
  const origin = c.req.header("Origin");
  const cors = corsHeaders(origin);
  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  const isPlainFormPost =
    contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data");

  let payload: unknown;
  try {
    if (isPlainFormPost) {
      const parsed = await c.req.parseBody();
      const flat: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(parsed)) {
        flat[key] = typeof value === "string" ? value : Array.isArray(value) ? value.filter((v) => typeof v === "string").join(", ") : undefined;
        if (flat[key] === undefined) delete flat[key];
      }
      payload = flat;
    } else {
      payload = await c.req.json();
    }
  } catch {
    return c.json({ error: { code: "BROWSER_PAYLOAD_CONTRACT", message: "Body must be JSON or a form post" } }, { status: 400, headers: cors });
  }

  try {
    const accepted = await acceptFormSubmission(c.env, {
      origin: origin ?? null,
      remoteAddress: c.req.header("CF-Connecting-IP") ?? null,
      payload,
    });
    if (isPlainFormPost) {
      const back = safeReturnUrl(c, origin, "sent");
      if (back) return new Response(null, { status: 303, headers: { ...cors, Location: back } });
    }
    return c.json({ accepted: true, submissionId: accepted.submissionId }, { status: 202, headers: cors });
  } catch (error) {
    if (error instanceof FormServiceError) {
      if (isPlainFormPost && error.code !== "ORIGIN_NOT_ALLOWED") {
        const back = safeReturnUrl(c, origin, "error");
        if (back) return new Response(null, { status: 303, headers: { ...cors, Location: back } });
      }
      return c.json({ error: { code: error.code, message: error.message } }, { status: error.status as 400 | 403 | 404 | 429, headers: cors });
    }
    throw error;
  }
}
