import { describe, expect, it } from "vitest";
import {
  applyCanonicalLink,
  applyImageAttributes,
  applyJsonLd,
  buildBusinessJsonLd,
  buildRobotsTxt,
  buildSitemapXml,
  canonicalUrl,
  findCanonicalTags,
} from "../src/domain/web-standards";
import { canonicalStructuredFacts } from "./helpers/canonical-facts";

const BASE = "https://rift.wazibiz.co.ke";

describe("canonical, robots and sitemap", () => {
  it("replaces any Builder-written canonical with the platform's, idempotently", () => {
    const html = `<head><link href="https://invented.example/" rel="canonical" /></head>`;
    const once = applyCanonicalLink(html, canonicalUrl(BASE, "about"));
    expect(findCanonicalTags(once)).toEqual([`<link rel="canonical" href="${BASE}/about">`]);
    expect(applyCanonicalLink(once, canonicalUrl(BASE, "about"))).toBe(once);
  });

  it("leaves no canonical when the Site has no address, and keeps other links", () => {
    const html = `<head><link rel=canonical href="x"><link rel="stylesheet" href="site.css"></head>`;
    expect(applyCanonicalLink(html, null)).toBe(`<head><link rel="stylesheet" href="site.css"></head>`);
  });

  it("lists the public routes", () => {
    const sitemap = buildSitemapXml(BASE, ["home", "contact"]);
    expect(sitemap).toContain(`<loc>${BASE}/</loc>`);
    expect(sitemap).toContain(`<loc>${BASE}/contact</loc>`);
    expect(buildRobotsTxt(BASE)).toContain(`Sitemap: ${BASE}/sitemap.xml`);
  });
});

describe("structured data", () => {
  const facts = {
    businessName: "Rift Valley Roasters",
    contactEmail: "leads@rvr.example",
    phoneNumber: "0722 000 000",
    addressLine1: "12 Moi Avenue",
    city: "Nakuru",
    socials: { instagram: "https://instagram.com/rvr", other: "@rvr" },
    ...canonicalStructuredFacts(),
  };

  it("withholds contact details the pages do not show", () => {
    const data = buildBusinessJsonLd(facts, { siteUrl: BASE, pages: ["<body><p>Roasting.</p></body>"] });
    expect(data).not.toHaveProperty("email");
    expect(data).not.toHaveProperty("telephone");
    expect(data.address).toEqual({ "@type": "PostalAddress", addressLocality: "Nakuru" });
    expect(data.url).toBe(`${BASE}/`);
    expect(data.sameAs).toEqual(["https://instagram.com/rvr"]);
  });

  it("publishes contact details the pages show, in any phone format", () => {
    const data = buildBusinessJsonLd(facts, {
      siteUrl: BASE,
      pages: [`<body><a href="tel:+254722000000">Call</a><p>12 Moi Avenue</p><a href="mailto:leads@rvr.example">Email</a></body>`],
    });
    expect(data).toMatchObject({ "@type": "LocalBusiness", telephone: "0722 000 000", email: "leads@rvr.example" });
    expect(data.address).toMatchObject({ streetAddress: "12 Moi Avenue" });
  });

  it("reads HTML-encoded copy as the text a visitor sees", () => {
    const data = buildBusinessJsonLd(
      { ...facts, addressLine1: "Block A & B, Moi Avenue" },
      {
        siteUrl: BASE,
        pages: ["<body><p>Block A &amp; B, Moi Avenue</p></body>"],
        description: "Weddings &amp; picnics at the &#39;garden&#x27; &quot;gate&quot; &amp;lt;",
      }
    );
    expect(data.address).toMatchObject({ streetAddress: "Block A & B, Moi Avenue" });
    expect(data.description).toBe(`Weddings & picnics at the 'garden' "gate" &lt;`);
  });

  it("lists open days only", () => {
    const days = buildBusinessJsonLd(facts, { siteUrl: BASE, pages: [] }).openingHoursSpecification as Array<{ dayOfWeek: string }>;
    expect(days.map((day) => day.dayOfWeek)).toEqual(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]);
  });

  it("claims only an Organization, without hours, when there is no place", () => {
    const data = buildBusinessJsonLd({ ...facts, city: undefined, addressLine1: undefined }, { siteUrl: null, pages: [] });
    expect(data["@type"]).toBe("Organization");
    expect(data).not.toHaveProperty("openingHoursSpecification");
    expect(data).not.toHaveProperty("url");
  });

  it("replaces Builder-written JSON-LD, escapes markup and is idempotent", () => {
    const html = `<head><script type="application/ld+json">{"aggregateRating":5}</script></head>`;
    const once = applyJsonLd(html, { name: "</script><b>" });
    expect(once).not.toContain("aggregateRating");
    expect(once).not.toContain("<b>");
    expect(once.match(/<\/script>/g)).toHaveLength(1);
    expect(applyJsonLd(once, { name: "</script><b>" })).toBe(once);
    expect(applyJsonLd(html, null)).toBe("<head></head>");
  });
});

describe("image attributes", () => {
  const sizes = new Map([["a.webp", { width: 1600, height: 900 }]]);
  const html = [
    `<section class="hero">`,
    `<img src="a.webp" loading="lazy" alt="width= > height=">`,
    `<img src="a.webp" fetchpriority="high" alt="second">`,
    `</section>`,
    `<section><img src="a.webp" fetchpriority="high" alt="below" /><img src="b.webp" width="40" alt="logo"></section>`,
  ].join("");
  const result = applyImageAttributes(html, sizes);
  const [lead, second, below, logo] = result.match(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/g)!;

  it("promotes only the first hero image and never lazy-loads the hero", () => {
    expect(lead).toContain('fetchpriority="high"');
    expect(lead).not.toContain('loading="lazy"');
    expect(second).not.toContain("fetchpriority");
    expect(second).not.toContain("loading");
  });

  it("lazy-loads images outside the hero and strips extra promotions", () => {
    expect(below).toContain('loading="lazy"');
    expect(below).not.toContain("fetchpriority");
    expect(below).toMatch(/ \/>$/);
  });

  it("sizes from sniffed bytes and leaves authored or unknown sizes alone", () => {
    expect(lead).toContain('width="1600" height="900" data-wz-sized');
    expect(logo).toContain('width="40"');
    expect(logo).not.toContain("height=");
    expect(logo).not.toContain("data-wz-sized");
  });

  it("is idempotent", () => {
    expect(applyImageAttributes(result, sizes)).toBe(result);
  });

  it("promotes nothing when the page has no hero image", () => {
    expect(applyImageAttributes(`<section class="hero"></section><section><img src="a.webp"></section>`, sizes)).not.toContain("fetchpriority");
  });
});
