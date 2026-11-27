// Publish-safety checks on the admin-reviewed brief. The blocked phrases come
// from a real brief whose research notes shipped as website copy.

import { describe, expect, it } from "vitest";
import { findIntakePublishIssues } from "../src/domain/intake-checks";
import type { BusinessFacts } from "../src/domain/lifecycle-schema";
import { canonicalStructuredFacts } from "./helpers/canonical-facts";

function facts(overrides: Partial<BusinessFacts> = {}): BusinessFacts {
  return {
    businessName: "Garden Venue",
    contactEmail: "hello@venue.example",
    ...canonicalStructuredFacts(),
    ...overrides,
  };
}

function issuesFor(input: Partial<Parameters<typeof findIntakePublishIssues>[0]>) {
  return findIntakePublishIssues({ facts: facts(), submitterEmail: "someone@submitter.example", ...input });
}

describe("research notes and unconfirmed claims", () => {
  it.each([
    "Daily hours to confirm.",
    "To confirm with the owner.",
    "Hours: 8:00 am to 6:00 pm, daily (to confirm).",
    "Tents and decor setups. Seen in venue photos, to confirm what is offered.",
    "Garden design. Listed on an online directory only.",
    "Landscaping (UNCONFIRMED)",
    "Seen publicly: a serene garden setting.",
    "Listings show a garden venue.",
    "Open daily, a working assumption.",
    "Sources: Google listing, Instagram and Facebook pages.",
    "Pricing TBC.",
    "Services still to be confirmed with the owner.",
  ])("blocks %j in a business fact", (text) => {
    const issues = issuesFor({ facts: facts({ businessDescription: text }) });
    expect(issues.map((issue) => issue.path)).toContain("$.facts.businessDescription");
  });

  it.each([
    "Call us to confirm your booking date.",
    "We reply by email to confirm availability.",
    "Fresh produce from local sources.",
    "We publish a business directory for Ngong.",
    "Our listings showcase new homes every week.",
  ])("allows ordinary customer copy %j", (text) => {
    expect(issuesFor({ facts: facts({ businessDescription: text }) })).toEqual([]);
  });

  it("names the exact service carrying an unconfirmed marker", () => {
    const base = canonicalStructuredFacts().services;
    const issues = issuesFor({
      facts: facts({ services: [...base, { name: "Landscaping", description: "To confirm with the owner." }] }),
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("$.facts.services[3].description");
  });

  it("checks the differentiator, extra information and creative direction", () => {
    const issues = issuesFor({
      facts: facts({ competitiveDifferentiator: "To confirm with the owner.", extraInformation: "Draft is unconfirmed." }),
      creativeDirection: { direction: "Feature services still to be confirmed with the owner modestly." },
    });
    expect(issues.map((issue) => issue.path)).toEqual([
      "$.facts.competitiveDifferentiator",
      "$.facts.extraInformation",
      "$.creativeDirection.direction",
    ]);
  });
});

describe("hours written in free text", () => {
  it.each([
    "Open daily 8:00 am to 6:00 pm.",
    "Daily hours: listings put it at 8:00 am - 6:00 pm.",
    "We are open 8am to 6pm.",
    "Opening hours 08:00-18:00.",
    "Open 8 a.m. until 6 p.m. every day.",
  ])("blocks %j when it contradicts the structured hours", (text) => {
    const issues = issuesFor({ facts: facts({ businessDescription: text }) });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("business hours");
  });

  it.each([
    "Open weekdays 8:00 am to 5:00 pm.",
    "Opening hours 08:00-17:00, Saturday 9am to 1pm.",
    "We are open 8 to 5pm on weekdays.",
    "The breakfast picnic runs 7am to 10am.",
    "Open to groups of 10-15 guests.",
  ])("allows %j", (text) => {
    expect(issuesFor({ facts: facts({ businessDescription: text }) })).toEqual([]);
  });
});

describe("public contact email", () => {
  const same = { facts: facts({ contactEmail: "Owner@Venue.example" }), submitterEmail: " owner@venue.example " };

  it("blocks the submitter's address until the operator confirms it is public", () => {
    const issues = findIntakePublishIssues(same);
    expect(issues.map((issue) => issue.path)).toEqual(["$.facts.contactEmail"]);
  });

  it("allows it once confirmed", () => {
    expect(findIntakePublishIssues({ ...same, confirmPublicContactEmail: true })).toEqual([]);
  });
});
