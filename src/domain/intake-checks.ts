// Publish-safety checks on the admin-reviewed brief, run when a draft becomes a
// canonical submission. Everything in Business Facts and Creative Direction can
// surface as website copy, so research notes, unconfirmed claims, hours that
// contradict the structured hours and an unreviewed submitter address are all
// stopped here. Deterministic and phrase-based: it catches how uncertainty is
// usually written, not every possible way of writing it.

import { WEEKDAYS, type BusinessFacts, type SubmissionValidationIssue } from "./lifecycle-schema";
import type { CreativeDirection } from "./creative-direction";

export interface IntakePublishCheckInput {
  facts: BusinessFacts;
  creativeDirection?: CreativeDirection;
  submitterEmail: string;
  /** Operator confirmation that the submitter's address is also the business's public one. */
  confirmPublicContactEmail?: boolean;
}

// Narrow on purpose: "call us to confirm your booking" is ordinary copy.
const RESEARCH_NOTE_PATTERNS: readonly RegExp[] = [
  /\bunconfirmed\b/i,
  /\bnot (?:yet )?confirmed\b/i,
  /\(\s*to (?:be )?confirm(?:ed)?\b[^)]*\)/i,
  /\bto (?:be )?confirm(?:ed)?\s+(?:with (?:the )?(?:owner|client|business)\b|what\b)/i,
  /\b(?:hours|times|prices?|pricing|details|e-?mail|number|services?)\s+to (?:be )?confirm(?:ed)?(?=\s*(?:[.;,)]|$))/i,
  /^\s*to (?:be )?confirm(?:ed)?\b/i,
  /\bTB[CD]\b/i,
  /\bworking assumption\b/i,
  /\bseen (?:publicly\b|in [^.]{0,30}\bphotos?\b)/i,
  /\b(?:online directory|directory listing)\b/i,
  /\blistings? shows?\b/i,
  /(?:^|[.;]\s+)sources?:/i,
];

const HOURS_CONTEXT = /\b(?:hours?|open(?:s|ing)?|clos(?:e|es|ed|ing)|daily)\b/i;
const TIME_RANGE =
  /\b(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?\s*(?:to|until|till|-|–|—)\s*(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?(?![\d:])/gi;

function toMinutes(hour: number, minute: number, meridiem: string | undefined): number | null {
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    return ((hour % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0)) * 60 + minute;
  }
  return hour <= 23 ? hour * 60 + minute : null;
}

/** Time ranges in hours-related sentences that match no structured OPEN day. */
function contradictingHourRanges(text: string, facts: BusinessFacts): string[] {
  const open = new Set<string>();
  for (const day of WEEKDAYS) {
    const entry = facts.businessHours[day];
    if (entry.status === "OPEN") {
      const [openHour, openMinute] = entry.open.split(":").map(Number);
      const [closeHour, closeMinute] = entry.close.split(":").map(Number);
      open.add(`${openHour * 60 + openMinute}-${closeHour * 60 + closeMinute}`);
    }
  }

  const found: string[] = [];
  const normalized = text.replace(/\b([ap])\.\s?m\.?/gi, "$1m");
  for (const sentence of normalized.split(/(?<=[.!?])\s+(?=[A-Z])|\n+/)) {
    if (!HOURS_CONTEXT.test(sentence)) continue;
    for (const match of sentence.matchAll(TIME_RANGE)) {
      const [range, h1, m1, ap1, h2, m2, ap2] = match;
      // Without am/pm or two clock times this is a count ("10-15 guests").
      if (!ap1 && !ap2 && !(m1 && m2)) continue;
      // A bare side beside an am/pm side ("8 to 5pm") may mean either half-day.
      const sides = (hour: string, minute: string | undefined, meridiem: string | undefined, other: string | undefined) =>
        (meridiem ? [meridiem] : other && !minute ? ["am", "pm"] : [undefined]).map((value) =>
          toMinutes(Number(hour), Number(minute ?? 0), value)
        );
      const starts = sides(h1, m1, ap1, ap2).filter((value): value is number => value !== null);
      const ends = sides(h2, m2, ap2, ap1).filter((value): value is number => value !== null);
      if (starts.length === 0 || ends.length === 0) continue;
      if (!starts.some((start) => ends.some((end) => open.has(`${start}-${end}`)))) found.push(range.trim());
    }
  }
  return found;
}

function publicTexts(input: IntakePublishCheckInput): Array<{ path: string; text: string; isFact: boolean }> {
  const { facts, creativeDirection } = input;
  const entries: Array<{ path: string; text: string | undefined; isFact: boolean }> = [];
  const fact = (path: string, text: string | undefined) => entries.push({ path: `$.facts.${path}`, text, isFact: true });
  for (const key of ["businessName", "businessType", "businessDescription", "idealClientProfile", "addressLine1", "city"] as const) {
    fact(key, facts[key]);
  }
  fact("competitiveDifferentiator", facts.competitiveDifferentiator);
  fact("extraInformation", facts.extraInformation);
  facts.services.forEach((service, index) => {
    fact(`services[${index}].name`, service.name);
    fact(`services[${index}].description`, service.description);
  });
  for (const [key, value] of Object.entries(creativeDirection ?? {})) {
    entries.push({ path: `$.creativeDirection.${key}`, text: typeof value === "string" ? value : undefined, isFact: false });
  }
  return entries.filter((entry): entry is { path: string; text: string; isFact: boolean } => Boolean(entry.text));
}

export function findIntakePublishIssues(input: IntakePublishCheckInput): SubmissionValidationIssue[] {
  const issues: SubmissionValidationIssue[] = [];

  if (
    !input.confirmPublicContactEmail &&
    input.facts.contactEmail.trim().toLowerCase() === input.submitterEmail.trim().toLowerCase()
  ) {
    issues.push({
      path: "$.facts.contactEmail",
      message:
        "the public contact email is the submitter's private address and would be published. Change it, or confirm that it is the business's public email",
    });
  }

  for (const { path, text, isFact } of publicTexts(input)) {
    const note = RESEARCH_NOTE_PATTERNS.map((pattern) => pattern.exec(text)).find((match) => match !== null);
    if (note) {
      issues.push({
        path,
        message: `contains a research note or unconfirmed claim ("${note[0].replace(/^[.;]\s*/, "").trim()}"). Confirm it and reword, or remove it (put notes in the private admin notes)`,
      });
      continue;
    }
    if (!isFact) continue;
    const ranges = contradictingHourRanges(text, input.facts);
    if (ranges.length > 0) {
      issues.push({
        path,
        message: `states "${ranges[0]}", which matches no day in the structured business hours. Correct one of them, or remove the times from this text`,
      });
    }
  }

  return issues;
}
