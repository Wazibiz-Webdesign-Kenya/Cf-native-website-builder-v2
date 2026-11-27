// Deterministic web best practices applied at assembly time: canonical links,
// robots.txt, sitemap.xml, structured data and image loading attributes. These are facts the
// platform knows (the stable Site Address, the real image bytes), so code
// writes them instead of asking the Builder model to. Every transform is a pure
// string function and idempotent, so re-assembling assembled output is safe.

import type { ImageDimensions } from "../lib/image-dimensions";
import { WEEKDAYS, type BusinessFacts } from "./lifecycle-schema";

/** Public route of each page on the Site Address. */
const PAGE_ROUTES: Record<string, string> = { home: "/", about: "/about", services: "/services", contact: "/contact" };

/** `baseUrl` is the Site Address origin, without a trailing slash. */
export function canonicalUrl(baseUrl: string, pageId: string): string {
  return `${baseUrl}${PAGE_ROUTES[pageId] ?? `/${pageId}`}`;
}

const CANONICAL_TAG = /<link\b(?=[^>]*\srel\s*=\s*["']?canonical["'\s/>])[^>]*>/gi;

export function findCanonicalTags(html: string): string[] {
  return html.match(CANONICAL_TAG) ?? [];
}

/** Removes any Builder-written canonical (the model cannot know the address)
 *  and writes the platform's. With no address, none is left behind. */
export function applyCanonicalLink(html: string, href: string | null): string {
  const stripped = html.replace(CANONICAL_TAG, "");
  if (!href) return stripped;
  return stripped.replace(/<\/head>/i, (match) => `<link rel="canonical" href="${href}">${match}`);
}

export function buildRobotsTxt(baseUrl: string): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${baseUrl}/sitemap.xml\n`;
}

export function buildSitemapXml(baseUrl: string, pageIds: string[]): string {
  const entries = pageIds.map((pageId) => `  <url><loc>${canonicalUrl(baseUrl, pageId)}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

// ── Structured data ─────────────────────────────────────────────────────────

const JSON_LD_SCRIPT = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi;

/** What a visitor can see or follow: body text plus link targets. */
function publishedContent(pages: readonly string[]): string {
  return pages
    .map((html) => {
      const body = html.replace(/<(head|script|style)\b[\s\S]*?<\/\1>|<!--[\s\S]*?-->/gi, " ");
      const links = [...body.matchAll(/\shref\s*=\s*"((?:mailto|tel):[^"]*)"/gi)].map((match) => match[1]);
      return `${body.replace(/<[^>]+>/g, " ")} ${links.join(" ")}`;
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Matches on the last nine digits, so 0722 000 000 and +254722000000 agree. */
function showsPhone(content: string, phone: string): boolean {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return false;
  return content.replace(/(?<=\d)[\s().-]+(?=\d)/g, "").includes(digits.slice(-9));
}

/**
 * Describes the Business from its Facts only. Email, phone and street address
 * are published only when the pages already show them: a Fact can be supplied
 * for the platform (contactEmail receives enquiries) without being public.
 */
export function buildBusinessJsonLd(
  facts: BusinessFacts,
  options: { siteUrl: string | null; pages: readonly string[]; description?: string }
): Record<string, unknown> {
  const content = publishedContent(options.pages);
  const shows = (value: string) => content.includes(value.replace(/\s+/g, " ").trim().toLowerCase());

  const street = facts.addressLine1 && shows(facts.addressLine1) ? facts.addressLine1 : undefined;
  const address: Record<string, string> = {
    ...(street ? { streetAddress: street } : {}),
    ...(facts.city ? { addressLocality: facts.city } : {}),
    ...(facts.country ? { addressCountry: facts.country } : {}),
  };
  // Without a place this is not claimed to be a local business, and opening
  // hours do not apply to a bare Organization.
  const isLocal = Boolean(street || facts.city);
  const socials = Object.values(facts.socials ?? {}).filter(
    (value): value is string => typeof value === "string" && /^https?:\/\//i.test(value)
  );

  return {
    "@context": "https://schema.org",
    "@type": isLocal ? "LocalBusiness" : "Organization",
    name: facts.businessName,
    ...(options.siteUrl ? { url: canonicalUrl(options.siteUrl, "home") } : {}),
    ...(options.description ? { description: options.description } : {}),
    ...(facts.phoneNumber && showsPhone(content, facts.phoneNumber) ? { telephone: facts.phoneNumber } : {}),
    ...(shows(facts.contactEmail) ? { email: facts.contactEmail } : {}),
    ...(Object.keys(address).length > 0 ? { address: { "@type": "PostalAddress", ...address } } : {}),
    ...(socials.length > 0 ? { sameAs: socials } : {}),
    ...(isLocal
      ? {
          openingHoursSpecification: WEEKDAYS.flatMap((day) => {
            const hours = facts.businessHours?.[day];
            return hours?.status === "OPEN"
              ? [{ "@type": "OpeningHoursSpecification", dayOfWeek: `${day[0].toUpperCase()}${day.slice(1)}`, opens: hours.open, closes: hours.close }]
              : [];
          }),
        }
      : {}),
  };
}

/** Removes Builder-written JSON-LD (unverified claims) and writes `data`. */
export function applyJsonLd(html: string, data: Record<string, unknown> | null): string {
  const stripped = html.replace(JSON_LD_SCRIPT, "");
  if (!data) return stripped;
  // Escaping "<" keeps a Fact containing </script> inside the block.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return stripped.replace(/<\/head>/i, (match) => `<script type="application/ld+json">${json}</script>${match}`);
}

// ── Images ──────────────────────────────────────────────────────────────────

const SIZED_MARKER = "data-wz-sized";

// width/height attributes are presentational hints: unopposed, a stylesheet
// that sets only ONE side (a logo with `height:40px`) would get the other at
// intrinsic pixels and distort. This resets the hints to auto while the
// browser keeps the aspect ratio to reserve space. It is layered and has zero
// specificity, so every unlayered Builder rule still wins.
export const IMAGE_SIZING_CSS = `@layer wazibiz-base { :where(img[${SIZED_MARKER}]) { width: auto; height: auto; } }`;

const IMG_TAG = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

function hasAttribute(tag: string, name: string): boolean {
  // Blank quoted values first so text inside alt="..." cannot match.
  return new RegExp(`\\s${name}(?=[\\s=/>])`, "i").test(tag.replace(/"[^"]*"|'[^']*'/g, '""'));
}

function removeAttributeValue(tag: string, name: string, value: string): string {
  return tag.replace(new RegExp(`\\s${name}\\s*=\\s*(?:"${value}"|'${value}'|${value}(?=[\\s/>]))`, "gi"), "");
}

function addAttributes(tag: string, attributes: string[]): string {
  if (attributes.length === 0) return tag;
  return tag.replace(/\s*(\/?)>$/, (_, slash: string) => ` ${attributes.join(" ")}${slash ? " /" : ""}>`);
}

/** The opening hero region: from the hero-marked element to the next
 *  <section> (the same boundary the hero media gate uses). */
function heroRegion(html: string): { start: number; end: number } | null {
  const hero = /<(?:section|div|figure|header)\b[^>]*(?:class|id)="[^"]*hero[^"]*"[^>]*>/i.exec(html);
  if (!hero) return null;
  const next = html.indexOf("<section", hero.index + hero[0].length);
  return { start: hero.index, end: next === -1 ? html.length : next };
}

/**
 * Hero images load eagerly and the first one gets fetchpriority="high"; every
 * image outside the hero is lazy. A CSS-background hero has no hero <img>, so
 * nothing is promoted. `dimensionsBySrc` holds sizes sniffed from the real
 * bytes; unknown formats are simply left unsized.
 */
export function applyImageAttributes(
  html: string,
  dimensionsBySrc: ReadonlyMap<string, ImageDimensions>
): string {
  const hero = heroRegion(html);
  let heroLeadSeen = false;
  return html.replace(IMG_TAG, (original: string, offset: number) => {
    let tag = original;
    const attributes: string[] = [];
    const inHero = hero !== null && offset >= hero.start && offset < hero.end;
    const isHeroLead = inHero && !heroLeadSeen;
    if (isHeroLead) heroLeadSeen = true;

    if (inHero) tag = removeAttributeValue(tag, "loading", "lazy");
    if (isHeroLead) {
      tag = removeAttributeValue(tag, "fetchpriority", "(?:low|auto)");
      if (!hasAttribute(tag, "fetchpriority")) attributes.push('fetchpriority="high"');
    } else {
      // At most one promoted image per page.
      tag = removeAttributeValue(tag, "fetchpriority", "high");
    }
    if (!inHero && !hasAttribute(tag, "loading")) attributes.push('loading="lazy"');

    const src = /\ssrc\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
    const size = src ? dimensionsBySrc.get(src) : undefined;
    if (size && size.width > 0 && size.height > 0 && !hasAttribute(tag, "width") && !hasAttribute(tag, "height")) {
      attributes.push(`width="${size.width}"`, `height="${size.height}"`, SIZED_MARKER);
    }
    return addAttributes(tag, attributes);
  });
}
